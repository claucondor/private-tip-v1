/// Global Zustand store for PrivateTip application state.
///
/// v0.8: ShieldedTokenState is now checkpoint-backed (from ShieldedCheckpointClient.readAndDecrypt).
/// localStorage shielded-state helpers are removed — state lives in Zustand + on-chain checkpoint.

import { create } from "zustand";
import type { TokenId } from "./tokens";

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

/**
 * Shielded state for a single token — sourced from ShieldedCheckpointClient.readAndDecrypt().
 * This replaces the v0.7 localStorage-based schema.
 */
export interface ShieldedTokenState {
  balanceRaw: string;           // bigint as string, from SnapshotContent.balance
  blinding: string;             // bigint as string, from SnapshotContent.blinding
  checkpointVersion: string;    // from CheckpointMetadata.version
  lastUpdatedBlock: string;     // from CheckpointMetadata.lastUpdatedBlock
  inboxPendingCount: number;    // from ShieldedInboxClient.count()
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

// localStorage shielded-state helpers (loadShieldedState, saveShieldedState, clearShieldedStateForAddr,
// loadAllShieldedStates, sweepStaleShieldedCache, proxyFingerprint, shieldedKey) were removed in v0.8.
// State is now checkpoint-backed: use ShieldedCheckpointClient.readAndDecrypt() to rehidrate
// from on-chain, and store the result in the Zustand shieldedBalances map.
