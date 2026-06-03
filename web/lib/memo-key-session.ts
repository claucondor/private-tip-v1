/// Session-scoped MemoKey privkey cache.
///
/// Privkey is derived from the wallet signature once per browser session
/// and held in sessionStorage. Cleared when the tab closes — the user
/// re-signs to recover in the next session. Trade-off: sessionStorage gives
/// us "no disk persistence of the secret" without forcing a popup on every
/// navigation; the cost is one signature per session.

const SESSION_PREFIX = "openjanus:memo-privkey-session:";

function key(addr: string): string {
  return `${SESSION_PREFIX}${addr.toLowerCase()}`;
}

export function getCachedMemoPrivkey(addr: string): bigint | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(key(addr));
  return raw ? BigInt(raw) : null;
}

export function cacheMemoPrivkey(addr: string, privkey: bigint): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(key(addr), privkey.toString());
}

export function clearMemoPrivkeyCache(addr: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(key(addr));
}
