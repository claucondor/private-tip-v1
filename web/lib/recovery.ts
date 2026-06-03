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

import { sdk } from "@claucondor/sdk";
import type { SnapshotContent } from "@claucondor/sdk";
import type { TokenId } from "./tokens";

export type { SnapshotContent };

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
    return await adapter.latestSnapshot(addr, memoPrivkey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // No snapshots yet → return null (fresh slot).
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
