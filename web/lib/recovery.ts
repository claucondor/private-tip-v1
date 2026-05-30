/// Shielded-state recovery via on-chain snapshot self-tips.
///
/// Recovery model (v2 — snapshot semantics):
///   Every state-changing op (wrap, send, unwrap) records a single "snapshot"
///   self-tip: a ShieldedNote encrypted to the sender's OWN MemoKey pubkey via
///   a self-tip (PrivateTip.recordTip with sender === recipient === me).
///   The payload carries the ABSOLUTE post-action (balance, blinding) — not a
///   delta. These self-tips are invisible in the /tips UI but enable full state
///   reconstruction from any device with just a wallet signature.
///
/// Recovery algorithm:
///   1. Fetch all outgoing tips (getShieldedTipsBySenderWithMemo).
///   2. Fetch all incoming tips (getShieldedTipsByRecipientWithMemo).
///   3. Decrypt self-tips (sender === recipient === me) with own privkey.
///   4. Keep only notes with k="snapshot" — these are ABSOLUTE states.
///   5. Sort by timestamp, take the LATEST as the base state.
///   6. Add incoming tips from OTHERS that arrived AFTER the latest snapshot.
///   7. Compute Pedersen commitment of reconstructed (balance, blinding).
///   8. Compare against on-chain commitment — throw RecoveryDesyncError if mismatch.
///
/// Key correctness properties:
///   - Snapshots are idempotent: taking the latest one and ignoring earlier ones
///     is equivalent to replaying every delta (but far simpler).
///   - Incoming tips after the snapshot add to the base (they weren't included
///     in the snapshot because they arrived after it).
///   - Unwraps and sends are already baked into the next snapshot — no need to
///     track them separately.
///   - Zero-balance snapshots ARE emitted (newBalance=0 after full drain is a
///     valid state). This closes the bug where residuals at 0 were skipped.

"use client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveredShieldedState {
  balanceWei: bigint;
  blinding: bigint;
}

export class RecoveryDesyncError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RecoveryDesyncError";
  }
}

// ---------------------------------------------------------------------------
// Cadence tx: record a self-tip as a snapshot recovery note.
//
// Unlike a real tip there is NO JanusFlow.shieldedTransfer here — we just
// call PrivateTip.recordTip with sender === recipient === me, using a
// zero-length ciphertextRef dummy (just two zeros). The Cadence contract
// records the tip in both tipsByRecipient[me] and tipsBySender[me] and
// stores the encrypted note blob in MemoStore. That's all we need.
// ---------------------------------------------------------------------------

export const TX_RECORD_SELF_TIP = `
import PrivateTip from 0xb9ac529c14a4c5a1

/// Record a snapshot self-tip with an encrypted note.
///
/// Used by wrap, send, and unwrap flows to store the post-action absolute
/// (balance, blinding) encrypted to the sender's own MemoKey pubkey.
/// No value transfer — pure metadata for cross-device recovery.
///
/// ciphertextRef is [0, 0] (a dummy point). The actual shielded values are in
/// memoCiphertext.
transaction(
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256
) {
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        let dummyCiphertextRef: [UInt256] = [0, 0]
        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: self.signerRef.address,
            ciphertextRef: dummyCiphertextRef,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY
        )
        log("snapshot self-tip tipID=".concat(tipID.toString()))
    }
}
`;

// ---------------------------------------------------------------------------
// emitSnapshotSelfTip — submit TX_RECORD_SELF_TIP
// ---------------------------------------------------------------------------

/**
 * Encrypt the post-action absolute (balance, blinding) and submit it as a
 * snapshot self-tip on-chain.
 *
 * This REPLACES emitRecoverySelfTip. The payload always carries the FULL
 * post-action state, not a delta. The tag k="snapshot" distinguishes these
 * from legacy "wrap"/"residual" notes.
 *
 * ALWAYS emits — even when newBalance == 0. A zero-balance snapshot is a
 * valid state that prevents future recovery from misreading old pre-drain tips.
 *
 * @param newBalance  Total shielded balance in wei AFTER the action.
 * @param newBlinding Total blinding scalar AFTER the action.
 * @param myPubkey    Caller's own MemoKey pubkey (encrypt to themselves).
 */
export async function emitSnapshotSelfTip(opts: {
  newBalance: bigint;
  newBlinding: bigint;
  myPubkey: { x: bigint; y: bigint };
}): Promise<string> {
  const { newBalance, newBlinding, myPubkey } = opts;

  // Encrypt to our own pubkey via the server-side API route.
  const encRes = await fetch("/api/note/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: newBalance.toString(),
      blinding: newBlinding.toString(),
      data: JSON.stringify({ k: "snapshot" }),
      recipientPubkey: { x: myPubkey.x.toString(), y: myPubkey.y.toString() },
    }),
  });
  if (!encRes.ok) {
    const err = await encRes.json().catch(() => ({ error: encRes.statusText }));
    throw new Error(`emitSnapshotSelfTip: encrypt failed — ${err.error ?? encRes.statusText}`);
  }
  const encData = await encRes.json();
  const memoCiphertext: number[] = encData.ciphertext;
  const memoEphPubkeyX: bigint = BigInt(encData.ephemeralPubkey.x);
  const memoEphPubkeyY: bigint = BigInt(encData.ephemeralPubkey.y);

  const fcl = await import("@onflow/fcl");
  const txId = await fcl.mutate({
    cadence: TX_RECORD_SELF_TIP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(
        memoCiphertext.map((b) => b.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt8)
      ),
      arg(memoEphPubkeyX.toString(), t.UInt256),
      arg(memoEphPubkeyY.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 500,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
}

// ---------------------------------------------------------------------------
// Script helpers to fetch tips from chain
// ---------------------------------------------------------------------------

const PRIVATE_TIP_ADDR = "0xb9ac529c14a4c5a1";

export function buildGetShieldedTipsBySenderWithMemoScript(): string {
  return `
    import PrivateTip from ${PRIVATE_TIP_ADDR}
    access(all) fun main(sender: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsBySenderWithMemo(sender: sender)
    }
  `;
}

export function buildGetShieldedTipsByRecipientWithMemoScript(): string {
  return `
    import PrivateTip from ${PRIVATE_TIP_ADDR}
    access(all) fun main(recipient: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsByRecipientWithMemo(recipient: recipient)
    }
  `;
}

// ---------------------------------------------------------------------------
// Pedersen commitment reader — reads user's commitment from JanusFlow EVM proxy
// ---------------------------------------------------------------------------

const JANUS_FLOW_EVM_PROXY = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;

// commitments(address) returns (uint256 x, uint256 y)
const COMMITMENTS_ABI = [
  "function commitments(address) view returns (uint256 x, uint256 y)",
];

async function readOnChainCommitment(
  coaEvmHex: string
): Promise<{ x: bigint; y: bigint }> {
  const { JsonRpcProvider, Contract } = await import("ethers");
  const provider = new JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  const contract = new Contract(JANUS_FLOW_EVM_PROXY, COMMITMENTS_ABI, provider);
  const result = await contract.commitments(coaEvmHex) as { x: bigint; y: bigint };
  return { x: BigInt(result.x), y: BigInt(result.y) };
}

// ---------------------------------------------------------------------------
// computeCommitment — server-side Pedersen via /api/proof/commit
// ---------------------------------------------------------------------------

async function computeCommitment(
  balance: bigint,
  blinding: bigint
): Promise<{ x: bigint; y: bigint }> {
  const res = await fetch("/api/proof/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: balance.toString(),
      blinding: blinding.toString(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`computeCommitment: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return { x: BigInt(data.x), y: BigInt(data.y) };
}

// ---------------------------------------------------------------------------
// recoverShieldedStateFromChain
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

interface SnapshotEntry {
  timestamp: bigint;
  balance: bigint;
  blinding: bigint;
}

/**
 * Reconstruct shielded state from chain using snapshot semantics.
 *
 * Algorithm:
 *   1. Fetch all sent and received tips.
 *   2. Decrypt self-tips (sender === recipient === me) — keep k="snapshot" notes.
 *      These are ABSOLUTE post-action states, not deltas.
 *   3. Take the LATEST snapshot as the base state.
 *   4. Add incoming tips from others that arrived AFTER the latest snapshot
 *      (they haven't been baked into any snapshot yet).
 *   5. CRITICAL: compute Pedersen commitment of reconstructed (balance, blinding)
 *      and compare against on-chain commitment. Throw RecoveryDesyncError if mismatch.
 *
 * @param myFlowAddr     Caller's Flow address.
 * @param myMemoPrivkey  Caller's MemoKey privkey (BabyJub scalar).
 * @param myCoaEvmHex    Caller's COA EVM hex address (for on-chain commitment read).
 * @returns Reconstructed balance and blinding, or null if no snapshots + no incoming tips.
 * @throws RecoveryDesyncError if reconstructed commitment doesn't match on-chain.
 */
export async function recoverShieldedStateFromChain(
  myFlowAddr: string,
  myMemoPrivkey: bigint,
  myCoaEvmHex?: string
): Promise<RecoveredShieldedState | null> {
  const fcl = await import("@onflow/fcl");
  const myAddrLower = myFlowAddr.toLowerCase();

  // Fetch sent and received tips in parallel.
  const [sentRaw, receivedRaw] = await Promise.all([
    fcl.query({
      cadence: buildGetShieldedTipsBySenderWithMemoScript(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [arg(myFlowAddr, t.Address)],
    }) as Promise<CadenceTipWithMemo[]>,
    fcl.query({
      cadence: buildGetShieldedTipsByRecipientWithMemoScript(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [arg(myFlowAddr, t.Address)],
    }) as Promise<CadenceTipWithMemo[]>,
  ]);

  // --- Step 1: decrypt self-tips → find all snapshots ---

  // De-dup by tipID (self-tips appear in both sent and received lists).
  const decryptedById = new Map<string, {
    isSelf: boolean;
    isIncoming: boolean;
    timestamp: bigint;
    amount: bigint;
    blinding: bigint;
    tag: string | null;
  }>();

  const tryDecryptTip = async (tip: CadenceTipWithMemo): Promise<void> => {
    const id = String(tip.tipID);
    if (decryptedById.has(id)) return;

    if (!tip.memo) return;

    const isSelf =
      tip.sender.toLowerCase() === myAddrLower &&
      tip.recipient.toLowerCase() === myAddrLower;
    const isIncoming =
      tip.recipient.toLowerCase() === myAddrLower &&
      tip.sender.toLowerCase() !== myAddrLower;

    // We only care about self-tips (snapshots) and incoming from others.
    if (!isSelf && !isIncoming) return;

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
      if (!decRes.ok) return; // auth tag mismatch → not our note → skip

      const decData = await decRes.json();

      let tag: string | null = null;
      if (decData.data) {
        try {
          const parsed = JSON.parse(decData.data as string) as { k?: string };
          tag = parsed.k ?? null;
        } catch {
          // Not JSON tag — treat as no tag.
        }
      }

      decryptedById.set(id, {
        isSelf,
        isIncoming,
        timestamp: BigInt(tip.timestamp),
        amount: BigInt(decData.amount),
        blinding: BigInt(decData.blinding),
        tag,
      });
    } catch {
      // Decrypt error — skip gracefully.
    }
  };

  const allTips = [...sentRaw, ...receivedRaw];
  await Promise.allSettled(allTips.map(tryDecryptTip));

  // --- Step 2: collect snapshots and incoming tips ---

  const snapshots: SnapshotEntry[] = [];
  const incomingTips: Array<{ timestamp: bigint; amount: bigint; blinding: bigint }> = [];

  for (const entry of decryptedById.values()) {
    if (entry.isSelf && entry.tag === "snapshot") {
      snapshots.push({
        timestamp: entry.timestamp,
        balance: entry.amount,
        blinding: entry.blinding,
      });
    } else if (entry.isIncoming) {
      incomingTips.push({
        timestamp: entry.timestamp,
        amount: entry.amount,
        blinding: entry.blinding,
      });
    }
  }

  // --- Step 3: take the latest snapshot as base state ---

  snapshots.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const latestSnapshot: SnapshotEntry | null =
    snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  const baseTimestamp = latestSnapshot?.timestamp ?? 0n;
  let balanceWei = latestSnapshot?.balance ?? 0n;
  let blinding = latestSnapshot?.blinding ?? 0n;

  // --- Step 4: add incoming tips that arrived AFTER the latest snapshot ---

  for (const tip of incomingTips) {
    if (tip.timestamp > baseTimestamp) {
      balanceWei += tip.amount;
      blinding += tip.blinding;
    }
  }

  // If we found nothing at all, return null (no recoverable state).
  if (latestSnapshot === null && incomingTips.filter(t => t.timestamp > baseTimestamp).length === 0) {
    return null;
  }

  // --- Step 5: CRITICAL — validate against on-chain Pedersen commitment ---
  //
  // If the reconstructed (balance, blinding) doesn't match the on-chain commitment
  // the user MUST NOT write this to localStorage — unwrap will revert with a
  // Groth16 proof failure. Fail loudly with RecoveryDesyncError instead.

  let coaHex = myCoaEvmHex;
  if (!coaHex) {
    // Resolve COA on-chain if not provided.
    const { getCoaEvmAddress } = await import("@/lib/tip-actions");
    coaHex = await getCoaEvmAddress(myFlowAddr);
  }

  const [reconstructed, onChain] = await Promise.all([
    computeCommitment(balanceWei, blinding),
    readOnChainCommitment(coaHex),
  ]);

  if (reconstructed.x !== onChain.x || reconstructed.y !== onChain.y) {
    throw new RecoveryDesyncError(
      `Cannot reconstruct shielded state. ` +
      `Chain commitment ${onChain.x.toString(16).slice(0, 12)}... ` +
      `does not match reconstructed ${reconstructed.x.toString(16).slice(0, 12)}... ` +
      `Likely cause: wallet has wraps/sends/unwraps from before recovery was enabled, ` +
      `or the wallet performed operations from another device without emitting snapshots.`
    );
  }

  return { balanceWei, blinding };
}
