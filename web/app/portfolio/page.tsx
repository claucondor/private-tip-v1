"use client";

/// Portfolio page — v0.6 multi-token shielded balance overview.
///
/// Shows all 4 tokens (FLOW, WFLOW, mUSDC, MockFT) for the connected user:
///   - Token icon + name
///   - Public underlying balance (wallet balance)
///   - Shielded balance (from localStorage / on-chain scan)
///   - Quick actions: Wrap / Send / Withdraw

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import {
  Shield,
  Loader2,
  ArrowRight,
  Lock,
  Wallet,
  RefreshCw,
  AlertTriangle,
  Key,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { SUPPORTED_TOKENS, type TokenId, formatTokenAmount } from "@/lib/tokens";
import {
  getCoaEvmAddress,
  getOrDeriveMemoPrivkey,
  getRecipientMemoPubkey,
} from "@/lib/tip-actions";
import { sdk, TOKEN_REGISTRY, getFlowVaultBalanceWei } from "@claucondor/sdk";
import {
  loadShieldedState,
  type ShieldedTokenState,
} from "@/lib/store";
import { recoverShieldedState } from "@/lib/recovery";
import { TokenBadge } from "@/components/TokenSelector";

const EASE = [0.22, 1, 0.36, 1] as const;

interface TokenPortfolioRow {
  tokenId: TokenId;
  publicBalance: bigint | null;
  shieldedState: ShieldedTokenState | null;
  loading: boolean;
  error: string | null;
}

const initialRows = (): TokenPortfolioRow[] =>
  SUPPORTED_TOKENS.map((t) => ({
    tokenId: t.id,
    publicBalance: null,
    shieldedState: null,
    loading: false,
    error: null,
  }));

type PortfolioPageState =
  | "loading"          // initial load
  | "needs_wallet"     // wallet not connected
  | "needs_activation" // wallet connected, no memokey on chain
  | "needs_unlock"     // wallet connected, memokey on chain, no session privkey
  | "ready";           // everything available

export default function PortfolioPage() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [rows, setRows] = useState<TokenPortfolioRow[]>(initialRows());
  const [loadingAll, setLoadingAll] = useState(false);
  const [coaAddr, setCoaAddr] = useState<string | null>(null);

  // Page-level state machine
  const [pageState, setPageState] = useState<PortfolioPageState>("loading");
  const [unlocking, setUnlocking] = useState(false);

  // Update a single row.
  const setRow = useCallback(
    (tokenId: TokenId, partial: Partial<TokenPortfolioRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.tokenId === tokenId ? { ...r, ...partial } : r))
      );
    },
    []
  );

  // Load from localStorage cache first.
  useEffect(() => {
    if (!userAddress) return;
    const updated = initialRows().map((r) => ({
      ...r,
      shieldedState: loadShieldedState(userAddress, r.tokenId),
    }));
    setRows(updated);
  }, [userAddress]);

  // Determine page state: needs_wallet / needs_activation / needs_unlock / ready
  useEffect(() => {
    if (!isLoggedIn || !userAddress) {
      setPageState("needs_wallet");
      return;
    }
    let cancelled = false;
    (async () => {
      setPageState("loading");
      try {
        const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
        const sessionKey = getCachedMemoPrivkey(userAddress);
        if (sessionKey !== null) {
          if (!cancelled) setPageState("ready");
          return;
        }
        // No session key — check on-chain
        const onChainPub = await getRecipientMemoPubkey(userAddress).catch(() => null);
        if (cancelled) return;
        if (onChainPub === null) {
          setPageState("needs_activation");
        } else {
          setPageState("needs_unlock");
        }
      } catch {
        // Fall through to ready — don't block portfolio on check failure
        if (!cancelled) setPageState("ready");
      }
    })();
    return () => { cancelled = true; };
  }, [isLoggedIn, userAddress]);

  const handleUnlock = useCallback(async () => {
    if (!userAddress) return;
    setUnlocking(true);
    try {
      await getOrDeriveMemoPrivkey(userAddress);
      toast.success("Private inbox unlocked");
      setPageState("ready");
    } catch (err) {
      toast.error("Unlock failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUnlocking(false);
    }
  }, [userAddress]);

  // Fetch public balances for all tokens.
  const fetchPublicBalances = useCallback(async (addr: string, coa: string) => {
    for (const t of SUPPORTED_TOKENS) {
      setRow(t.id, { loading: true });
      try {
        const entry = TOKEN_REGISTRY[t.id];
        let bal: bigint;
        if (entry.variant === "native") {
          // FLOW lives in the Cadence vault, not the EVM COA balance.
          bal = await getFlowVaultBalanceWei(addr);
        } else if (entry.variant === "erc20") {
          // ERC20 balance held by the COA on EVM.
          bal = await sdk.token(t.id).getBalance(coa);
        } else {
          // cadence-ft: JanusFTAdapter.getBalance reads the Cadence FT vault.
          bal = await sdk.token(t.id).getBalance(addr);
        }
        setRow(t.id, { publicBalance: bal, loading: false });
      } catch (err) {
        console.error(`[portfolio] fetchPublicBalances failed for ${t.id}:`, err);
        const msg = err instanceof Error ? err.message : "Failed";
        setRow(t.id, { loading: false, error: msg });
      }
    }
  }, [setRow]);

  // Scan on-chain snapshots for fresh shielded state.
  const refreshShieldedState = useCallback(async (addr: string, coa: string) => {
    if (!userAddress) return;
    let memoPrivkey: bigint;
    try {
      memoPrivkey = await getOrDeriveMemoPrivkey(userAddress);
    } catch {
      toast.error("Wallet signature required to decrypt shielded balances");
      return;
    }

    for (const t of SUPPORTED_TOKENS) {
      setRow(t.id, { loading: true });
      try {
        const entry = TOKEN_REGISTRY[t.id];
        const queryAddr = entry.variant === "cadence-ft" ? addr : coa;
        const snap = await recoverShieldedState(queryAddr, memoPrivkey, t.id);
        if (snap) {
          const state: ShieldedTokenState = {
            balanceRaw: snap.balance.toString(),
            blinding: snap.blinding.toString(),
            lastUpdatedMs: snap.timestampMs,
          };
          setRow(t.id, { shieldedState: state, loading: false });
          // Also persist to localStorage.
          const { saveShieldedState } = await import("@/lib/store");
          saveShieldedState(userAddress, t.id, state);
        } else {
          setRow(t.id, { shieldedState: null, loading: false });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Scan failed";
        setRow(t.id, { loading: false, error: msg });
      }
    }
  }, [userAddress, setRow]);

  // Load everything on connect. Deliberately omits `loadingAll` from deps —
  // it's set INSIDE load() and would create a re-entry loop where the
  // cleanup function cancels the in-flight load before balances populate.
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    async function load() {
      setLoadingAll(true);
      try {
        console.log("[portfolio] load start", { userAddress });
        const coa = await getCoaEvmAddress(userAddress!);
        console.log("[portfolio] coa resolved", { coa });
        if (cancelled) return;
        setCoaAddr(coa);
        await fetchPublicBalances(userAddress!, coa);
        console.log("[portfolio] fetchPublicBalances done");
      } catch (err) {
        console.error("[portfolio] load failed:", err);
        toast.error("Failed to load portfolio", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!cancelled) setLoadingAll(false);
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, fetchPublicBalances]);

  const handleRefresh = useCallback(async () => {
    if (!userAddress || !coaAddr) return;
    setLoadingAll(true);
    await Promise.all([
      fetchPublicBalances(userAddress, coaAddr),
      refreshShieldedState(userAddress, coaAddr),
    ]);
    setLoadingAll(false);
    toast.success("Portfolio refreshed");
  }, [userAddress, coaAddr, fetchPublicBalances, refreshShieldedState]);

  // --- State machine renders ---

  if (pageState === "needs_wallet" || (!isLoggedIn && pageState === "loading")) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
            <Shield className="w-3 h-3" />
            Portfolio
          </div>
          <h1 className="text-4xl font-bold tracking-tight" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Your Private Portfolio
          </h1>
          <p className="mt-2 text-foreground/70">Connect to see your shielded balances across all 4 tokens.</p>
        </div>
        <div className="flex flex-col items-center py-12">
          <motion.button
            onClick={() => authenticate()}
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
            className="janus-button-primary px-6 py-3 rounded-xl text-base"
          >
            Connect Wallet
          </motion.button>
        </div>
      </div>
    );
  }

  if (pageState === "loading") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 flex flex-col items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-[#00EF8B]/50 mb-4" />
        <p className="text-sm text-foreground/40">Checking your account…</p>
      </div>
    );
  }

  if (pageState === "needs_activation") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
            <Shield className="w-3 h-3" />
            Portfolio
          </div>
          <h1 className="text-4xl font-bold tracking-tight" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Private Portfolio
          </h1>
        </div>
        <div className="rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/5 p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/12 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
            <Key className="w-7 h-7 text-[#D4AF37]" />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Activate your account first
          </h2>
          <p className="text-sm text-foreground/60 mb-6 max-w-sm mx-auto">
            Your account hasn&apos;t published a MemoKey yet. Activate to enable
            shielded balances and private tips.
          </p>
          <Link
            href="/status"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-[#D4AF37]/50 bg-[#D4AF37]/10 text-amber-200 font-medium hover:bg-[#D4AF37]/20 transition-colors"
          >
            Activate your account
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    );
  }

  if (pageState === "needs_unlock") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
            <Shield className="w-3 h-3" />
            Portfolio
          </div>
          <h1 className="text-4xl font-bold tracking-tight" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Private Portfolio
          </h1>
        </div>
        <div className="rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/5 p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/12 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
            <Lock className="w-7 h-7 text-[#D4AF37]" />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Unlock your private balances
          </h2>
          <p className="text-sm text-foreground/60 mb-2 max-w-sm mx-auto">
            Your private key is not in session memory — it was cleared when you closed the tab.
          </p>
          <p className="text-xs text-foreground/40 mb-6 max-w-sm mx-auto">
            One wallet signature re-derives the <strong className="text-foreground/60">same key</strong> from
            your wallet — deterministic, not a new key. Your public key stays on-chain permanently.
          </p>
          <motion.button
            onClick={handleUnlock}
            disabled={unlocking}
            whileHover={!unlocking ? { scale: 1.02, y: -1 } : {}}
            whileTap={{ scale: 0.98 }}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-[#D4AF37]/50 bg-[#D4AF37]/10 text-amber-200 font-medium hover:bg-[#D4AF37]/20 transition-colors disabled:opacity-50"
          >
            {unlocking ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for wallet signature…</>
            ) : (
              <><Key className="w-4 h-4" /> Unlock with wallet signature (1 click)</>
            )}
          </motion.button>
        </div>
      </div>
    );
  }

  // pageState === "ready" — fall through to main portfolio UI

  const totalShieldedDisplay = rows.reduce((acc, r) => {
    if (!r.shieldedState) return acc;
    return acc + BigInt(r.shieldedState.balanceRaw);
  }, 0n);

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
          <Shield className="w-3 h-3" />
          Portfolio
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold tracking-tight" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Private Portfolio
          </h1>
          <motion.button
            onClick={handleRefresh}
            disabled={loadingAll}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 text-xs text-foreground/70 hover:bg-white/10 disabled:opacity-40"
          >
            {loadingAll ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </motion.button>
        </div>
        <p className="mt-2 text-foreground/70">
          Tip privately in FLOW, USDC, or any supported token.
        </p>
        {coaAddr && (
          <p className="mt-1 text-[10px] font-mono text-foreground/30">
            COA: {coaAddr.slice(0, 10)}…{coaAddr.slice(-6)}
          </p>
        )}
      </div>

      {/* Token grid */}
      <div className="space-y-3">
        {rows.map((row, idx) => {
          const token = SUPPORTED_TOKENS.find((t) => t.id === row.tokenId)!;
          const hasShielded = !!row.shieldedState;
          const shieldedBal = hasShielded ? BigInt(row.shieldedState!.balanceRaw) : null;

          return (
            <motion.div
              key={row.tokenId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE, delay: idx * 0.05 }}
              className="rounded-xl border border-white/10 bg-[#0A1628]/60 p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <TokenBadge id={row.tokenId} />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{token.label}</p>
                    <p className="text-[10px] text-foreground/40">
                      {(() => {
                        const entry = TOKEN_REGISTRY[row.tokenId];
                        switch (entry.variant) {
                          case "native":     return `Native FLOW (Cadence) · ${token.decimals} decimals`;
                          case "erc20":      return `ERC20 (EVM) · ${token.decimals} decimals`;
                          case "cadence-ft": return `Cadence FT · ${token.decimals} decimals`;
                          default:           return `${token.decimals} decimals`;
                        }
                      })()}
                    </p>
                  </div>
                </div>
                {row.loading && <Loader2 className="w-4 h-4 animate-spin text-foreground/30" />}
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                {/* Public balance */}
                <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2">
                  <div className="flex items-center gap-1 mb-1">
                    <Wallet className="w-3 h-3 text-foreground/40" />
                    <span className="text-[10px] text-foreground/40 uppercase tracking-wide">Wallet</span>
                  </div>
                  {row.publicBalance !== null ? (
                    <p className="text-sm font-mono text-foreground">
                      {formatTokenAmount(row.publicBalance, row.tokenId, 4)} {token.symbol}
                    </p>
                  ) : (
                    <p className="text-sm font-mono text-foreground/30">—</p>
                  )}
                </div>

                {/* Shielded balance */}
                <div className="rounded-lg border border-[#00EF8B]/15 bg-[#00EF8B]/5 px-3 py-2">
                  <div className="flex items-center gap-1 mb-1">
                    <Lock className="w-3 h-3 text-[#00EF8B]/60" />
                    <span className="text-[10px] text-[#00EF8B]/60 uppercase tracking-wide">Shielded</span>
                  </div>
                  {hasShielded && shieldedBal !== null ? (
                    <p className="text-sm font-mono text-[#00EF8B]">
                      {formatTokenAmount(shieldedBal, row.tokenId, 4)} {token.symbol}
                    </p>
                  ) : (
                    <p className="text-sm font-mono text-foreground/30">0.0000</p>
                  )}
                </div>
              </div>

              {row.error && (
                <div className="mb-3 flex items-center gap-2 text-[10px] text-amber-400/70">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {row.error}
                </div>
              )}

              {/* Quick actions */}
              <div className="flex gap-2">
                <Link
                  href={`/wrap?token=${row.tokenId}`}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-white/12 bg-white/4 text-xs text-foreground/70 hover:bg-white/8 transition-colors"
                >
                  Wrap
                  <ArrowRight className="w-3 h-3" />
                </Link>
                <Link
                  href={`/send?token=${row.tokenId}`}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#6B46C1]/25 bg-[#6B46C1]/8 text-xs text-[#6B46C1] hover:bg-[#6B46C1]/15 transition-colors"
                >
                  Send
                  <ArrowRight className="w-3 h-3" />
                </Link>
                {hasShielded && (
                  <Link
                    href={`/claim?token=${row.tokenId}`}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#00EF8B]/20 bg-[#00EF8B]/6 text-xs text-[#00EF8B] hover:bg-[#00EF8B]/12 transition-colors"
                  >
                    Claim
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-8 text-[10px] text-foreground/30 text-center">
        Shielded balances are encrypted on-chain. Only you can decrypt them with your MemoKey.
      </div>
    </div>
  );
}
