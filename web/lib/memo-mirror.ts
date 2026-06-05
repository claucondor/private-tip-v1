/// Sender-side memo mirror.
///
/// On-chain memos are ECIES-encrypted to the recipient's MemoKey pubkey, so
/// the sender cannot decrypt them after the fact. To let the sender see their
/// own outgoing memos in /tips, we persist the plaintext locally (per-sender,
/// in localStorage) at send time and look it up when rendering "Sent" cards.
///
/// Match strategy: tipID assigned by PrivateTip.recordTip is a sequence we
/// don't capture client-side, so we join on (recipient, timestamp ± window).
/// On-chain timestamps come from Cadence block time (Unix seconds), which
/// lands within a few seconds of the user's local clock.

import { TOKEN_REGISTRY } from "@claucondor/sdk/network";
import { loadShieldedState, saveShieldedState } from "./store";
import type { TokenId } from "./tokens";

const MIRROR_KEY_PREFIX = "openjanus:memo-mirror:";
const MATCH_WINDOW_SEC = 120;

export interface SentMemoEntry {
  recipient: string;   // Flow address, lowercased
  memo: string;
  sentAtMs: number;    // Date.now() at send time
}

function key(sender: string): string {
  return `${MIRROR_KEY_PREFIX}${sender.toLowerCase()}`;
}

function load(sender: string): SentMemoEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key(sender));
    return raw ? (JSON.parse(raw) as SentMemoEntry[]) : [];
  } catch {
    return [];
  }
}

function save(sender: string, entries: SentMemoEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key(sender), JSON.stringify(entries));
}

/** Persist a plaintext memo so the sender can recall it later. */
export function saveSentMemo(opts: {
  sender: string;
  recipient: string;
  memo: string;
  sentAtMs?: number;
}): void {
  if (!opts.memo) return;
  const entries = load(opts.sender);
  entries.push({
    recipient: opts.recipient.toLowerCase(),
    memo: opts.memo,
    sentAtMs: opts.sentAtMs ?? Date.now(),
  });
  save(opts.sender, entries);
}

/**
 * Look up a previously-saved memo for a Sent tip. Joins on recipient and a
 * timestamp window around the on-chain timestamp (which lives in seconds).
 * Returns the closest-matching entry's memo, or null if no match.
 */
export function findSentMemo(opts: {
  sender: string;
  recipient: string;
  onChainTimestampSec: number;
}): string | null {
  const entries = load(opts.sender);
  const recip = opts.recipient.toLowerCase();
  const targetMs = opts.onChainTimestampSec * 1000;
  let best: { entry: SentMemoEntry; deltaMs: number } | null = null;
  for (const e of entries) {
    if (e.recipient !== recip) continue;
    const delta = Math.abs(e.sentAtMs - targetMs);
    if (delta > MATCH_WINDOW_SEC * 1000) continue;
    if (!best || delta < best.deltaMs) {
      best = { entry: e, deltaMs: delta };
    }
  }
  return best ? best.entry.memo : null;
}

/** Wipe local memo mirror for a sender (testing / privacy reset). */
export function clearSentMemos(sender: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key(sender));
}

// ─── Recipient-side decrypted memo cache ────────────────────────────────────
//
// Decryption (ECIES + AES-GCM) is non-trivial; we run it once per tipID and
// stash the plaintext locally so re-renders, refreshes, and tab switches are
// instant. Cache is per-recipient and per-tipID.

const DECRYPT_CACHE_PREFIX = "openjanus:memo-decrypt:";

function decryptCacheKey(recipient: string): string {
  return `${DECRYPT_CACHE_PREFIX}${recipient.toLowerCase()}`;
}

function loadDecryptCache(recipient: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(decryptCacheKey(recipient));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveDecryptCache(
  recipient: string,
  cache: Record<string, string>
): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(decryptCacheKey(recipient), JSON.stringify(cache));
}

export function getCachedDecryptedMemo(
  recipient: string,
  tipID: number | string
): string | null {
  const cache = loadDecryptCache(recipient);
  return cache[String(tipID)] ?? null;
}

export function cacheDecryptedMemo(
  recipient: string,
  tipID: number | string,
  plaintext: string
): void {
  const cache = loadDecryptCache(recipient);
  cache[String(tipID)] = plaintext;
  saveDecryptCache(recipient, cache);
}

// ─── Shielded state auto-ingest from decrypted notes ────────────────────────
//
// When a recipient successfully decrypts a tip's ShieldedNote they get
// `(amount, blinding)` — the values they need to keep their local shielded
// state consistent with the on-chain Pedersen commitment. We accumulate them
// here in localStorage (same key shape as /send and /wrap), tracking which
// tipIDs have already been ingested so multiple renders don't double-count.
//
// Key format: the store module writes keys in v2 format:
//   openjanus:shielded:v2:<addr>:<tokenId>:<proxyFingerprint>
// sweepStaleShieldedCache() deletes any openjanus:shielded: key that does NOT
// match v2 format. ingestTipIfNew delegates to the store helpers so the key
// written here always survives the sweep.

const INGESTED_PREFIX = "openjanus:tip-ingested:";

function ingestedKey(addr: string): string {
  return `${INGESTED_PREFIX}${addr.toLowerCase()}`;
}

function loadIngestedSet(addr: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(ingestedKey(addr));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}
function saveIngestedSet(addr: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ingestedKey(addr), JSON.stringify([...set]));
}

/**
 * Migrate a v1 shielded key (openjanus:shielded:<addr>) to v2 format if it
 * exists. Called on first read so users upgrading from a session where tips
 * were ingested with the old key shape don't lose their state. The v1 key is
 * deleted after a successful migration.
 *
 * Tips are always for FLOW (the only token supported by PrivateTip), so we
 * migrate under tokenId="flow".
 */
function migrateV1ShieldedKeyIfPresent(addr: string): void {
  if (typeof window === "undefined") return;
  const v1Key = `openjanus:shielded:${addr.toLowerCase()}`;
  const raw = localStorage.getItem(v1Key);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { balanceWei?: string; balanceRaw?: string; blinding?: string };
    const balanceRaw = parsed.balanceRaw ?? parsed.balanceWei ?? "0";
    const blinding = parsed.blinding ?? "0";
    // Reconstruct the v2 key. We need proxyFingerprint for "flow".
    // TOKEN_REGISTRY is imported at top of file (static ESM import).
    const flowEntry = TOKEN_REGISTRY["flow"] as { proxy?: string; cadenceAddress?: string; variant?: string } | undefined;
    if (!flowEntry) return; // Safety guard.
    const fingerprint =
      flowEntry.variant === "cadence-ft"
        ? (flowEntry.cadenceAddress ?? "unknown").toLowerCase()
        : (flowEntry.proxy ?? "unknown").toLowerCase();
    const v2Key = `openjanus:shielded:v2:${addr.toLowerCase()}:flow:${fingerprint}`;
    // Only write if v2 key doesn't already exist (avoid clobbering a newer value).
    if (!localStorage.getItem(v2Key)) {
      localStorage.setItem(
        v2Key,
        JSON.stringify({ balanceRaw, blinding, lastUpdatedMs: Date.now() })
      );
    }
    localStorage.removeItem(v1Key);
  } catch {
    // Non-fatal: migration failed, leave v1 key untouched so the user still
    // sees their balance via the legacy-key check in client-layout.tsx.
  }
}

/**
 * If this tipID hasn't been ingested yet, add (amount, blinding) into the
 * recipient's local shielded state and remember the tipID. Writes to the v2
 * key format (via store.ts saveShieldedState) so the entry survives the
 * sweepStaleShieldedCache() call on every app mount.
 *
 * tokenId defaults to "flow" — PrivateTip currently only supports FLOW tips.
 * Pass a different tokenId if tip support is extended to other tokens.
 *
 * Returns whether ingestion happened (true) or was skipped as duplicate (false).
 */
export function ingestTipIfNew(opts: {
  recipient: string;
  tipID: number | string;
  amount: bigint;
  blinding: bigint;
  tokenId?: TokenId;
}): boolean {
  const tipKey = String(opts.tipID);
  const tokenId: TokenId = opts.tokenId ?? "flow";

  // Migrate any v1 key before checking state.
  migrateV1ShieldedKeyIfPresent(opts.recipient);

  const ingested = loadIngestedSet(opts.recipient);
  if (ingested.has(tipKey)) return false;

  // Delegate to the store helpers (loadShieldedState / saveShieldedState are
  // imported at the top of this file via static ESM import). This ensures the
  // written key is always in v2 format and survives sweepStaleShieldedCache().
  const current = loadShieldedState(opts.recipient, tokenId) ?? {
    balanceRaw: "0",
    blinding: "0",
  };
  const newBalance = BigInt(current.balanceRaw) + opts.amount;
  const newBlinding = BigInt(current.blinding) + opts.blinding;
  saveShieldedState(opts.recipient, tokenId, {
    balanceRaw: newBalance.toString(),
    blinding: newBlinding.toString(),
    lastUpdatedMs: Date.now(),
  });

  ingested.add(tipKey);
  saveIngestedSet(opts.recipient, ingested);
  return true;
}
