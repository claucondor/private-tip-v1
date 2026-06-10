/// Sender-side memo mirror (v0.8).
///
/// On-chain memos are ECIES-encrypted to the recipient's MemoKey pubkey, so
/// the sender cannot decrypt them after the fact. To let the sender see their
/// own outgoing memos in /tips, we persist the plaintext locally (per-sender,
/// in localStorage) at send time and look it up when rendering "Sent" cards.
///
/// Match strategy: join on (recipient, timestamp ± window). On-chain timestamps
/// come from Cadence block time (Unix seconds), which lands within a few seconds
/// of the user's local clock.
///
/// Removed in v0.8 (replaced by ShieldedInboxClient.drainAndDecrypt):
///   - ingestTipIfNew — accumulation now done by drainAndDecrypt + checkpoint
///   - cacheDecryptedMemo / getCachedDecryptedMemo — keyed by tipID which is
///     app-specific and not part of the v0.8 protocol
///   - loadIngestedSet / saveIngestedSet — backed ingestTipIfNew

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
