/// Shielded-state recovery via on-chain snapshot events (v0.6.5 SDK).
///
/// Recovery model (v0.6.5):
///   Each adapter exposes latestSnapshot(addr, memoPrivKey) which scans all
///   *WithSnapshot events for the given address, decrypts each one, and returns
///   the most recent valid SnapshotContent. The SDK handles all pagination,
///   decryption, and sorting internally.
///
/// Migration note:
///   v0.5.x accounts that only have v0.5.x snapshot events will not be
///   readable by the v0.6 scanner (different contract addresses). Those
///   accounts should re-wrap from scratch on v0.6 contracts.

"use client";

import { sdk, decryptNote, decryptShieldedNote } from "@claucondor/sdk";
import type { SnapshotContent } from "@claucondor/sdk";
import type { TokenId } from "./tokens";

export type { SnapshotContent };

const BABYJUB_SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const BLINDING_FIELD_MAX = 2n ** 252n;

/**
 * Reconstruct the latest shielded state for a given token from on-chain events.
 *
 * Delegates to sdk.token(id).latestSnapshot(addr, memoPrivKey) which:
 *   1. Scans *WithSnapshot events for the user's address.
 *   2. Decrypts each blob with the user's MemoKey privkey.
 *   3. Returns the most recent valid SnapshotContent (balance, blinding, timestampMs).
 *
 * Returns null if no recoverable snapshots exist (fresh account or no v0.6
 * activity on this token yet). Throws on decryption errors.
 *
 * @param addr          User's address (COA EVM hex for native/erc20; Cadence addr for mockft).
 * @param memoPrivkey   User's MemoKey BabyJub privkey scalar.
 * @param tokenId       Token to recover state for.
 */
export async function recoverShieldedState(
  addr: string,
  memoPrivkey: bigint,
  tokenId: TokenId
): Promise<SnapshotContent | null> {
  try {
    const adapter = sdk.token(tokenId);
    const snapshot = await adapter.latestSnapshot(addr, memoPrivkey);
    if (!snapshot) return null;

    // HOT FIX: latestSnapshot only returns the most recent own-snapshot (wrap/transfer/unwrap).
    // It does NOT sum incoming notes received since that snapshot. We do that here so the
    // local balance matches the on-chain Pedersen commit and proofs don't fail with C_old mismatch.
    let balance = BigInt(snapshot.balance);
    let blinding = BigInt(snapshot.blinding) % BLINDING_FIELD_MAX;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incoming: any[] = await (adapter as any).scanIncomingNotes(addr);
      const isCadenceFt = tokenId === "mockft";
      const decoder = isCadenceFt ? decryptShieldedNote : decryptNote;
      for (const note of incoming) {
        const decoded = await decoder(note.ciphertext, note.ephPubkey, memoPrivkey).catch(() => null);
        if (!decoded) continue;
        balance += decoded.amount;
        blinding = (blinding + decoded.blinding) % BLINDING_FIELD_MAX;
      }
    } catch (e) {
      // scanIncomingNotes failed (Cadence REST API slow / rate-limited); fall back to snapshot only.
      console.warn(`[recovery] scanIncomingNotes failed for ${tokenId}, using snapshot only:`, e);
    }

    return {
      ...snapshot,
      balance,
      blinding,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no snapshot") || msg.includes("empty") || msg.includes("length")) {
      return null;
    }
    throw err;
  }
}

/**
 * Reconstruct shielded state for all supported tokens in parallel.
 * Returns a map of tokenId → SnapshotContent | null.
 */
export async function recoverAllTokenStates(
  addr: string,
  memoPrivkey: bigint,
  tokenIds: TokenId[]
): Promise<Record<TokenId, SnapshotContent | null>> {
  const results = await Promise.allSettled(
    tokenIds.map(async (id) => ({
      id,
      snapshot: await recoverShieldedState(addr, memoPrivkey, id),
    }))
  );

  const out = {} as Record<TokenId, SnapshotContent | null>;
  for (const r of results) {
    if (r.status === "fulfilled") {
      out[r.value.id] = r.value.snapshot;
    } else {
      // On error, treat as null (unknown state).
      console.warn("[recovery] failed to recover state:", r.reason);
    }
  }
  return out;
}
