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
  Copy,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { SUPPORTED_TOKENS, type TokenId, formatTokenAmount } from "@/lib/tokens";
import {
  getCoaEvmAddress,
  getOrDeriveMemoPrivkey,
  getRecipientMemoPubkey,
  TOKEN_PROXIES,
} from "@/lib/tip-actions";
import { sdk, TOKEN_REGISTRY, getFlowVaultBalanceWei, getPortfolioView } from "@claucondor/sdk";
import { SHIELDED_CHECKPOINT_ADDRESS, SHIELDED_INBOX_ADDRESS, FLOW_EVM_RPC, FLOW_CADENCE_ACCESS } from "@claucondor/sdk/network";
import type { ShieldedTokenState } from "@/lib/store";
// Phase 4 will rewrite /portfolio to use ShieldedCheckpointClient.readAndDecrypt() —
// loadShieldedState / saveShieldedState / recoverShieldedState removed in Phase 1 (v0.8).
import { TokenBadge } from "@/components/TokenSelector";
import { BatchClaimCTA } from "@/components/BatchClaimCTA";

const EASE = [0.22, 1, 0.36, 1] as const;

interface TokenPortfolioRow {
  tokenId: TokenId;
  publicBalance: bigint | null;
  shieldedState: ShieldedTokenState | null;
  /** Pending notes in EVM inbox not yet consolidated into checkpoint. */
  pendingRaw: bigint | null;
  pendingCount: number;
  batchEligible: boolean;
  loading: boolean;
  error: string | null;
  /** Checkpoint health — populated after getPortfolioView with janusTokenAddr. */
  checkpointHealth: "coherent" | "stale" | "corrupted" | "unknown";
  /** Which ops are safe to attempt (false when checkpointHealth==="corrupted"). */
  safeOpsAvailable: { wrap: boolean; send: boolean; claim: boolean; unwrap: boolean };
}

const initialRows = (): TokenPortfolioRow[] =>
  SUPPORTED_TOKENS.map((t) => ({
    tokenId: t.id,
    publicBalance: null,
    shieldedState: null,
    pendingRaw: null,
    pendingCount: 0,
    batchEligible: false,
    loading: false,
    error: null,
    checkpointHealth: "unknown" as const,
    safeOpsAvailable: { wrap: true, send: true, claim: true, unwrap: true },
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

  // Phase 4 will rehydrate from ShieldedCheckpoint on mount.
  // loadShieldedState (localStorage) removed in Phase 1 — rows start with null shieldedState.
  useEffect(() => {
    if (!userAddress) return;
    setRows(initialRows());
  }, [userAddress]);

  // v0.8.2: use getPortfolioView for per-token shielded + pending in one call.
  // Reads ShieldedCheckpoint (shielded balance) and ShieldedInbox (pending notes)
  // simultaneously, filtered per-token by depositor address.
  const refreshShieldedState = useCallback(async (addr: string, coa: string) => {
    const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
    const memoPrivkey = getCachedMemoPrivkey(addr);
    if (memoPrivkey === null) {
      setPageState("needs_unlock");
      return;
    }

    // Build token list for getPortfolioView — map each supported token to its EVM identifier.
    // Include janusTokenAddr for native/erc20 tokens so getPortfolioView can run the live
    // Pedersen health check against the on-chain commitment.
    const tokenList = SUPPORTED_TOKENS.map((t) => {
      const entry = TOKEN_REGISTRY[t.id];
      return {
        id: t.id,
        address: TOKEN_PROXIES[t.id as keyof typeof TOKEN_PROXIES],
        // proxy IS the JanusToken contract for native+erc20; cadence-ft omits it.
        janusTokenAddr: entry.variant !== "cadence-ft" ? entry.proxy : undefined,
      };
    });

    try {
      const view = await getPortfolioView(coa, {
        rpc: FLOW_EVM_RPC,
        checkpointAddr: SHIELDED_CHECKPOINT_ADDRESS,
        inboxAddr: SHIELDED_INBOX_ADDRESS,
        tokens: tokenList,
        memoPrivkey,
        cadenceAddress: addr,           // Cadence address — used to read Cadence inbox for MockFT
        flowAccessNode: FLOW_CADENCE_ACCESS,
      });

      for (const t of SUPPORTED_TOKENS) {
        const tv = view.tokens[t.id];
        if (!tv) continue;
        // Surface corruption in sessionStorage so RecoveryBanner can pick it up.
        if (tv.checkpointHealth === "corrupted") {
          try { sessionStorage.setItem("janus_corrupted_tokens", JSON.stringify(
            [...JSON.parse(sessionStorage.getItem("janus_corrupted_tokens") ?? "[]"), t.id]
          )); } catch { /* ignore */ }
        }

        setRow(t.id, {
          shieldedState: tv.shielded > 0n
            ? {
                balanceRaw: tv.shielded.toString(),
                blinding: "0", // blinding not exposed by getPortfolioView — not needed for display
                checkpointVersion: tv.checkpointVersion.toString(),
                lastUpdatedBlock: "0",
                inboxPendingCount: tv.pendingCount,
              }
            : null,
          pendingRaw: tv.pending,
          pendingCount: tv.pendingCount,
          batchEligible: tv.batchEligible,
          loading: false,
          error: tv.decryptErrors.length > 0 ? tv.decryptErrors[0] : null,
          checkpointHealth: tv.checkpointHealth,
          safeOpsAvailable: tv.safeOpsAvailable,
        });
      }
    } catch (err) {
      // Non-fatal: log and leave rows as-is
      console.warn("[portfolio] getPortfolioView failed:", err);
      for (const t of SUPPORTED_TOKENS) {
        setRow(t.id, { loading: false, error: null });
      }
    }
  }, [setRow, setPageState]);

  // Determine page state: needs_wallet / needs_activation / needs_unlock / ready
  // When transitioning to "ready", kick off shielded balance load.
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
          if (!cancelled) {
            setPageState("ready");
            // Kick off shielded balance read now that we have the privkey in session.
            if (coaAddr) {
              refreshShieldedState(userAddress, coaAddr).catch(() => {});
            }
          }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, userAddress, coaAddr, refreshShieldedState]);

  const handleUnlock = useCallback(async () => {
    if (!userAddress) return;
    setUnlocking(true);
    try {
      await getOrDeriveMemoPrivkey(userAddress);
      toast.success("Private inbox unlocked");
      setPageState("ready");
      // Immediately load shielded state with the newly-derived key.
      if (coaAddr) {
        refreshShieldedState(userAddress, coaAddr).catch(() => {});
      }
    } catch (err) {
      toast.error("Unlock failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUnlocking(false);
    }
  }, [userAddress, coaAddr, refreshShieldedState]);

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
        const msg = err instanceof Error ? err.message : "Failed";
        console.error(`[portfolio] fetchPublicBalances failed for ${t.id}:`, err);
        setRow(t.id, { loading: false, error: msg });
      }
    }
  }, [setRow]);

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
    try {
      await Promise.all([
        fetchPublicBalances(userAddress, coaAddr),
        refreshShieldedState(userAddress, coaAddr),
      ]);
      toast.success("Portfolio refreshed");
    } catch (err) {
      toast.error("Refresh failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingAll(false);
    }
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
        {/* Dual identity block — Cadence + EVM COA */}
        {(userAddress || coaAddr) && (
          <div className="mt-2 rounded-lg border border-white/8 bg-white/3 px-3 py-2 inline-block">
            <p className="text-[10px] text-foreground/40 font-medium mb-1">You:</p>
            <div className="space-y-0.5">
              {userAddress && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-foreground/40 w-14 shrink-0">Cadence:</span>
                  <span className="text-[10px] font-mono text-foreground/60">{userAddress}</span>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(userAddress); }}
                    className="text-foreground/30 hover:text-foreground/60 transition-colors"
                    title="Copy Cadence address"
                  >
                    <Copy className="w-2.5 h-2.5" />
                  </button>
                </div>
              )}
              {coaAddr && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-foreground/40 w-14 shrink-0">EVM COA:</span>
                  <span className="text-[10px] font-mono text-foreground/60">{coaAddr.slice(0, 10)}…{coaAddr.slice(-6)}</span>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard.writeText(coaAddr); }}
                    className="text-foreground/30 hover:text-foreground/60 transition-colors"
                    title="Copy EVM COA address"
                  >
                    <Copy className="w-2.5 h-2.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Claim CTAs — one per token with pending inbox notes */}
      {rows
        .filter((r) => r.pendingCount > 0)
        .map((r) => (
          <BatchClaimCTA
            key={r.tokenId}
            userAddress={userAddress}
            tokenId={r.tokenId}
            tokenAddress={TOKEN_PROXIES[r.tokenId as keyof typeof TOKEN_PROXIES]}
            onClaimed={() => {
              if (userAddress && coaAddr) {
                refreshShieldedState(userAddress, coaAddr).catch(() => {});
              }
            }}
          />
        ))}

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
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{token.label}</p>
                      {/* Checkpoint health badge — only shown after getPortfolioView runs */}
                      {row.checkpointHealth === "corrupted" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-900/40 border border-red-700/50 text-red-400 font-mono">
                          corrupted
                        </span>
                      )}
                      {row.checkpointHealth === "stale" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-900/30 border border-amber-700/30 text-amber-400 font-mono">
                          stale
                        </span>
                      )}
                      {row.checkpointHealth === "coherent" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-emerald-900/30 border border-emerald-700/30 text-emerald-400 font-mono">
                          coherent
                        </span>
                      )}
                    </div>
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

              {/* Corruption warning — shown when blinding is corrupted */}
              {row.checkpointHealth === "corrupted" && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-700/40 bg-red-950/30 px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] text-red-300 font-medium">Checkpoint corrupted</p>
                    <p className="text-[9px] text-red-400/70 mt-0.5">
                      Your checkpoint blinding does not match the on-chain commitment.
                      Send and withdraw are disabled. Contact support or use admin reset (testnet).
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 mb-3">
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
                  <p className="text-[9px] text-foreground/25 mb-0.5">
                    {(() => {
                      const entry = TOKEN_REGISTRY[row.tokenId];
                      return entry.variant === "cadence-ft" ? "tracked on Cadence" : "tracked on EVM";
                    })()}
                  </p>
                  {(() => {
                    return hasShielded && shieldedBal !== null ? (
                      <p className="text-sm font-mono text-[#00EF8B]">
                        {formatTokenAmount(shieldedBal, row.tokenId, 4)} {token.symbol}
                      </p>
                    ) : (
                      <p className="text-sm font-mono text-foreground/30">0.0000</p>
                    );
                  })()}
                </div>
              </div>

              {/* Pending notes row — shown when getPortfolioView found inbox notes */}
              {row.pendingCount > 0 && row.pendingRaw !== null && (
                <div className="rounded-lg border border-[#6B46C1]/20 bg-[#6B46C1]/6 px-3 py-2 mb-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[10px] text-[#8B5CF6] uppercase tracking-wide font-medium">Pending</span>
                      {row.batchEligible && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#6B46C1]/25 text-[#8B5CF6] font-mono">
                          Batch eligible · lower gas
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-mono text-[#8B5CF6]">
                      {formatTokenAmount(row.pendingRaw, row.tokenId, 4)} {token.symbol}
                      <span className="text-[10px] text-foreground/40 ml-1">({row.pendingCount} note{row.pendingCount !== 1 ? "s" : ""})</span>
                    </p>
                  </div>
                </div>
              )}

              {row.error && (
                <div className="mb-3 flex items-center gap-2 text-[10px] text-amber-400/70">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {row.error}
                </div>
              )}

              {/* Quick actions — disabled when safeOpsAvailable[op] === false */}
              <div className="flex gap-2 flex-wrap">
                <Link
                  href={`/wrap?token=${row.tokenId}`}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-white/12 bg-white/4 text-xs text-foreground/70 hover:bg-white/8 transition-colors"
                >
                  Wrap
                  <ArrowRight className="w-3 h-3" />
                </Link>
                {row.safeOpsAvailable.send ? (
                  <Link
                    href={`/send?token=${row.tokenId}`}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#6B46C1]/25 bg-[#6B46C1]/8 text-xs text-[#6B46C1] hover:bg-[#6B46C1]/15 transition-colors"
                  >
                    Send
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                ) : (
                  <span
                    title="Send disabled: checkpoint corrupted. Admin reset required."
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#6B46C1]/12 bg-[#6B46C1]/4 text-xs text-[#6B46C1]/30 cursor-not-allowed"
                  >
                    Send
                    <ArrowRight className="w-3 h-3" />
                  </span>
                )}
                {row.pendingCount > 0 && row.safeOpsAvailable.claim && (
                  <Link
                    href={`/claim?token=${row.tokenId}`}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#8B5CF6]/30 bg-[#6B46C1]/8 text-xs text-[#8B5CF6] hover:bg-[#6B46C1]/15 transition-colors"
                  >
                    Claim {row.pendingCount}
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
                {hasShielded && (
                  row.safeOpsAvailable.unwrap ? (
                    <Link
                      href={`/withdraw?token=${row.tokenId}`}
                      className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#00EF8B]/20 bg-[#00EF8B]/6 text-xs text-[#00EF8B] hover:bg-[#00EF8B]/12 transition-colors"
                    >
                      Withdraw
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  ) : (
                    <span
                      title="Withdraw disabled: checkpoint corrupted. Admin reset required."
                      className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-[#00EF8B]/10 bg-[#00EF8B]/3 text-xs text-[#00EF8B]/30 cursor-not-allowed"
                    >
                      Withdraw
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  )
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
