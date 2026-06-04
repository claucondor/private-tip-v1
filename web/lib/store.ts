/// Global Zustand store for PrivateTip application state.
///
/// v0.6: Extended with multi-token shielded balance support.

import { create } from "zustand";
import { TOKEN_REGISTRY } from "@claucondor/sdk";
import type { TokenId } from "./tokens";
import { SUPPORTED_TOKENS } from "./tokens";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TipInfo {
  tipID: number;
  sender: string;
  recipient: string;
  timestamp: string;
  memo: string | null;
  claimed: boolean;
  tokenId?: TokenId;
}

export interface WalletState {
  address: string | null;
  authenticated: boolean;
  coaEVMAddrHex: string | null;
}

export interface BalanceState {
  flow: string | null;            // UFix64 string eg "100.0"
  encryptedBalance: string | null; // display only
}

/** Shielded state for a single token (balance + blinding). */
export interface ShieldedTokenState {
  balanceRaw: string;   // raw bigint as string (in token's native units)
  blinding: string;     // blinding scalar as decimal string
  lastUpdatedMs?: number;
}

/** Map of tokenId → shielded state. */
export type MultiTokenShieldedState = Partial<Record<TokenId, ShieldedTokenState>>;

export interface TipsState {
  sent: TipInfo[];
  received: TipInfo[];
  totalSentCount: number;
  totalReceivedCount: number;
  loading: boolean;
}

export interface PubkeyState {
  x: string | null;
  y: string | null;
  registered: boolean;
  registering: boolean;
}

// ─── Store Interface ───────────────────────────────────────────────────────

export interface AppState {
  // Wallet
  wallet: WalletState;
  setWallet: (wallet: Partial<WalletState>) => void;
  clearWallet: () => void;

  // Balances (underlying)
  balance: BalanceState;
  setBalance: (balance: Partial<BalanceState>) => void;

  // Multi-token shielded balances
  shieldedBalances: MultiTokenShieldedState;
  setShieldedBalance: (tokenId: TokenId, state: ShieldedTokenState | null) => void;
  getShieldedBalance: (tokenId: TokenId) => ShieldedTokenState | null;
  clearShieldedBalances: () => void;

  // Tips
  tips: TipsState;
  setSentTips: (tips: TipInfo[]) => void;
  setReceivedTips: (tips: TipInfo[]) => void;
  addSentTip: (tip: TipInfo) => void;
  addReceivedTip: (tip: TipInfo) => void;
  markTipClaimed: (tipID: number) => void;
  setTipsLoading: (loading: boolean) => void;

  // Pubkey
  pubkey: PubkeyState;
  setPubkey: (pubkey: Partial<PubkeyState>) => void;
  setRegistering: (registering: boolean) => void;

  // Selected token (persisted across pages via store)
  selectedTokenId: TokenId;
  setSelectedTokenId: (id: TokenId) => void;
}

// ─── Initial State Helpers ──────────────────────────────────────────────────

const initialWallet: WalletState = {
  address: null,
  authenticated: false,
  coaEVMAddrHex: null,
};

const initialBalance: BalanceState = {
  flow: null,
  encryptedBalance: null,
};

const initialTips: TipsState = {
  sent: [],
  received: [],
  totalSentCount: 0,
  totalReceivedCount: 0,
  loading: false,
};

const initialPubkey: PubkeyState = {
  x: null,
  y: null,
  registered: false,
  registering: false,
};

// ─── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => ({
  // Wallet
  wallet: { ...initialWallet },
  setWallet: (partial) =>
    set((state) => ({
      wallet: { ...state.wallet, ...partial },
    })),
  clearWallet: () =>
    set({
      wallet: { ...initialWallet },
      balance: { ...initialBalance },
      tips: { ...initialTips },
      pubkey: { ...initialPubkey },
      shieldedBalances: {},
    }),

  // Balances
  balance: { ...initialBalance },
  setBalance: (partial) =>
    set((state) => ({
      balance: { ...state.balance, ...partial },
    })),

  // Multi-token shielded balances
  shieldedBalances: {},
  setShieldedBalance: (tokenId, tokenState) =>
    set((state) => ({
      shieldedBalances: {
        ...state.shieldedBalances,
        [tokenId]: tokenState ?? undefined,
      },
    })),
  getShieldedBalance: (tokenId) => get().shieldedBalances[tokenId] ?? null,
  clearShieldedBalances: () => set({ shieldedBalances: {} }),

  // Tips
  tips: { ...initialTips },
  setSentTips: (tips) =>
    set((state) => ({
      tips: {
        ...state.tips,
        sent: tips,
        totalSentCount: tips.length,
      },
    })),
  setReceivedTips: (tips) =>
    set((state) => ({
      tips: {
        ...state.tips,
        received: tips,
        totalReceivedCount: tips.length,
      },
    })),
  addSentTip: (tip) =>
    set((state) => ({
      tips: {
        ...state.tips,
        sent: [tip, ...state.tips.sent],
        totalSentCount: state.tips.totalSentCount + 1,
      },
    })),
  addReceivedTip: (tip) =>
    set((state) => ({
      tips: {
        ...state.tips,
        received: [tip, ...state.tips.received],
        totalReceivedCount: state.tips.totalReceivedCount + 1,
        loading: false,
      },
    })),
  markTipClaimed: (tipID) =>
    set((state) => ({
      tips: {
        ...state.tips,
        received: state.tips.received.map((t) =>
          t.tipID === tipID ? { ...t, claimed: true } : t
        ),
      },
    })),
  setTipsLoading: (loading) =>
    set((state) => ({
      tips: { ...state.tips, loading },
    })),

  // Pubkey
  pubkey: { ...initialPubkey },
  setPubkey: (partial) =>
    set((state) => ({
      pubkey: { ...state.pubkey, ...partial },
    })),
  setRegistering: (registering) =>
    set((state) => ({
      pubkey: { ...state.pubkey, registering },
    })),

  // Selected token
  selectedTokenId: "flow",
  setSelectedTokenId: (id) => set({ selectedTokenId: id }),
}));

// ─── localStorage shielded state helpers (per-token, per-address, per-proxy) ──

/**
 * Returns the on-chain identity of a token's deployed contract.
 * For EVM variants this is the proxy address. For Cadence FT it is the
 * Cadence contract address. Used as a fingerprint in cache keys so that
 * a contract redeploy automatically orphans the old entries.
 */
function proxyFingerprint(tokenId: TokenId): string {
  const entry = TOKEN_REGISTRY[tokenId as keyof typeof TOKEN_REGISTRY];
  if (!entry) return "unknown";
  if (entry.variant === "cadence-ft") return entry.cadenceAddress.toLowerCase();
  return entry.proxy.toLowerCase();
}

/**
 * Cache key includes the proxy fingerprint. When a contract is redeployed
 * at a new address, lookups against this key miss, triggering a fresh
 * on-chain scan instead of showing stale state from the abandoned proxy.
 */
function shieldedKey(addr: string, tokenId: TokenId): string {
  return `openjanus:shielded:v2:${addr.toLowerCase()}:${tokenId}:${proxyFingerprint(tokenId)}`;
}

export function loadShieldedState(
  addr: string,
  tokenId: TokenId
): ShieldedTokenState | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(shieldedKey(addr, tokenId));
  return raw ? (JSON.parse(raw) as ShieldedTokenState) : null;
}

export function saveShieldedState(
  addr: string,
  tokenId: TokenId,
  state: ShieldedTokenState
): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(shieldedKey(addr, tokenId), JSON.stringify(state));
}

export function clearShieldedStateForAddr(addr: string): void {
  if (typeof window === "undefined") return;
  for (const t of SUPPORTED_TOKENS) {
    localStorage.removeItem(shieldedKey(addr, t.id));
  }
}

/** Load all shielded states for an address into a map. */
export function loadAllShieldedStates(addr: string): MultiTokenShieldedState {
  const result: MultiTokenShieldedState = {};
  for (const t of SUPPORTED_TOKENS) {
    const s = loadShieldedState(addr, t.id);
    if (s) result[t.id] = s;
  }
  return result;
}

/**
 * Sweep orphaned cache entries from prior contract deployments or schema
 * versions. Safe to call on every app mount — only removes entries that
 * do not match the current TOKEN_REGISTRY fingerprints.
 *
 * Removes:
 *   - Pre-v2 entries (no proxy fingerprint in key)
 *   - Entries whose fingerprint does not match the currently deployed proxy
 *   - Entries for unknown token ids
 */
export function sweepStaleShieldedCache(): number {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  const validFingerprints = new Map<string, string>();
  for (const t of SUPPORTED_TOKENS) {
    validFingerprints.set(t.id, proxyFingerprint(t.id));
  }
  const toDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("openjanus:shielded:")) continue;
    // v2 format: openjanus:shielded:v2:<addr>:<tokenId>:<fingerprint>
    const parts = key.split(":");
    if (parts.length !== 6 || parts[2] !== "v2") {
      toDelete.push(key);
      continue;
    }
    const tokenId = parts[4] as TokenId;
    const fingerprintInKey = parts[5];
    const expected = validFingerprints.get(tokenId);
    if (!expected || expected !== fingerprintInKey) toDelete.push(key);
  }
  for (const key of toDelete) {
    localStorage.removeItem(key);
    removed++;
  }
  return removed;
}
