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
// here in sessionStorage (same key shape as /send and /wrap), tracking which
// tipIDs have already been ingested so multiple renders don't double-count.

const INGESTED_PREFIX = "openjanus:tip-ingested:";
const SHIELDED_PREFIX = "openjanus:shielded:";

function ingestedKey(addr: string): string {
  return `${INGESTED_PREFIX}${addr.toLowerCase()}`;
}
function shieldedKey(addr: string): string {
  return `${SHIELDED_PREFIX}${addr.toLowerCase()}`;
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

interface ShieldedState {
  balanceWei: string;
  blinding: string;
}
function loadShieldedState(addr: string): ShieldedState | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(shieldedKey(addr));
  return raw ? (JSON.parse(raw) as ShieldedState) : null;
}
function saveShieldedState(addr: string, state: ShieldedState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(shieldedKey(addr), JSON.stringify(state));
}

/**
 * If this tipID hasn't been ingested yet, add (amount, blinding) into the
 * recipient's local shielded state and remember the tipID. Returns whether
 * ingestion happened (true) or was skipped as duplicate (false).
 */
export function ingestTipIfNew(opts: {
  recipient: string;
  tipID: number | string;
  amount: bigint;
  blinding: bigint;
}): boolean {
  const key = String(opts.tipID);
  const ingested = loadIngestedSet(opts.recipient);
  if (ingested.has(key)) return false;

  const current = loadShieldedState(opts.recipient) ?? {
    balanceWei: "0",
    blinding: "0",
  };
  const newBalance = BigInt(current.balanceWei) + opts.amount;
  const newBlinding = BigInt(current.blinding) + opts.blinding;
  saveShieldedState(opts.recipient, {
    balanceWei: newBalance.toString(),
    blinding: newBlinding.toString(),
  });

  ingested.add(key);
  saveIngestedSet(opts.recipient, ingested);
  return true;
}
