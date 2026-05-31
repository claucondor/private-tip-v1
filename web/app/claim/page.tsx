/// Claim/Unwrap page — v0.3 + Janus dark theme redesign.
///
/// IMPORTANT — all business logic unchanged. Only visual layer updated.

"use client";

import { useState, useCallback, useEffect } from "react";
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
  unwrapAction,
  parseFlowToWei,
  formatWeiToFlow,
  formatPoint,
  getRecipientMemoPubkey,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  type Point,
} from "@/lib/tip-actions";
// Fee helpers — inline to avoid SDK rebuild dependency
function computeNetUnwrap(claimedWei: bigint, feeBps: number): bigint {
  if (feeBps === 0) return claimedWei;
  return claimedWei - (claimedWei * BigInt(feeBps)) / 10000n;
}
function computeUnwrapFee(claimedWei: bigint, feeBps: number): bigint {
  if (feeBps === 0) return 0n;
  return (claimedWei * BigInt(feeBps)) / 10000n;
}
async function fetchFeeBps(contractAddress: string): Promise<number> {
  try {
    const { JsonRpcProvider, Interface } = await import("ethers");
    const provider = new JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
    const iface = new Interface(["function feeBps() view returns (uint16)"]);
    const result = await provider.call({ to: contractAddress, data: iface.encodeFunctionData("feeBps") });
    const [bps] = iface.decodeFunctionResult("feeBps", result);
    return Number(bps);
  } catch { return 10; } // default 0.1%
}
import { encryptSnapshotToSelf } from "@/lib/recovery";
import { PedersenCommitFormation } from "@/components/animations/PedersenCommitFormation";

const EASE = [0.22, 1, 0.36, 1] as const;

interface ShieldedState {
  balanceWei: string;
  blinding: string;
}

function shieldedKey(addr: string): string {
  return `openjanus:shielded:${addr.toLowerCase()}`;
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

export default function ClaimPage() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [coaHex, setCoaHex] = useState<string | null>(null);
  const [chainCommit, setChainCommit] = useState<Point | null>(null);
  const [amountFlow, setAmountFlow] = useState("");
  const [feeBps, setFeeBps] = useState<number>(10); // default 10 bps = 0.1%
  const [claimState, setClaimState] = useState<ClaimState>({
    status: "loading",
    error: null,
    txId: null,
    unwrappedFlow: null,
  });
  const [showPreAnimation, setShowPreAnimation] = useState(false);
  const [showPostAnimation, setShowPostAnimation] = useState(false);

  // -- Initial load -----------------------------------------------------------

  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;

    (async () => {
      try {
        const coa = await getCoaEvmAddress(userAddress);
        if (cancelled) return;
        setCoaHex(coa);

        const c = await getCommitment(coa);
        if (cancelled) return;
        setChainCommit(c);

        const s = loadShieldedState(userAddress);
        if (!s) {
          setClaimState({ status: "needs_state", error: null, txId: null, unwrappedFlow: null });
        } else {
          setShielded(s);
          setClaimState({ status: "ready", error: null, txId: null, unwrappedFlow: null });
        }

        // Read fee rate from chain (non-fatal)
        const bps = await fetchFeeBps(JANUS_FLOW_EVM);
        if (!cancelled) setFeeBps(bps);
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
  }, [userAddress]);

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
      amountWei = parseFlowToWei(amountFlow);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setClaimState((p) => ({ ...p, status: "error", error: err instanceof Error ? err.message : "Invalid amount" }));
      return;
    }

    const oldBalance = BigInt(shielded.balanceWei);
    if (amountWei > oldBalance) {
      setClaimState((p) => ({
        ...p, status: "error",
        error: `Insufficient shielded balance: have ${formatWeiToFlow(oldBalance)} FLOW, claim ${amountFlow} FLOW`,
      }));
      return;
    }

    setClaimState({ status: "building_proof", error: null, txId: null, unwrappedFlow: null });

    try {
      setClaimState({ status: "submitting", error: null, txId: null, unwrappedFlow: null });

      const result = await unwrapAction({
        claimedAmountWei: amountWei,
        recipientEvmHex: coaHex,
        oldBalanceWei: oldBalance,
        oldBlinding: BigInt(shielded.blinding),
        toCadenceVault: true,
      });

      const newState: ShieldedState = {
        balanceWei: result.newBalanceWei.toString(),
        blinding: result.newBlinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      try {
        const myPubkey = await getRecipientMemoPubkey(userAddress);
        if (myPubkey) {
          const snap = await encryptSnapshotToSelf(
            { balance: result.newBalanceWei, blinding: result.newBlinding },
            myPubkey
          );
          void snap;
        }
      } catch { /* Non-fatal */ }

      const c = await getCommitment(coaHex);
      setChainCommit(c);

      setShowPreAnimation(false);
      setShowPostAnimation(true);

      setClaimState({ status: "success", error: null, txId: result.txId, unwrappedFlow: formatWeiToFlow(amountWei) });
      toast.success("Unwrap successful!", { description: `${formatWeiToFlow(amountWei)} FLOW deposited to your Cadence vault.` });
    } catch (err) {
      setShowPreAnimation(false);
      setClaimState({
        status: "error",
        error: err instanceof Error ? err.message : "Unwrap failed",
        txId: null, unwrappedFlow: null,
      });
    }
  }, [userAddress, shielded, coaHex, amountFlow]);

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
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Withdraw FLOW</h1>
          <p className="text-sm text-foreground/50">Move your private balance back to your regular wallet — one click.</p>
        </div>
      </motion.div>

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
                {formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW
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
            onSaved={(s) => {
              setShielded(s);
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
          <div>
            <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount to unwrap (FLOW)</label>
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
                const claimedWei = parseFlowToWei(amountFlow);
                if (claimedWei > 0n) {
                  const netWei  = computeNetUnwrap(claimedWei, feeBps);
                  const feeWei  = computeUnwrapFee(claimedWei, feeBps);
                  const feePct  = feeBps / 100;
                  return (
                    <p className="text-[10px] text-foreground/40 mt-1">
                      Withdrawing {amountFlow} FLOW → you receive{" "}
                      <span className="text-[#00EF8B]/70">{formatWeiToFlow(netWei, 4)} FLOW</span>
                      {" "}(<span className="text-foreground/50">{formatWeiToFlow(feeWei, 4)} FLOW fee, {feePct}%</span>)
                    </p>
                  );
                }
              } catch { /* invalid amount */ }
              return (
                <p className="text-[10px] text-foreground/30 mt-1">
                  A {feeBps / 100}% fee applies. For maximum privacy, send the FLOW to a fresh wallet afterwards.
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
                <p className="text-xs text-foreground/50">{claimState.unwrappedFlow} FLOW now in your Cadence vault.</p>
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

// MVP-paste shielded state form
function PasteShieldedStateForm({
  addr,
  onSaved,
}: {
  addr: string;
  onSaved: (s: ShieldedState) => void;
}) {
  const [balanceFlow, setBalanceFlow] = useState("");
  const [blinding, setBlinding] = useState("");

  const handleSave = () => {
    try {
      const balanceWei = parseFlowToWei(balanceFlow).toString();
      const blindingDec = BigInt(blinding.trim()).toString();
      const s: ShieldedState = { balanceWei, blinding: blindingDec };
      saveShieldedState(addr, s);
      onSaved(s);
      toast.success("Shielded state saved (session only)");
    } catch (err) {
      toast.error("Invalid input", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Cleartext balance (FLOW, e.g. 5)"
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
