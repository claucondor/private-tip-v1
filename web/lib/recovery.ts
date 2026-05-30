/// Shielded-state recovery via on-chain snapshot events (v0.5.2+).
///
/// Recovery model (v0.5.2 — inline snapshot semantics):
///   Every state-changing op (wrap, send, unwrap) embeds a snapshot in the
///   EVM event itself: wrap/shieldedTransfer/unwrap now emit *WithSnapshot events
///   whose `encryptedSnapshot` field carries the ABSOLUTE post-action
///   (balance, blinding) encrypted to the actor's own MemoKey pubkey.
///
///   This replaces the old "self-tip" pattern where a second Cadence tx was
///   submitted after each action. There is no longer a TX_RECORD_SELF_TIP.
///
/// Recovery algorithm (delegated to @openjanus/sdk recovery module):
///   1. Scan JanusFlow *WithSnapshot events for the user's COA address.
///   2. Decrypt each snapshot with the user's MemoKey privkey.
///   3. Fetch incoming PrivateTip tips (for the recipient delta since last snap).
///   4. Read the on-chain commitment and validate via Pedersen commitment check.
///   5. Throw RecoveryDesyncError if the reconstructed state doesn't match.
///
/// Migration note:
///   Pre-v0.5.2 accounts that used the old self-tip pattern will have no
///   *WithSnapshot events. Recovery will return null for those accounts
///   (no snapshots to reconstruct from). The operator must admin-reset the
///   slot and re-wrap from scratch. See v0_5_2-reset-txs.json.

"use client";

import { recovery } from "@openjanus/sdk";
import {
  type RecoveredShieldedState,
  RecoveryDesyncError,
  type Snapshot,
} from "@openjanus/sdk/recovery";
import { ethers } from "ethers";

export { RecoveryDesyncError };
export type { RecoveredShieldedState };

// Re-export snapshot helpers for use in wrap/send/claim pages.
// encryptSnapshotToSelf: encrypt (balance, blinding) to own MemoKey pubkey.
// decryptSnapshot: decrypt a raw snapshot blob from a *WithSnapshot event.
// validatePedersenCommit: client-side Pedersen check for bidirectional sync detection.
export const encryptSnapshotToSelf = recovery.encryptSnapshotToSelf;
export const decryptSnapshot = recovery.decryptSnapshot;
export const validatePedersenCommit = recovery.validatePedersenCommit;

const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const JANUS_FLOW_EVM = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

/**
 * Reconstruct shielded state from chain using the v0.5.2 inline-snapshot model.
 *
 * Delegates to @openjanus/sdk recovery module which:
 *   1. Scans WrapWithSnapshot / ShieldedTransferWithSnapshot / UnwrapWithSnapshot events.
 *   2. Decrypts each with myMemoPrivkey.
 *   3. Takes the latest as absolute base state.
 *   4. Validates reconstructed commitment against on-chain storage.
 *
 * Returns null if no recoverable snapshots exist (e.g. fresh account or
 * account with only pre-v0.5.2 activity — those need a slot reset + re-wrap).
 * Throws RecoveryDesyncError if reconstructed state doesn't match chain.
 *
 * @param myFlowAddr      Caller's Flow address (used for incoming tip lookup).
 * @param myCoaEvmAddr    Caller's COA EVM hex address.
 * @param myMemoPrivkey   Caller's MemoKey BabyJub privkey scalar.
 */
export async function recoverShieldedStateFromChain(
  myFlowAddr: string,
  myCoaEvmAddr: string,
  myMemoPrivkey: bigint
): Promise<RecoveredShieldedState | null> {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);

  // 1. Scan EVM *WithSnapshot events.
  const rawSnapshots = await recovery.scanJanusFlowSnapshots(
    myCoaEvmAddr,
    provider,
    { janusFlowAddr: JANUS_FLOW_EVM }
  );

  if (rawSnapshots.length === 0) {
    // No snapshot events at all. Check if the chain even has a commitment;
    // if it does, this is a pre-v0.5.2 account that can't be auto-recovered.
    const onChainCommit = await recovery.readJanusFlowCommitment(
      myCoaEvmAddr,
      provider,
      JANUS_FLOW_EVM
    );
    if (onChainCommit.x === 0n && onChainCommit.y === 1n) {
      return null; // Clean empty slot — nothing to do.
    }
    // Chain has a commitment but zero snapshot events → pre-v0.5.2 activity.
    // Cannot reconstruct automatically. Admin slot reset required.
    throw new RecoveryDesyncError(
      "On-chain commitment exists but no v0.5.2 snapshot events found. " +
      "This account has pre-v0.5.2 activity. Ask admin to reset the slot, " +
      "then re-wrap from scratch."
    );
  }

  // 2. Decrypt each snapshot blob.
  const snapshots: Snapshot[] = [];
  for (const raw of rawSnapshots) {
    const decoded = await recovery.decryptSnapshot(
      raw.ciphertext,
      raw.ephPubkey,
      myMemoPrivkey
    );
    if (decoded) {
      snapshots.push({
        balance: decoded.balance,
        blinding: decoded.blinding,
        timestamp: raw.timestamp,
        txHash: raw.txHash,
      });
    }
  }

  // 3. Fetch incoming PrivateTip tips that may have arrived after the last snapshot.
  const incomingDeltas = await fetchAndDecryptIncomingTips(
    myFlowAddr,
    myMemoPrivkey
  );

  // 4. Read on-chain commitment for validation.
  const onChainCommit = await recovery.readJanusFlowCommitment(
    myCoaEvmAddr,
    provider,
    JANUS_FLOW_EVM
  );

  // 5. Reconstruct + validate (throws RecoveryDesyncError on mismatch).
  if (snapshots.length === 0 && incomingDeltas.length === 0) {
    // We scanned events but couldn't decrypt any — all belong to other keys.
    if (onChainCommit.x === 0n && onChainCommit.y === 1n) {
      return null;
    }
    throw new RecoveryDesyncError(
      "Found snapshot events but none decrypted with the current MemoKey. " +
      "The MemoKey may have been rotated. Try re-deriving via setup."
    );
  }

  return await recovery.reconstructFromSnapshots({
    snapshots,
    incomingDeltas,
    onChainCommit,
  });
}

// ---------------------------------------------------------------------------
// Internal: fetch + decrypt incoming tips (PrivateTip-specific).
// Returns { amount, blinding, timestamp } for each tip where sender !== me
// that arrived AFTER the latest snapshot (the SDK handles the filtering
// inside reconstructFromSnapshots).
// ---------------------------------------------------------------------------

interface CadenceTipWithMemo {
  tipID: string;
  sender: string;
  recipient: string;
  timestamp: string;
  memo: {
    ciphertext: number[];
    ephPubkeyX: string;
    ephPubkeyY: string;
  } | null;
}

async function fetchAndDecryptIncomingTips(
  myFlowAddr: string,
  myMemoPrivkey: bigint
): Promise<Array<{ amount: bigint; blinding: bigint; timestamp: number }>> {
  const results: Array<{ amount: bigint; blinding: bigint; timestamp: number }> = [];
  try {
    const fcl = await import("@onflow/fcl");
    const PRIVATE_TIP_ADDR = "0xb9ac529c14a4c5a1";
    const myAddrLower = myFlowAddr.toLowerCase();

    const script = `
      import PrivateTip from ${PRIVATE_TIP_ADDR}
      access(all) fun main(recipient: Address): [PrivateTip.TipMetadataWithMemo] {
        return PrivateTip.getShieldedTipsByRecipientWithMemo(recipient: recipient)
      }
    `;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tips = await fcl.query({
      cadence: script,
      args: (arg: any, t: any) => [arg(myFlowAddr, t.Address)],
    }) as CadenceTipWithMemo[];

    for (const tip of tips) {
      // Only incoming from others (not self-tips — those are old snapshots
      // from the pre-v0.5.2 pattern; we skip them here since v0.5.2 uses EVM events).
      if (
        tip.sender.toLowerCase() === myAddrLower ||
        !tip.memo
      ) continue;

      try {
        const decRes = await fetch("/api/note/decrypt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ciphertext: tip.memo.ciphertext,
            ephemeralPubkey: {
              x: tip.memo.ephPubkeyX,
              y: tip.memo.ephPubkeyY,
            },
            privkey: myMemoPrivkey.toString(),
          }),
        });
        if (!decRes.ok) continue; // Not our note → skip.

        const decData = await decRes.json();
        results.push({
          amount: BigInt(decData.amount),
          blinding: BigInt(decData.blinding),
          timestamp: Number(tip.timestamp),
        });
      } catch {
        // Decrypt error → skip.
      }
    }
  } catch {
    // Non-fatal: if PrivateTip lookup fails, recovery still works from snapshots.
  }
  return results;
}
