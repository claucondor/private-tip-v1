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
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { SUPPORTED_TOKENS, type TokenId, formatTokenAmount } from "@/lib/tokens";
import {
  getCoaEvmAddress,
  getOrDeriveMemoPrivkey,
} from "@/lib/tip-actions";
import { sdk } from "@claucondor/sdk";
import { TOKEN_REGISTRY } from "@claucondor/sdk/network";
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

export default function PortfolioPage() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [rows, setRows] = useState<TokenPortfolioRow[]>(initialRows());
  const [loadingAll, setLoadingAll] = useState(false);
  const [coaAddr, setCoaAddr] = useState<string | null>(null);

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

  // Fetch public balances for all tokens.
  const fetchPublicBalances = useCallback(async (addr: string, coa: string) => {
    for (const t of SUPPORTED_TOKENS) {
      setRow(t.id, { loading: true });
      try {
        const adapter = sdk.token(t.id);
        const entry = TOKEN_REGISTRY[t.id];
        // EVM tokens: use COA for getBalance (ERC20 balance of the wallet's EVM addr).
        // Cadence FT: use Cadence addr.
        const queryAddr = entry.variant === "cadence-ft" ? addr : coa;
        const bal = await adapter.getBalance(queryAddr);
        setRow(t.id, { publicBalance: bal, loading: false });
      } catch (err) {
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

  // Load everything on connect.
  useEffect(() => {
    if (!userAddress || loadingAll) return;
    let cancelled = false;
    async function load() {
      setLoadingAll(true);
      try {
        const coa = await getCoaEvmAddress(userAddress!);
        if (cancelled) return;
        setCoaAddr(coa);
        await fetchPublicBalances(userAddress!, coa);
      } catch {
        // Non-fatal — user may not have a COA yet.
      } finally {
        if (!cancelled) setLoadingAll(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [userAddress, fetchPublicBalances, loadingAll]);

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

  if (!isLoggedIn) {
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
                    <p className="text-[10px] text-foreground/40">{token.decimals}-decimal EVM token</p>
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
