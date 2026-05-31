/// Wrap page — v0.3 + Janus dark theme redesign.
///
/// Boundary semantics (matches /unwrap and /send):
///   - wrap()              : msg.value VISIBLE | commitment opaque   (boundary in)
///   - shieldedTransfer()  : amount HIDDEN on calldata/events/storage (full shielded)
///   - unwrap()            : claimedAmount + recipient VISIBLE        (boundary out)
///
/// IMPORTANT — functionality unchanged. Only visual layer updated.

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import {
  ArrowLeft,
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
  getCoaBalanceWei,
  getFlowVaultBalanceWei,
  wrapAction,
  isValidFlowAmount,
  parseFlowToWei,
  formatWeiToFlow,
  formatWeiToFlowUFix64,
  formatPoint,
  isIdentityPoint,
  getRecipientMemoPubkey,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  type Point,
  type WrapSource,
} from "@/lib/tip-actions";
// Fee helpers — inline to avoid SDK rebuild dependency
function computeNetWrap(grossWei: bigint, feeBps: number): bigint {
  if (feeBps === 0) return grossWei;
  return grossWei - (grossWei * BigInt(feeBps)) / 10000n;
}
function computeWrapFee(grossWei: bigint, feeBps: number): bigint {
  if (feeBps === 0) return 0n;
  return (grossWei * BigInt(feeBps)) / 10000n;
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

// --- Local-storage helpers ---------------------------------------------------

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

// --- Status types ------------------------------------------------------------

type WrapStatus =
  | "loading"
  | "idle"
  | "validating"
  | "building_proof"
  | "submitting"
  | "success"
  | "error";

interface WrapState {
  status: WrapStatus;
  error: string | null;
  txId: string | null;
  wrappedFlow: string | null;
  newCommit: Point | null;
}

// --- Component ---------------------------------------------------------------

export default function WrapPage() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [coaHex, setCoaHex] = useState<string | null>(null);
  const [chainCommit, setChainCommit] = useState<Point | null>(null);
  const [vaultBalanceWei, setVaultBalanceWei] = useState<bigint>(BigInt(0));
  const [coaBalanceWei, setCoaBalanceWei] = useState<bigint>(BigInt(0));
  const [source, setSource] = useState<"auto" | WrapSource>("auto");
  const [amount, setAmount] = useState("1");
  const [wrapState, setWrapState] = useState<WrapState>({
    status: "loading",
    error: null,
    txId: null,
    wrappedFlow: null,
    newCommit: null,
  });

  const [feeBps, setFeeBps] = useState<number>(10); // default 10 bps = 0.1%
  const [needsCoaSetup, setNeedsCoaSetup] = useState(false);
  const [needsMemoKey, setNeedsMemoKey] = useState(false);
  const [settingUpCoa, setSettingUpCoa] = useState(false);
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
        setNeedsCoaSetup(false);

        const c = await getCommitment(coa);
        if (cancelled) return;
        setChainCommit(c);

        const [vaultWei, coaWei] = await Promise.all([
          getFlowVaultBalanceWei(userAddress),
          getCoaBalanceWei(userAddress),
        ]);
        if (cancelled) return;
        setVaultBalanceWei(vaultWei);
        setCoaBalanceWei(coaWei);

        const { getRecipientMemoPubkey } = await import("@/lib/tip-actions");
        const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
        const memoPub = await getRecipientMemoPubkey(userAddress);
        const hasSessionPrivkey = getCachedMemoPrivkey(userAddress) !== null;
        if (cancelled) return;
        setNeedsMemoKey(memoPub === null || !hasSessionPrivkey);

        const s = loadShieldedState(userAddress);
        if (s) setShielded(s);

        // Read fee rate from chain (non-fatal)
        const bps = await fetchFeeBps(JANUS_FLOW_EVM);
        if (!cancelled) setFeeBps(bps);

        setWrapState({ status: "idle", error: null, txId: null, wrappedFlow: null, newCommit: null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("No COA at /public/evm") || msg.includes("No COA")) {
          if (!cancelled) {
            setNeedsCoaSetup(true);
            setWrapState({ status: "idle", error: null, txId: null, wrappedFlow: null, newCommit: null });
          }
          return;
        }
        if (!cancelled) {
          setWrapState({ status: "error", error: msg, txId: null, wrappedFlow: null, newCommit: null });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [userAddress]);

  // -- Smart setup handler ----------------------------------------------------

  const handleSetupCoa = useCallback(async () => {
    if (!userAddress) return;
    setSettingUpCoa(true);
    try {
      const { smartSetupAccount, getRecipientMemoPubkey } = await import("@/lib/tip-actions");
      toast.info("Creating COA + MemoKey (one-time setup)...");
      const { txId } = await smartSetupAccount({ flowAddr: userAddress });
      toast.success(`Setup complete! Tx: ${txId.slice(0, 10)}...`);
      setNeedsCoaSetup(false);
      const coa = await getCoaEvmAddress(userAddress);
      setCoaHex(coa);
      const c = await getCommitment(coa);
      setChainCommit(c);
      const memoPub = await getRecipientMemoPubkey(userAddress);
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const hasSessionPrivkey = getCachedMemoPrivkey(userAddress) !== null;
      setNeedsMemoKey(memoPub === null || !hasSessionPrivkey);
    } catch (err) {
      toast.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSettingUpCoa(false);
    }
  }, [userAddress]);

  // -- Wrap handler -----------------------------------------------------------

  const handleWrap = useCallback(async () => {
    if (!userAddress) { toast.error("Wallet not connected."); return; }

    // Show pre-animation at the moment the user clicks wrap
    setShowPreAnimation(true);

    setWrapState({ status: "validating", error: null, txId: null, wrappedFlow: null, newCommit: null });

    if (!isValidFlowAmount(amount)) {
      setWrapState({ status: "error", error: "Invalid amount.", txId: null, wrappedFlow: null, newCommit: null });
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseFlowToWei(amount);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setWrapState({ status: "error", error: err instanceof Error ? err.message : "Invalid amount", txId: null, wrappedFlow: null, newCommit: null });
      return;
    }

    const amountUFix64 = formatWeiToFlowUFix64(amountWei);

    let resolvedSource: WrapSource;
    if (source === "auto") {
      if (vaultBalanceWei >= amountWei) {
        resolvedSource = "vault";
      } else if (coaBalanceWei >= amountWei) {
        resolvedSource = "coa";
      } else {
        setWrapState({
          status: "error",
          error: `Insufficient FLOW: vault has ${formatWeiToFlow(vaultBalanceWei, 4)}, COA has ${formatWeiToFlow(coaBalanceWei, 4)}, need ${amount}.`,
          txId: null, wrappedFlow: null, newCommit: null,
        });
        return;
      }
    } else {
      resolvedSource = source;
      const available = resolvedSource === "vault" ? vaultBalanceWei : coaBalanceWei;
      if (available < amountWei) {
        setWrapState({
          status: "error",
          error: `Selected source (${resolvedSource}) has only ${formatWeiToFlow(available, 4)} FLOW, need ${amount}.`,
          txId: null, wrappedFlow: null, newCommit: null,
        });
        return;
      }
    }

    setWrapState({ status: "building_proof", error: null, txId: null, wrappedFlow: null, newCommit: null });

    try {
      setWrapState({ status: "submitting", error: null, txId: null, wrappedFlow: null, newCommit: null });

      const existing = loadShieldedState(userAddress);
      const oldBalanceWei = existing ? BigInt(existing.balanceWei) : BigInt(0);
      const oldBlinding = existing ? BigInt(existing.blinding) : BigInt(0);

      // v0.5.4-fees: contract takes a 0.1% fee on msg.value. The proof MUST bind
      // to the NET amount (msg.value - fee), not the gross. Compute net here so
      // both the pre-proof (snapshot) and the wrapAction proof use the same value.
      const netAmountWei = computeNetWrap(amountWei, feeBps);

      const preProof = await (async () => {
        const res = await fetch("/api/proof/encrypt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: netAmountWei.toString() }),
        });
        if (!res.ok) return null;
        return res.json() as Promise<{ blinding: string; txCommit: string[]; proof: string[]; commitment: { x: string; y: string }; publicInputs: string[] }>;
      })();

      const wrapBlinding = preProof ? BigInt(preProof.blinding) : 0n;
      const finalNewBlinding = oldBlinding + wrapBlinding;
      // Local state tracks the NET (what's actually committed on-chain), not gross.
      const finalNewBalanceWei = oldBalanceWei + netAmountWei;

      let snapshotCt: Uint8Array | undefined;
      let snapshotEphX: bigint | undefined;
      let snapshotEphY: bigint | undefined;
      try {
        const myPubkey = await getRecipientMemoPubkey(userAddress);
        if (myPubkey && preProof) {
          const snap = await encryptSnapshotToSelf(
            { balance: finalNewBalanceWei, blinding: finalNewBlinding },
            myPubkey
          );
          snapshotCt = snap.ciphertext;
          snapshotEphX = snap.ephPubkey.x;
          snapshotEphY = snap.ephPubkey.y;
        }
      } catch { /* Non-fatal */ }

      const result = await wrapAction({
        amountUFix64, amountWei, source: resolvedSource,
        encryptedSnapshot: snapshotCt, ephPubkeyX: snapshotEphX, ephPubkeyY: snapshotEphY,
        // v0.5.4-fees: tell wrapAction the proof must bind to the NET amount
        netAmountForProofWei: netAmountWei,
      });

      const actualNewBlinding = oldBlinding + result.blinding;
      // Local state += NET (chain commit grew by net, not gross)
      const actualNewBalanceWei = oldBalanceWei + netAmountWei;

      const newState: ShieldedState = {
        balanceWei: actualNewBalanceWei.toString(),
        blinding: actualNewBlinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      if (coaHex) {
        try { const c = await getCommitment(coaHex); setChainCommit(c); } catch { /* non-fatal */ }
      }
      try {
        const [vaultWei, coaWei] = await Promise.all([
          getFlowVaultBalanceWei(userAddress),
          getCoaBalanceWei(userAddress),
        ]);
        setVaultBalanceWei(vaultWei);
        setCoaBalanceWei(coaWei);
      } catch { /* non-fatal */ }

      setShowPreAnimation(false);
      setShowPostAnimation(true);

      setWrapState({
        status: "success", error: null, txId: result.txId,
        wrappedFlow: formatWeiToFlow(amountWei, 4), newCommit: result.commitment,
      });
      toast.success("Wrap successful!", {
        description: `${formatWeiToFlow(amountWei, 4)} FLOW now in your shielded slot.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wrap failed";
      setShowPreAnimation(false);
      setWrapState({ status: "error", error: msg, txId: null, wrappedFlow: null, newCommit: null });
      toast.error("Wrap failed", { description: msg });
    }
  }, [userAddress, amount, coaHex, source, vaultBalanceWei, coaBalanceWei]);

  const isSubmitting =
    wrapState.status === "validating" ||
    wrapState.status === "building_proof" ||
    wrapState.status === "submitting";

  // -- Unauthenticated -------------------------------------------------------

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
            <Coins className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">Connect your wallet to wrap FLOW into your shielded slot.</p>
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

  // -- COA setup required ----------------------------------------------------

  if (needsCoaSetup) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#B45309_15%,transparent)]">
            <Coins className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>One-time wallet setup</h2>
          <p className="text-sm text-foreground/50 mb-2 max-w-sm">
            Your Flow account doesn&apos;t have a COA or a published MemoKey yet — both are required for shielded transfers.
          </p>
          <p className="text-sm text-foreground/50 mb-2 max-w-sm">
            <strong className="text-foreground/80">Setting up: COA + sign-derived MemoKey.</strong> The wallet will prompt for{" "}
            <strong className="text-foreground/80">one signature</strong> to derive your memo key, then a second popup to submit the on-chain setup transaction.
          </p>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">This is a one-time, gas-only setup.</p>
          <motion.button
            onClick={handleSetupCoa}
            disabled={settingUpCoa}
            whileHover={settingUpCoa ? {} : { scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
            className="janus-button-primary px-6 py-3 rounded-xl text-base disabled:opacity-50"
          >
            {settingUpCoa ? "Setting up..." : "Setup Wallet for Shielded Transfers"}
          </motion.button>
        </div>
      </div>
    );
  }

  // -- Main UI ---------------------------------------------------------------

  const onChainEmpty = chainCommit ? isIdentityPoint(chainCommit) : true;

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
          <Coins className="w-5 h-5 text-[#B45309]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Add private FLOW</h1>
          <p className="text-sm text-foreground/50">Cross the entry boundary — your FLOW moves into the private zone.</p>
        </div>
      </motion.div>

      {/* MemoKey setup banner */}
      {needsMemoKey && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-lg border border-[#B45309]/40 bg-[#B45309]/8 px-3 py-2 mb-4 flex items-center justify-between gap-3 text-xs"
        >
          <span className="text-amber-200/90">
            Your private inbox isn&apos;t active yet. Click Enable — your wallet will sign one message + confirm one transaction.
          </span>
          <motion.button
            onClick={handleSetupCoa}
            disabled={settingUpCoa}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="shrink-0 px-3 py-1 rounded border border-[#B45309]/50 bg-[#B45309]/12 text-amber-200 font-medium hover:bg-[#B45309]/20 transition-colors disabled:opacity-50 text-xs"
          >
            {settingUpCoa ? "Signing + setting up…" : "Enable"}
          </motion.button>
        </motion.div>
      )}

      {/* Current balance card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.05 }}
        className="rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/5 p-6 mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_6%,transparent)]"
      >
        <div className="flex items-start gap-3">
          <Shield className="w-6 h-6 text-[#00EF8B] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground/70 mb-1">Your private balance</p>
            {shielded ? (
              <p className="text-2xl font-bold text-[#00EF8B]" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
                {formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW
              </p>
            ) : (
              <p className="text-sm text-foreground/40">Nothing here yet — your first wrap starts it.</p>
            )}
            {chainCommit && (
              <div className="mt-2 text-[10px] text-foreground/30">
                <p>On-chain proof of balance {onChainEmpty ? "(empty)" : "(active)"}:</p>
                <p className="font-mono break-all">{formatPoint(chainCommit).slice(0, 80)}…</p>
              </div>
            )}
            <p className="text-[10px] text-foreground/30 mt-2">
              Only you see the actual amount — others see an opaque crypto point. Math (Pedersen commitments) handles the privacy.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Pre-wrap educational animation */}
      {wrapState.status !== "success" && (
        <PedersenCommitFormation
          direction="in"
          trigger={showPreAnimation || wrapState.status === "idle"}
          onDismiss={() => setShowPreAnimation(false)}
        />
      )}

      {/* Wrap form */}
      {wrapState.status !== "success" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: 0.1 }}
          className="rounded-xl border border-[#B45309]/25 janus-copper-glow bg-[#0D1E38]/80 p-6 space-y-4 mb-6"
        >
          {/* Source picker */}
          <div>
            <label className="text-xs font-medium text-foreground/50 mb-1 block">Source of FLOW</label>
            <div className="grid grid-cols-3 gap-2 mb-1">
              {(["auto", "vault", "coa"] as const).map((s) => (
                <motion.button
                  key={s}
                  type="button"
                  onClick={() => setSource(s)}
                  disabled={isSubmitting}
                  whileHover={!isSubmitting && source !== s ? { scale: 1.02 } : {}}
                  whileTap={{ scale: 0.98 }}
                  className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                    source === s
                      ? "bg-[#00EF8B]/15 text-[#00EF8B] border-[#00EF8B]/30"
                      : "bg-white/3 border-white/10 text-foreground/50 hover:border-white/20 hover:text-foreground/70"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </motion.button>
              ))}
            </div>
            <div className="text-[10px] text-foreground/30 space-y-0.5">
              <p>
                Vault: <span className="font-mono text-foreground/50">{formatWeiToFlow(vaultBalanceWei, 4)}</span> FLOW
                {" · "}
                COA: <span className="font-mono text-foreground/50">{formatWeiToFlow(coaBalanceWei, 4)}</span> FLOW
              </p>
              <p>
                {source === "auto" && "Auto picks your main FLOW balance first; uses EVM balance if main is low."}
                {source === "vault" && "Pulls from your main Flow wallet balance."}
                {source === "coa" && "Pulls from your Flow-EVM balance in one transaction."}
                {" "}Privacy is the same either way.
              </p>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount to wrap (FLOW)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1"
              className="janus-input font-mono"
              disabled={isSubmitting}
            />
            {/* Fee disclosure */}
            {(() => {
              try {
                const grossWei = parseFlowToWei(amount);
                if (grossWei > 0n) {
                  const netWei  = computeNetWrap(grossWei, feeBps);
                  const feeWei  = computeWrapFee(grossWei, feeBps);
                  const feePct  = feeBps / 100;
                  return (
                    <p className="text-[10px] text-foreground/40 mt-1">
                      Wrapping {amount} FLOW → <span className="text-[#00EF8B]/70">{formatWeiToFlow(netWei, 4)} FLOW</span> credited
                      {" "}(<span className="text-foreground/50">{formatWeiToFlow(feeWei, 4)} FLOW fee, {feePct}%</span>)
                    </p>
                  );
                }
              } catch { /* invalid amount */ }
              return (
                <p className="text-[10px] text-foreground/30 mt-1">
                  This amount is visible at the entry point. A {feeBps / 100}% fee applies. Once inside, every tip you send hides the amount.
                </p>
              );
            })()}
          </div>

          <motion.button
            onClick={handleWrap}
            disabled={isSubmitting || !amount}
            whileHover={!isSubmitting && !!amount ? { scale: 1.01, y: -1 } : {}}
            whileTap={{ scale: 0.99 }}
            className="janus-button-primary w-full py-3 rounded-xl text-base disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {wrapState.status === "validating" && "Validating…"}
                {wrapState.status === "building_proof" && "Generating Groth16 proof…"}
                {wrapState.status === "submitting" && "Submitting…"}
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Coins className="w-4 h-4" />
                Wrap FLOW
              </span>
            )}
          </motion.button>
        </motion.div>
      )}

      {/* Post-wrap success animation + result */}
      {wrapState.status === "success" && (
        <>
          <PedersenCommitFormation
            direction="in"
            trigger={showPostAnimation}
            onDismiss={() => setShowPostAnimation(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="rounded-xl border border-[#00EF8B]/25 bg-[#00EF8B]/8 p-6 mb-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_10%,transparent)]"
          >
            <div className="flex items-start gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
              <div>
                <h3 className="text-lg font-bold mb-1 text-foreground">Wrap successful!</h3>
                <p className="text-xs text-foreground/50">{wrapState.wrappedFlow} FLOW now in your shielded slot.</p>
              </div>
            </div>
            {wrapState.newCommit && (
              <div className="mb-3">
                <p className="text-xs font-medium text-foreground/70 mb-1">Your new commitment (point on BabyJubJub):</p>
                <p className="font-mono text-[10px] break-all text-[#00EF8B]/80">{formatPoint(wrapState.newCommit)}</p>
              </div>
            )}
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground/70 mb-1">Transaction:</p>
              <p className="font-mono text-[10px] break-all text-foreground/50">{wrapState.txId}</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-foreground/40 mb-4">
              <EyeOff className="w-3 h-3" />
              Your blinding factor is stored locally; future tips will spend from this slot.
            </div>
            <div className="flex gap-3 justify-center">
              <Link href="/send">
                <motion.span
                  whileHover={{ scale: 1.02, y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  className="janus-button-primary px-4 py-2 rounded-lg text-sm cursor-pointer"
                >
                  Send a Tip
                </motion.span>
              </Link>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setWrapState({ status: "idle", error: null, txId: null, wrappedFlow: null, newCommit: null });
                  setShowPostAnimation(false);
                }}
                className="px-4 py-2 rounded-lg border border-white/15 bg-white/5 text-foreground/70 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                Wrap More
              </motion.button>
            </div>
          </motion.div>
        </>
      )}

      {/* Error */}
      {wrapState.status === "error" && wrapState.error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border border-red-500/20 bg-red-950/20 p-4 mb-6"
        >
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300 mb-1">Wrap failed</p>
              <p className="text-xs text-red-400/70">{wrapState.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Footer: addresses */}
      <div className="mt-8 text-[10px] text-foreground/20 space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}
