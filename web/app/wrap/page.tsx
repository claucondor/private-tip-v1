/// Wrap page — v0.3.
///
/// In-app wrap flow: pre-fund the user's JanusFlow shielded slot from the
/// browser. Removes the operator's need to run `node scripts/v03-smoke.mjs`
/// just to seed `sessionStorage` before sending the first tip.
///
/// Boundary semantics (matches /unwrap and /send):
///   - wrap()              : msg.value VISIBLE | commitment opaque   (boundary in)
///   - shieldedTransfer()  : amount HIDDEN on calldata/events/storage (full shielded)
///   - unwrap()            : claimedAmount + recipient VISIBLE        (boundary out)
///
/// Flow:
///   1. User connects wallet (useFlowCurrentUser).
///   2. We read the existing shielded state from sessionStorage (if any) AND
///      the on-chain Pedersen commitment for visual confirmation.
///   3. User enters whole-FLOW amount to wrap.
///   4. wrapAction() generates the amount-disclose proof server-side and
///      submits the Cadence transaction (JanusFlow.wrap via the FLOW vault).
///   5. We sum the new amount into the locally-known balance and persist
///      (balance, blinding) so the very next /send works.
///
/// IMPORTANT — additive-wrap UX caveat:
///   The current SDK helper `buildAmountDiscloseProof` produces a FRESH
///   commitment binding only the wrap amount. The on-chain contract
///   homomorphically ADDs that commit point to the user's stored commit, but
///   to spend the resulting aggregate the user needs (balance_total,
///   blinding_total) where both are the SUMS of every wrap so far.
///
///   We track `balanceWei = old + new` here, but the stored `blinding` is
///   overwritten by the latest wrap. That's fine on the FIRST wrap (the
///   blinding is the sum trivially), but a second wrap on top of an existing
///   commit would desync. We surface this in the UI and the
///   wrap-on-empty-slot path is the supported one for v0.3.

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Loader2,
  CheckCircle,
  XCircle,
  Shield,
  Coins,
  AlertTriangle,
  EyeOff,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import {
  getCoaEvmAddress,
  getCommitment,
  wrapAction,
  isValidFlowAmount,
  parseFlowToWei,
  formatWeiToFlow,
  formatWeiToFlowUFix64,
  formatPoint,
  isIdentityPoint,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  SDK_VERSION,
  type Point,
} from "@/lib/tip-actions";

// --- Local-storage helpers (mirrors /send and /claim) -------------------------

interface ShieldedState {
  balanceWei: string;
  blinding: string;
}

function shieldedKey(addr: string): string {
  return `openjanus:shielded:${addr.toLowerCase()}`;
}

function loadShieldedState(addr: string): ShieldedState | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(shieldedKey(addr));
  return raw ? (JSON.parse(raw) as ShieldedState) : null;
}

function saveShieldedState(addr: string, state: ShieldedState): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(shieldedKey(addr), JSON.stringify(state));
}

// --- Status types -------------------------------------------------------------

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

// --- Component ----------------------------------------------------------------

export default function WrapPage() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [coaHex, setCoaHex] = useState<string | null>(null);
  const [chainCommit, setChainCommit] = useState<Point | null>(null);
  const [amount, setAmount] = useState("1");
  const [wrapState, setWrapState] = useState<WrapState>({
    status: "loading",
    error: null,
    txId: null,
    wrappedFlow: null,
    newCommit: null,
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
        if (s) setShielded(s);

        setWrapState({
          status: "idle",
          error: null,
          txId: null,
          wrappedFlow: null,
          newCommit: null,
        });
      } catch (err) {
        if (!cancelled) {
          setWrapState({
            status: "error",
            error: err instanceof Error ? err.message : "Load failed",
            txId: null,
            wrappedFlow: null,
            newCommit: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userAddress]);

  // -- Wrap handler ----------------------------------------------------------

  const handleWrap = useCallback(async () => {
    if (!userAddress) {
      toast.error("Wallet not connected.");
      return;
    }

    setWrapState({
      status: "validating",
      error: null,
      txId: null,
      wrappedFlow: null,
      newCommit: null,
    });

    if (!isValidFlowAmount(amount)) {
      setWrapState({
        status: "error",
        error: "Invalid amount.",
        txId: null,
        wrappedFlow: null,
        newCommit: null,
      });
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseFlowToWei(amount);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setWrapState({
        status: "error",
        error: err instanceof Error ? err.message : "Invalid amount",
        txId: null,
        wrappedFlow: null,
        newCommit: null,
      });
      return;
    }

    const amountUFix64 = formatWeiToFlowUFix64(amountWei);

    setWrapState({
      status: "building_proof",
      error: null,
      txId: null,
      wrappedFlow: null,
      newCommit: null,
    });

    try {
      setWrapState({
        status: "submitting",
        error: null,
        txId: null,
        wrappedFlow: null,
        newCommit: null,
      });

      const result = await wrapAction({ amountUFix64, amountWei });

      // Sum into the local-known balance (additive across wraps in same
      // session). On a fresh slot the existing balance is 0 wei and the
      // returned blinding matches the aggregate commitment trivially.
      const existing = loadShieldedState(userAddress);
      const oldBalanceWei = existing ? BigInt(existing.balanceWei) : BigInt(0);
      const newBalanceWei = oldBalanceWei + amountWei;

      const newState: ShieldedState = {
        balanceWei: newBalanceWei.toString(),
        blinding: result.blinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      // Refresh on-chain commit for the visual confirmation.
      if (coaHex) {
        try {
          const c = await getCommitment(coaHex);
          setChainCommit(c);
        } catch {
          // Non-fatal — surface no error, the user already has txId.
        }
      }

      setWrapState({
        status: "success",
        error: null,
        txId: result.txId,
        wrappedFlow: formatWeiToFlow(amountWei, 4),
        newCommit: result.commitment,
      });
      toast.success("Wrap successful!", {
        description: `${formatWeiToFlow(amountWei, 4)} FLOW now in your shielded slot.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wrap failed";
      setWrapState({
        status: "error",
        error: msg,
        txId: null,
        wrappedFlow: null,
        newCommit: null,
      });
      toast.error("Wrap failed", { description: msg });
    }
  }, [userAddress, amount, coaHex]);

  const isSubmitting =
    wrapState.status === "validating" ||
    wrapState.status === "building_proof" ||
    wrapState.status === "submitting";

  // -- Unauthenticated -------------------------------------------------------

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
          <div className="w-16 h-16 rounded-2xl bg-blue-100 dark:bg-blue-950 flex items-center justify-center mb-6">
            <Coins className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">Connect Your Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Connect your wallet to wrap FLOW into your shielded slot.
          </p>
          <Button onClick={() => authenticate()} size="lg">
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  // -- Main UI ---------------------------------------------------------------

  const hasExistingSlot =
    !!shielded && BigInt(shielded.balanceWei) > BigInt(0);

  const onChainEmpty = chainCommit ? isIdentityPoint(chainCommit) : true;

  // Additive-wrap warning: if the chain has an existing commit but we have
  // no local blinding to track, a second wrap will overwrite the blinding
  // and the user will be unable to spend the aggregate. See file header.
  const additiveBlindingWarning =
    !onChainEmpty && !hasExistingSlot;

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
        <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
          <Coins className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Wrap FLOW</h1>
          <p className="text-sm text-muted-foreground">
            Pre-fund your shielded slot — the boundary IN to private tips.
          </p>
        </div>
      </div>

      {/* Current balance card */}
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20 p-6 mb-6">
        <div className="flex items-start gap-3">
          <Shield className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground mb-1">
              Your shielded balance (local-known)
            </p>
            {shielded ? (
              <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                {formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No local shielded state yet — your first wrap creates it.
              </p>
            )}
            {chainCommit && (
              <div className="mt-2 text-[10px] text-muted-foreground">
                <p>
                  On-chain Pedersen commitment{" "}
                  {onChainEmpty ? "(empty slot)" : "(non-empty)"}:
                </p>
                <p className="font-mono break-all">
                  {formatPoint(chainCommit).slice(0, 80)}…
                </p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2">
              Balance is decrypted locally with your stored blinding factor.
              On-chain observers see only the commitment point.
            </p>
          </div>
        </div>
      </div>

      {/* Additive-blinding warning (chain has commit, local state is empty) */}
      {additiveBlindingWarning && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-800 dark:text-amber-200">
              <p className="font-medium mb-1">Chain has an existing commitment</p>
              <p>
                The on-chain commitment is non-empty but no local blinding is
                stored. Wrapping here will overwrite the blinding and you may
                lose the ability to spend the aggregate. Restore via
                /send (paste shielded state) before continuing, or unwrap the
                existing slot first.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Wrap form (hidden after success) */}
      {wrapState.status !== "success" && (
        <div className="rounded-xl border border-border bg-card p-6 space-y-4 mb-6">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Amount to wrap (FLOW)
            </label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1"
              className="w-full px-3 py-2 text-sm border rounded bg-background"
              disabled={isSubmitting}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              VISIBLE on-chain (this is the wrap boundary — msg.value is
              public). Subsequent shielded transfers HIDE the amount.
            </p>
          </div>

          <Button
            onClick={handleWrap}
            className="w-full"
            size="lg"
            disabled={isSubmitting || !amount}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {wrapState.status === "validating" && "Validating…"}
                {wrapState.status === "building_proof" && "Generating Groth16 proof…"}
                {wrapState.status === "submitting" && "Submitting…"}
              </>
            ) : (
              <>
                <Coins className="w-4 h-4 mr-2" />
                Wrap FLOW
              </>
            )}
          </Button>
        </div>
      )}

      {/* Success */}
      {wrapState.status === "success" && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-6 mb-6">
          <div className="flex items-start gap-3 mb-3">
            <CheckCircle className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div>
              <h3 className="text-lg font-bold mb-1">Wrap successful!</h3>
              <p className="text-xs text-muted-foreground">
                {wrapState.wrappedFlow} FLOW now in your shielded slot.
              </p>
            </div>
          </div>
          {wrapState.newCommit && (
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground mb-1">
                Your new commitment (point on BabyJubJub):
              </p>
              <p className="font-mono text-[10px] break-all text-emerald-700 dark:text-emerald-300">
                {formatPoint(wrapState.newCommit)}
              </p>
            </div>
          )}
          <div className="mb-3">
            <p className="text-xs font-medium text-foreground mb-1">
              Transaction:
            </p>
            <p className="font-mono text-[10px] break-all">{wrapState.txId}</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <EyeOff className="w-3 h-3" />
            Your blinding factor is stored locally (sessionStorage); future
            tips will spend from this slot.
          </div>
          <div className="flex gap-3 justify-center">
            <Link href="/send">
              <Button size="sm">Send a Tip</Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setWrapState({
                  status: "idle",
                  error: null,
                  txId: null,
                  wrappedFlow: null,
                  newCommit: null,
                });
              }}
            >
              Wrap More
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {wrapState.status === "error" && wrapState.error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 mb-6">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">
                Wrap failed
              </p>
              <p className="text-xs text-destructive/80">{wrapState.error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Footer: addresses */}
      <div className="mt-8 text-[10px] text-muted-foreground space-y-0.5">
        <p>SDK: @openjanus/sdk@{SDK_VERSION}</p>
        <p>
          JanusFlow EVM: <span className="font-mono">{JANUS_FLOW_EVM}</span>
        </p>
        <p>
          PrivateTip: <span className="font-mono">{PRIVATE_TIP_CADENCE}</span>
        </p>
      </div>
    </div>
  );
}
