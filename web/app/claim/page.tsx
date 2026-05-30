/// Claim/Unwrap page — v0.3.
///
/// PrivateTip v0.3 is an ORCHESTRATOR — there is no per-tip claim. Recipients
/// unwrap from their JanusFlow shielded slot whenever they want to cash out.
/// The shielded balance is the homomorphic sum of all wraps + received tips
/// minus all sent tips + unwraps.
///
/// Flow:
///   1. User connects wallet.
///   2. Load (balance, blinding) from sessionStorage (set during wrap/receive).
///      If absent, the user pastes them (MVP escape hatch).
///   3. Show current shielded balance (decrypted via the locally-stored
///      blinding) + the on-chain Pedersen commitment (read directly from EVM).
///   4. User enters amount to unwrap.
///   5. Submit Cadence transaction that calls JanusFlow.unwrap, releasing the
///      visible amount to the user's COA EVM address.
///   6. PERSIST new (balance, blinding) so the next operation works.

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
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
import { emitSnapshotSelfTip } from "@/lib/recovery";

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
  const [claimState, setClaimState] = useState<ClaimState>({
    status: "loading",
    error: null,
    txId: null,
    unwrappedFlow: null,
  });

  // -- Initial load: COA + on-chain commit + local shielded state --------------

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
          setClaimState({
            status: "needs_state",
            error: null,
            txId: null,
            unwrappedFlow: null,
          });
          return;
        }
        setShielded(s);
        setClaimState({
          status: "ready",
          error: null,
          txId: null,
          unwrappedFlow: null,
        });
      } catch (err) {
        if (!cancelled) {
          setClaimState({
            status: "error",
            error: err instanceof Error ? err.message : "Load failed",
            txId: null,
            unwrappedFlow: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userAddress]);

  // -- Unwrap handler ---------------------------------------------------------

  const handleUnwrap = useCallback(async () => {
    if (!userAddress || !shielded || !coaHex) {
      toast.error("Missing state — refresh and try again.");
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseFlowToWei(amountFlow);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setClaimState((p) => ({
        ...p,
        status: "error",
        error: err instanceof Error ? err.message : "Invalid amount",
      }));
      return;
    }

    const oldBalance = BigInt(shielded.balanceWei);
    if (amountWei > oldBalance) {
      setClaimState((p) => ({
        ...p,
        status: "error",
        error: `Insufficient shielded balance: have ${formatWeiToFlow(oldBalance)} FLOW, claim ${amountFlow} FLOW`,
      }));
      return;
    }

    setClaimState({
      status: "building_proof",
      error: null,
      txId: null,
      unwrappedFlow: null,
    });

    try {
      setClaimState({
        status: "submitting",
        error: null,
        txId: null,
        unwrappedFlow: null,
      });

      // Use the atomic bundle: unwrap + sweep COA -> Cadence FlowToken.Vault
      // in the same transaction. User sees FLOW in their wallet immediately
      // — no follow-up "withdraw from COA" step.
      const result = await unwrapAction({
        claimedAmountWei: amountWei,
        recipientEvmHex: coaHex,
        oldBalanceWei: oldBalance,
        oldBlinding: BigInt(shielded.blinding),
        toCadenceVault: true,
      });

      // Persist new state
      const newState: ShieldedState = {
        balanceWei: result.newBalanceWei.toString(),
        blinding: result.newBlinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      // Emit a snapshot self-tip with the post-unwrap absolute state.
      // ALWAYS emit — even when newBalanceWei == 0 (full drain). A zero-balance
      // snapshot prevents recovery from misreading older pre-drain state.
      // Non-fatal: unwrap already succeeded; localStorage is correct.
      try {
        const myPubkey = await getRecipientMemoPubkey(userAddress);
        if (myPubkey) {
          await emitSnapshotSelfTip({
            newBalance: result.newBalanceWei,
            newBlinding: result.newBlinding,
            myPubkey,
          });
        }
      } catch {
        // Non-fatal — snapshot self-tip failed; localStorage is still correct.
      }

      // Refresh chain commit
      const c = await getCommitment(coaHex);
      setChainCommit(c);

      setClaimState({
        status: "success",
        error: null,
        txId: result.txId,
        unwrappedFlow: formatWeiToFlow(amountWei),
      });
      toast.success("Unwrap successful!", {
        description: `${formatWeiToFlow(amountWei)} FLOW deposited to your Cadence vault.`,
      });
    } catch (err) {
      setClaimState({
        status: "error",
        error: err instanceof Error ? err.message : "Unwrap failed",
        txId: null,
        unwrappedFlow: null,
      });
    }
  }, [userAddress, shielded, coaHex, amountFlow]);

  const isSubmitting =
    claimState.status === "building_proof" || claimState.status === "submitting";

  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#B45309]/15 border border-[#B45309]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#B45309_15%,transparent)]">
            <Wallet className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Connect your wallet to unwrap your shielded balance.
          </p>
          <Button onClick={() => authenticate()} size="lg">
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <div className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Link>
      </div>

      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-lg bg-[#B45309]/15 border border-[#B45309]/30 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#B45309_12%,transparent)]">
          <Wallet className="w-5 h-5 text-[#B45309]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Withdraw FLOW</h1>
          <p className="text-sm text-muted-foreground">
            Move your private balance back to your regular wallet — one click.
          </p>
        </div>
      </div>

      {/* Balance card */}
      <div className="rounded-xl border border-[#00EF8B]/30 bg-[#00EF8B]/5 p-6 mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_8%,transparent)]">
        <div className="flex items-start gap-3">
          <Shield className="w-6 h-6 text-[#00EF8B] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground mb-1">
              Your private balance
            </p>
            {shielded ? (
              <p className="text-2xl font-bold text-[#00EF8B]" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
                {formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Can&apos;t see your balance — try opening from the wallet you used to receive.
              </p>
            )}
            {chainCommit && (
              <div className="mt-2 text-[10px] text-muted-foreground">
                <p>On-chain proof of balance:</p>
                <p className="font-mono break-all">
                  {formatPoint(chainCommit).slice(0, 80)}…
                </p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2">
              Only you can see the actual amount. Observers see an opaque crypto point.
            </p>
          </div>
        </div>
      </div>

      {/* Needs state */}
      {claimState.status === "needs_state" && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20 p-4 mb-6">
          <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
            Your private balance isn&apos;t loaded in this browser. If you&apos;ve received tips on another device, just open this page on that device — everything reloads automatically. Or paste your saved balance manually below.
          </p>
          <PasteShieldedStateForm
            addr={userAddress!}
            onSaved={(s) => {
              setShielded(s);
              setClaimState({
                status: "ready",
                error: null,
                txId: null,
                unwrappedFlow: null,
              });
            }}
          />
        </div>
      )}

      {/* Unwrap form — copper accent (boundary-out, symmetric with wrap) */}
      {claimState.status !== "needs_state" && claimState.status !== "success" && (
        <div className="rounded-xl border border-[#B45309]/30 janus-copper-glow bg-card p-6 space-y-4 mb-6">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Amount to unwrap (FLOW)
            </label>
            <input
              type="text"
              value={amountFlow}
              onChange={(e) => setAmountFlow(e.target.value)}
              placeholder="e.g. 2"
              className="w-full px-3 py-2 text-sm border rounded bg-background"
              disabled={isSubmitting || !shielded}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              This amount becomes visible when you withdraw. For maximum privacy, send the FLOW to a fresh wallet afterwards.
            </p>
          </div>

          <Button
            onClick={handleUnwrap}
            className="w-full"
            size="lg"
            disabled={isSubmitting || !shielded || !amountFlow}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {claimState.status === "building_proof"
                  ? "Building proofs…"
                  : "Submitting unwrap…"}
              </>
            ) : (
              <>
                <Coins className="w-4 h-4 mr-2" />
                Unwrap to Cadence Vault
              </>
            )}
          </Button>
          <p className="text-[10px] text-muted-foreground -mt-2">
            Atomic: EVM unwrap + COA → Cadence vault sweep in a single
            transaction. No follow-up step.
          </p>
        </div>
      )}

      {/* Success */}
      {claimState.status === "success" && (
        <div className="rounded-xl border border-[#00EF8B]/30 bg-[#00EF8B]/8 p-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_12%,transparent)]">
          <div className="flex items-start gap-3 mb-3">
            <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
            <div>
              <h3 className="text-lg font-bold mb-1">Unwrap successful!</h3>
              <p className="text-xs text-muted-foreground">
                {claimState.unwrappedFlow} FLOW now in your Cadence vault.
              </p>
            </div>
          </div>
          <p className="font-mono text-[10px] break-all mb-3">{claimState.txId}</p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Remaining shielded balance is still hidden on-chain
          </div>
        </div>
      )}

      {/* Error */}
      {claimState.status === "error" && claimState.error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">
                Unwrap failed
              </p>
              <p className="text-xs text-destructive/80">{claimState.error}</p>
            </div>
          </div>
        </div>
      )}

      <div className="mt-8 text-[10px] text-muted-foreground space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

// MVP-paste shielded state form — duplicated from send/page.tsx for simplicity.
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
      toast.error("Invalid input", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Cleartext balance (FLOW, e.g. 5)"
        value={balanceFlow}
        onChange={(e) => setBalanceFlow(e.target.value)}
        className="w-full px-3 py-2 text-xs font-mono border rounded bg-background"
      />
      <input
        type="text"
        placeholder="Blinding factor (decimal)"
        value={blinding}
        onChange={(e) => setBlinding(e.target.value)}
        className="w-full px-3 py-2 text-xs font-mono border rounded bg-background"
      />
      <Button size="sm" variant="outline" onClick={handleSave} className="w-full">
        Save (session only)
      </Button>
    </div>
  );
}
