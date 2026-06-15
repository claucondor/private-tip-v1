/// Withdraw/Unwrap page — v0.8.2 — moves shielded balance to underlying wallet.
///
/// This page handles ONLY the unwrap (shielded → wallet) flow.
/// To claim pending inbox notes (inbox → shielded), use /claim.

"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Wallet,
  Loader2,
  CheckCircle,
  XCircle,
  Shield,
  Coins,
  EyeOff,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import {
  getCoaEvmAddress,
  getCommitment,
  unwrapToken,
  getShieldedStateForCoa,
  formatPoint,
  getRecipientMemoPubkey,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  fetchFeeBps,
  getOrDeriveMemoPrivkey,
  TOKEN_PROXIES,
  type Point,
} from "@/lib/tip-actions";
// loadShieldedState and saveShieldedState removed from @/lib/store in v0.8.
// Phase 4/5/6 will rewrite — Phase 1 left this here intentionally because it
// consumes lib functions whose rewrite happens later.
import { TokenSelector } from "@/components/TokenSelector";
import { type TokenId, getTokenMeta, formatTokenAmount, parseTokenAmount } from "@/lib/tokens";
import { PedersenCommitFormation } from "@/components/animations/PedersenCommitFormation";

const EASE = [0.22, 1, 0.36, 1] as const;

interface ShieldedState {
  balanceWei: string;
  blinding: string;
  /** lastConsumedNoteIndex from checkpoint — inbox cursor for unwrap proof. */
  cursor: string;
}

// Compatibility shim — paste-form still needs saveShieldedState during manual entry.
function loadShieldedState(_addr: string, _tokenId: TokenId = "flow"): ShieldedState | null {
  return null; // checkpoint is read on-chain now
}

function saveShieldedState(_addr: string, _state: ShieldedState, _tokenId: TokenId = "flow"): void {
  // no-op — state is on-chain
}

type ClaimStatus =
  | "loading"
  | "ready"
  | "needs_state"
  | "building_proof"
  | "submitting"
  | "success"
  | "error";

interface ClaimState {
  status: ClaimStatus;
  error: string | null;
  txId: string | null;
  unwrappedFlow: string | null;
}

function WithdrawPageInner() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const searchParams = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "flow") as TokenId;
  const [selectedToken, setSelectedToken] = useState<TokenId>(initialToken);

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [coaHex, setCoaHex] = useState<string | null>(null);
  const [chainCommit, setChainCommit] = useState<Point | null>(null);
  const [amountFlow, setAmountFlow] = useState("");
  const [feeBps, setFeeBps] = useState<number>(10); // default 10 bps = 0.1%

  // Per-token unwrap destination:
  //   FLOW: "cadence" (Cadence FlowToken vault) | "evm" (COA EVM wallet)
  //   mUSDC: editable EVM address (default own COA)
  //   MockFT: editable Cadence address (default own Cadence address)
  const [flowDestination, setFlowDestination] = useState<"cadence" | "evm">("cadence");
  const [musdcDestination, setMusdcDestination] = useState<string>("");
  const [mockftDestination, setMockftDestination] = useState<string>("");

  const [claimState, setClaimState] = useState<ClaimState>({
    status: "loading",
    error: null,
    txId: null,
    unwrappedFlow: null,
  });
  const [showPreAnimation, setShowPreAnimation] = useState(false);
  const [showPostAnimation, setShowPostAnimation] = useState(false);

  const symbol = getTokenMeta(selectedToken).symbol;

  // -- Initial load -----------------------------------------------------------
  // Reads on-chain ShieldedCheckpoint for the selected token.
  // Transitions to "ready" when checkpoint found, "needs_state" when not.

  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    setAmountFlow("");
    setShielded(null);
    setClaimState({ status: "loading", error: null, txId: null, unwrappedFlow: null });

    (async () => {
      try {
        const coa = await getCoaEvmAddress(userAddress);
        if (cancelled) return;
        setCoaHex(coa);
        // Seed destination defaults when COA is first resolved.
        setMusdcDestination((prev) => prev || coa);
        setMockftDestination((prev) => prev || userAddress);

        // Cadence-ft tracks commitments by Cadence wallet address; everything else by COA EVM.
        const commitAddr = selectedToken === "mockft" ? userAddress : coa;
        const c = await getCommitment(commitAddr, selectedToken);
        if (cancelled) return;
        setChainCommit(c);

        // Read fee rate from chain (non-fatal)
        const bps = await fetchFeeBps(selectedToken).catch(() => 10);
        if (!cancelled) setFeeBps(bps);

        // Read shielded state from on-chain checkpoint.
        // Requires memo privkey in session — if not available, show needs_state.
        const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
        const memoPrivkey = getCachedMemoPrivkey(userAddress);
        if (memoPrivkey === null) {
          if (!cancelled) {
            setClaimState({ status: "needs_state", error: null, txId: null, unwrappedFlow: null });
          }
          return;
        }

        const tokenProxy = TOKEN_PROXIES[selectedToken as keyof typeof TOKEN_PROXIES];
        const cpState = await getShieldedStateForCoa(coa, memoPrivkey, tokenProxy).catch(() => null);
        if (cancelled) return;
        if (cpState) {
          setShielded({
            balanceWei: cpState.balance.toString(),
            blinding: cpState.blinding.toString(),
            cursor: cpState.lastConsumedNoteIndex.toString(),
          });
          setClaimState({ status: "ready", error: null, txId: null, unwrappedFlow: null });
        } else {
          // No checkpoint yet — user may not have wrapped any tokens for this token.
          setClaimState({ status: "needs_state", error: null, txId: null, unwrappedFlow: null });
        }
      } catch (err) {
        if (!cancelled) {
          setClaimState({
            status: "error",
            error: err instanceof Error ? err.message : "Load failed",
            txId: null, unwrappedFlow: null,
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [userAddress, selectedToken]);

  // -- Unwrap handler ---------------------------------------------------------

  const handleUnwrap = useCallback(async () => {
    if (!userAddress || !shielded || !coaHex) {
      toast.error("Missing state — refresh and try again.");
      return;
    }

    // Show pre-unwrap animation
    setShowPreAnimation(true);

    let amountWei: bigint;
    try {
      amountWei = parseTokenAmount(amountFlow, selectedToken);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setClaimState((p) => ({ ...p, status: "error", error: err instanceof Error ? err.message : "Invalid amount" }));
      setShowPreAnimation(false);
      return;
    }

    const oldBalance = BigInt(shielded.balanceWei);
    if (amountWei > oldBalance) {
      setClaimState((p) => ({
        ...p, status: "error",
        error: `Insufficient shielded balance: have ${formatTokenAmount(oldBalance, selectedToken)} ${symbol}, claim ${amountFlow} ${symbol}`,
      }));
      setShowPreAnimation(false);
      return;
    }

    setClaimState({ status: "building_proof", error: null, txId: null, unwrappedFlow: null });

    try {
      // Derive memoKeypair — will prompt wallet signature if not cached.
      const privkey = await getOrDeriveMemoPrivkey(userAddress);
      const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
      const pubkey = await pubkeyFromPrivkey(privkey);
      const memoKeypair = { privkey, pubkey };

      setClaimState({ status: "submitting", error: null, txId: null, unwrappedFlow: null });

      // Resolve recipient based on token type and user-selected destination:
      //   FLOW:    Cadence vault (userAddress) OR COA EVM (coaHex) — user picks
      //   mUSDC:   editable EVM address (default own COA)
      //   MockFT:  editable Cadence address (default own Cadence address)
      let recipient: string;
      if (selectedToken === "mockft") {
        recipient = mockftDestination || userAddress;
      } else if (selectedToken === "mockusdc") {
        recipient = musdcDestination || coaHex;
      } else {
        // FLOW — radio choice
        recipient = flowDestination === "evm" ? coaHex : userAddress;
      }

      const result = await unwrapToken({
        tokenId: selectedToken,
        claimedAmount: amountWei,
        recipient,
        coaEvmAddr: coaHex,
        memoKeypair,
        memoPrivkey: privkey,
        currentBalance: oldBalance,
        currentBlinding: BigInt(shielded.blinding),
        inboxCursor: BigInt(shielded.cursor ?? "0"),
        // evmSigner is in the interface but unused in the v0.8 FCL-based implementation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evmSigner: null as any,
        userCadenceAddr: userAddress ?? undefined,
      });

      const newState: ShieldedState = {
        balanceWei: result.newBalance.toString(),
        blinding: result.newBlinding.toString(),
        cursor: shielded.cursor, // cursor unchanged by unwrap
      };
      setShielded(newState);

      const commitAddrPost = selectedToken === "mockft" ? userAddress : coaHex;
      const c = await getCommitment(commitAddrPost, selectedToken);
      setChainCommit(c);

      setShowPreAnimation(false);
      setShowPostAnimation(true);

      setClaimState({ status: "success", error: null, txId: result.txHash, unwrappedFlow: formatTokenAmount(amountWei, selectedToken) });
      toast.success("Unwrap successful!", { description: `${formatTokenAmount(amountWei, selectedToken)} ${symbol} deposited to your Cadence vault.` });
    } catch (err) {
      setShowPreAnimation(false);
      setClaimState({
        status: "error",
        error: err instanceof Error ? err.message : "Unwrap failed",
        txId: null, unwrappedFlow: null,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, shielded, coaHex, amountFlow, selectedToken]);

  const isSubmitting =
    claimState.status === "building_proof" || claimState.status === "submitting";

  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#B45309_15%,transparent)]">
            <Wallet className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">Connect your wallet to unwrap your shielded balance.</p>
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

  return (
    <div className="max-w-lg mx-auto px-4 py-12 janus-page">
      <div className="mb-8">
        <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />Back
        </Link>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="flex items-center gap-3 mb-8"
      >
        <div className="w-10 h-10 rounded-lg bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#B45309_12%,transparent)]">
          <Wallet className="w-5 h-5 text-[#B45309]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Withdraw {symbol}</h1>
          <p className="text-sm text-foreground/50">Move your private balance back to your regular wallet — one click.</p>
        </div>
      </motion.div>

      {/* Token selector — drives balance display, batch-claim CTA, and unwrap form */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE, delay: 0.04 }}
        className="mb-4"
      >
        <TokenSelector
          value={selectedToken}
          onChange={(id) => { setSelectedToken(id); setShielded(null); }}
          disabled={isSubmitting}
          label="Token to claim / unwrap"
        />
      </motion.div>

      {/* Inbox advisory — pending notes must be claimed before they appear in shielded balance */}
      <div className="rounded-lg border border-[#6B46C1]/20 bg-[#6B46C1]/6 px-4 py-2.5 mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-foreground/60">
          Have pending inbox tips? Claim them first so they appear in your shielded balance.
        </p>
        <Link
          href={`/claim?token=${selectedToken}`}
          className="shrink-0 text-xs text-[#8B5CF6] hover:text-[#9B6CF6] font-medium transition-colors"
        >
          Claim inbox →
        </Link>
      </div>

      {/* Balance card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.05 }}
        className="rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/5 p-6 mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_6%,transparent)]"
      >
        <div className="flex items-start gap-3">
          <Shield className="w-6 h-6 text-[#00EF8B] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground/60 mb-1">Your private balance</p>
            {shielded ? (
              <p className="text-2xl font-bold text-[#00EF8B]" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
                {formatTokenAmount(BigInt(shielded.balanceWei), selectedToken, 4)} {symbol}
              </p>
            ) : (
              <p className="text-sm text-foreground/40">
                Can&apos;t see your balance — try opening from the wallet you used to receive.
              </p>
            )}
            {chainCommit && (
              <div className="mt-2 text-[10px] text-foreground/30">
                <p>On-chain proof of balance:</p>
                <p className="font-mono break-all">{formatPoint(chainCommit).slice(0, 80)}…</p>
              </div>
            )}
            <p className="text-[10px] text-foreground/30 mt-2">
              Only you can see the actual amount. Observers see an opaque crypto point.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Needs state */}
      {claimState.status === "needs_state" && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border border-[#B45309]/20 bg-[#B45309]/5 p-4 mb-6"
        >
          <p className="text-sm text-amber-200/70 mb-3">
            Your private balance isn&apos;t loaded in this browser. If you&apos;ve received tips on another device, just open this page on that device — everything reloads automatically. Or paste your saved balance manually below.
          </p>
          <PasteShieldedStateForm
            addr={userAddress!}
            tokenId={selectedToken}
            onSaved={(s) => {
              setShielded({ ...s, cursor: "0" });
              setClaimState({ status: "ready", error: null, txId: null, unwrappedFlow: null });
            }}
          />
        </motion.div>
      )}

      {/* Pre-unwrap educational animation */}
      {claimState.status !== "needs_state" && claimState.status !== "success" && (
        <PedersenCommitFormation
          direction="out"
          trigger={showPreAnimation || (claimState.status === "ready" || claimState.status === "error")}
          onDismiss={() => setShowPreAnimation(false)}
        />
      )}

      {/* Unwrap form */}
      {claimState.status !== "needs_state" && claimState.status !== "success" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: 0.1 }}
          className="rounded-xl border border-[#B45309]/25 janus-copper-glow bg-[#0D1E38]/80 p-6 space-y-4 mb-6"
        >
          {/* Per-token destination selector */}
          {selectedToken === "flow" && (
            <div>
              <label className="text-xs font-medium text-foreground/50 mb-2 block">Withdraw to</label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="flow-destination"
                    value="cadence"
                    checked={flowDestination === "cadence"}
                    onChange={() => setFlowDestination("cadence")}
                    disabled={isSubmitting}
                    className="accent-[#00EF8B]"
                  />
                  <span className="text-xs text-foreground/70">My Cadence FlowToken vault <span className="text-foreground/40 font-mono">(default)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="flow-destination"
                    value="evm"
                    checked={flowDestination === "evm"}
                    onChange={() => setFlowDestination("evm")}
                    disabled={isSubmitting}
                    className="accent-[#00EF8B]"
                  />
                  <span className="text-xs text-foreground/70">My EVM wallet (COA)</span>
                </label>
              </div>
              <p className="text-[10px] text-foreground/30 mt-1">
                {flowDestination === "cadence"
                  ? `→ ${userAddress ?? "your Cadence address"}`
                  : `→ ${coaHex ?? "your COA EVM address"}`}
              </p>
            </div>
          )}

          {selectedToken === "mockusdc" && (
            <div>
              <label className="text-xs font-medium text-foreground/50 mb-1 block">Withdraw to EVM address</label>
              <input
                type="text"
                value={musdcDestination}
                onChange={(e) => setMusdcDestination(e.target.value)}
                placeholder="0x... (40-hex EVM address)"
                className="janus-input font-mono text-xs"
                disabled={isSubmitting}
              />
              <p className="text-[10px] text-foreground/30 mt-1">Defaults to your own COA EVM address.</p>
            </div>
          )}

          {selectedToken === "mockft" && (
            <div>
              <label className="text-xs font-medium text-foreground/50 mb-1 block">Withdraw to Cadence FT vault</label>
              <input
                type="text"
                value={mockftDestination}
                onChange={(e) => setMockftDestination(e.target.value)}
                placeholder="0x... (16-hex Cadence address)"
                className="janus-input font-mono text-xs"
                disabled={isSubmitting}
              />
              <p className="text-[10px] text-foreground/30 mt-1">Defaults to your own Cadence address.</p>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount to unwrap</label>
            <input
              type="text"
              value={amountFlow}
              onChange={(e) => setAmountFlow(e.target.value)}
              placeholder="e.g. 2"
              className="janus-input"
              disabled={isSubmitting || !shielded}
            />
            {/* Fee disclosure */}
            {(() => {
              try {
                const claimedWei = parseTokenAmount(amountFlow, selectedToken);
                if (claimedWei > 0n) {
                  const feeWei = feeBps === 0 ? 0n : (claimedWei * BigInt(feeBps)) / 10000n;
                  const netWei  = claimedWei - feeWei;
                  const feePct  = feeBps / 100;
                  return (
                    <p className="text-[10px] text-foreground/40 mt-1">
                      Withdrawing {amountFlow} {symbol} → you receive{" "}
                      <span className="text-[#00EF8B]/70">{formatTokenAmount(netWei, selectedToken, 4)} {symbol}</span>
                      {" "}(<span className="text-foreground/50">{formatTokenAmount(feeWei, selectedToken, 4)} {symbol} fee, {feePct}%</span>)
                    </p>
                  );
                }
              } catch { /* invalid amount */ }
              return (
                <p className="text-[10px] text-foreground/30 mt-1">
                  A {feeBps / 100}% fee applies. For maximum privacy, send the {symbol} to a fresh wallet afterwards.
                </p>
              );
            })()}
          </div>

          {userAddress && (
            <div className="text-xs text-foreground/60 mb-2">
              Withdraws to: <span className="font-mono break-all">{userAddress}</span>
            </div>
          )}

          <motion.button
            onClick={handleUnwrap}
            disabled={isSubmitting || !shielded || !amountFlow}
            whileHover={!isSubmitting && !!shielded && !!amountFlow ? { scale: 1.01, y: -1 } : {}}
            whileTap={{ scale: 0.99 }}
            className="janus-button-primary w-full py-3 rounded-xl text-base disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {claimState.status === "building_proof" ? "Building proofs…" : "Submitting unwrap…"}
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Coins className="w-4 h-4" />
                Unwrap to Cadence Vault
              </span>
            )}
          </motion.button>
          <p className="text-[10px] text-foreground/30 -mt-2">
            Atomic: EVM unwrap + COA → Cadence vault sweep in a single transaction. No follow-up step.
          </p>
        </motion.div>
      )}

      {/* Success + post-animation */}
      {claimState.status === "success" && (
        <>
          <PedersenCommitFormation
            direction="out"
            trigger={showPostAnimation}
            onDismiss={() => setShowPostAnimation(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/8 p-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_8%,transparent)]"
          >
            <div className="flex items-start gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
              <div>
                <h3 className="text-lg font-bold mb-1 text-foreground">Unwrap successful!</h3>
                <p className="text-xs text-foreground/50">{claimState.unwrappedFlow} {symbol} now in your Cadence vault.</p>
              </div>
            </div>
            <p className="font-mono text-[10px] break-all mb-3 text-foreground/40">{claimState.txId}</p>
            <div className="flex items-center gap-1.5 text-xs text-foreground/40">
              <EyeOff className="w-3 h-3" />
              Remaining shielded balance is still hidden on-chain
            </div>
          </motion.div>
        </>
      )}

      {/* Error */}
      {claimState.status === "error" && claimState.error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border border-red-500/20 bg-red-950/20 p-4"
        >
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300 mb-1">Unwrap failed</p>
              <p className="text-xs text-red-400/70">{claimState.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      <div className="mt-8 text-[10px] text-foreground/20 space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono break-all">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono break-all">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

export default function WithdrawPage() {
  return (
    <Suspense fallback={<div className="max-w-lg mx-auto px-4 py-12" />}>
      <WithdrawPageInner />
    </Suspense>
  );
}

// MVP-paste shielded state form
function PasteShieldedStateForm({
  addr: _addr,
  tokenId,
  onSaved,
}: {
  addr: string;
  tokenId: TokenId;
  onSaved: (s: Omit<ShieldedState, "cursor">) => void;
}) {
  const [balanceFlow, setBalanceFlow] = useState("");
  const [blinding, setBlinding] = useState("");
  const tokenSymbol = getTokenMeta(tokenId).symbol;

  const handleSave = () => {
    try {
      const balanceWei = parseTokenAmount(balanceFlow, tokenId).toString();
      const blindingDec = BigInt(blinding.trim()).toString();
      onSaved({ balanceWei, blinding: blindingDec });
      toast.success("Shielded state loaded (session only — cursor set to 0)");
    } catch (err) {
      toast.error("Invalid input", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder={`Cleartext balance (${tokenSymbol}, e.g. 5)`}
        value={balanceFlow}
        onChange={(e) => setBalanceFlow(e.target.value)}
        className="janus-input font-mono text-xs"
      />
      <input
        type="text"
        placeholder="Blinding factor (decimal)"
        value={blinding}
        onChange={(e) => setBlinding(e.target.value)}
        className="janus-input font-mono text-xs"
      />
      <motion.button
        onClick={handleSave}
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        className="w-full px-3 py-2 text-sm rounded-lg border border-white/15 bg-white/5 text-foreground/60 hover:text-foreground/80 hover:bg-white/8 transition-colors"
      >
        Save (session only)
      </motion.button>
    </div>
  );
}
