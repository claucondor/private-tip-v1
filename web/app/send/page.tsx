/// Send Shielded Tip page — v0.3.
///
/// Flow:
///   1. User connects wallet (useFlowCurrentUser).
///   2. Pre-condition: user must have a shielded balance (wrap N FLOW first).
///      For the demo, the wallet's (balance, blinding) pair is held in
///      sessionStorage under "openjanus:shielded:<addr>". Realistic apps
///      derive it from a wallet-signed message via HKDF.
///   3. User enters recipient Flow address, amount (wei), optional memo.
///   4. Resolve recipient Flow → COA EVM hex.
///   5. Server generates the confidential-transfer Groth16 proof.
///   6. Submit the Cadence transaction that calls JanusFlow.shieldedTransfer
///      and PrivateTip.recordTip atomically.
///   7. Show transaction status + the resulting Pedersen ciphertext (visual
///      proof that the amount is hidden).
///   8. PERSIST the new (balance, blinding) so the user can send another tip.

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Gift,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  EyeOff,
  Shield,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { saveSentMemo } from "@/lib/memo-mirror";
import { useRouter } from "next/navigation";

import {
  isValidFlowAddress,
  isValidFlowAmount,
  getCoaEvmAddress,
  recipientHasCoa,
  sendShieldedTipAction,
  formatPoint,
  parseFlowToWei,
  formatWeiToFlow,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  getRecipientMemoPubkey,
  type Point,
} from "@/lib/tip-actions";
import { emitRecoverySelfTip } from "@/lib/recovery";

// --- Local-storage helpers for (balance, blinding) -----------------------------

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

// --- Types ---------------------------------------------------------------------

type SendStatus =
  | "idle"
  | "needs_wrap"
  | "validating"
  | "resolving_coa"
  | "building_proof"
  | "submitting"
  | "success"
  | "error";

interface SendState {
  status: SendStatus;
  error: string | null;
  txId: string | null;
  newCommit: Point | null;
}

// --- Component -----------------------------------------------------------------

export default function SendTipPage() {
  const router = useRouter();
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const addSentTip = useAppStore((s) => s.addSentTip);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  // Recipient COA validation (debounced on recipient change). Three states:
  //   null      — not checked yet (input invalid or empty)
  //   true      — recipient has a COA at /public/evm; they can unwrap
  //   false     — no COA; warn user (override possible)
  const [recipientCoaOk, setRecipientCoaOk] = useState<boolean | null>(null);
  const [recipientCoaChecking, setRecipientCoaChecking] = useState(false);
  // Same three-state for MemoKey published at /public/openjanusMemoKey.
  // Drives whether the memo input is enabled and what helper text shows.
  const [recipientMemoOk, setRecipientMemoOk] = useState<boolean | null>(null);
  // Set to true once the user has acknowledged the "no COA" warning,
  // letting them proceed with the send.
  const [coaWarningAcknowledged, setCoaWarningAcknowledged] = useState(false);

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [sendState, setSendState] = useState<SendState>({
    status: "idle",
    error: null,
    txId: null,
    newCommit: null,
  });

  // Debounced recipient-COA + MemoKey check. Runs whenever the recipient field
  // becomes a syntactically valid Flow address, so we can surface BOTH the
  // "no COA" warning AND the "no MemoKey → memo disabled" hint BEFORE the
  // user clicks Send.
  useEffect(() => {
    setCoaWarningAcknowledged(false);
    if (!isValidFlowAddress(recipient)) {
      setRecipientCoaOk(null);
      setRecipientMemoOk(null);
      return;
    }
    let cancelled = false;
    setRecipientCoaChecking(true);
    const t = setTimeout(async () => {
      try {
        const [coaOk, memoPub] = await Promise.all([
          recipientHasCoa(recipient),
          getRecipientMemoPubkey(recipient),
        ]);
        if (!cancelled) {
          setRecipientCoaOk(coaOk);
          setRecipientMemoOk(memoPub !== null);
        }
      } catch {
        if (!cancelled) {
          setRecipientCoaOk(false);
          setRecipientMemoOk(false);
        }
      } finally {
        if (!cancelled) setRecipientCoaChecking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [recipient]);

  // If the resolved recipient has no MemoKey, drop any stale memo the user
  // typed before changing the recipient — prevents the SDK from throwing
  // "recipientMemoPubkey is required" on submit.
  useEffect(() => {
    if (recipientMemoOk === false && memo.length > 0) {
      setMemo("");
    }
  }, [recipientMemoOk, memo]);

  // Load shielded state on user-change.
  useEffect(() => {
    if (!userAddress) return;
    const s = loadShieldedState(userAddress);
    if (!s) {
      setSendState({
        status: "needs_wrap",
        error: null,
        txId: null,
        newCommit: null,
      });
    } else {
      setShielded(s);
      setSendState({
        status: "idle",
        error: null,
        txId: null,
        newCommit: null,
      });
    }
  }, [userAddress]);

  const handleSendTip = useCallback(async () => {
    if (!userAddress || !shielded) {
      toast.error("Wallet not connected or shielded balance missing.");
      return;
    }

    setSendState({ status: "validating", error: null, txId: null, newCommit: null });

    if (!isValidFlowAddress(recipient)) {
      setSendState({
        status: "error",
        error: "Invalid recipient Flow address (must be 0x + 16 hex).",
        txId: null,
        newCommit: null,
      });
      return;
    }
    if (!isValidFlowAmount(amount)) {
      setSendState({
        status: "error",
        error: "Invalid amount.",
        txId: null,
        newCommit: null,
      });
      return;
    }
    if (recipient.toLowerCase() === userAddress.toLowerCase()) {
      setSendState({
        status: "error",
        error: "Cannot send a shielded tip to yourself (EVM contract forbids).",
        txId: null,
        newCommit: null,
      });
      return;
    }

    // Block send if recipient has no COA AND the user hasn't acknowledged
    // the warning. The transferred FLOW would land in a COA address the
    // recipient doesn't control — they would need to set up a COA later to
    // unwrap. We let them proceed if they explicitly accept the risk
    // (e.g. they're sending to themselves on a fresh wallet they'll later
    // set up). recipientCoaOk === null means we never finished checking;
    // in that case we run a synchronous check here.
    let coaOk = recipientCoaOk;
    if (coaOk === null) {
      coaOk = await recipientHasCoa(recipient);
      setRecipientCoaOk(coaOk);
    }
    if (!coaOk && !coaWarningAcknowledged) {
      setSendState({
        status: "error",
        error:
          "Recipient has no COA at /public/evm. They cannot unwrap this tip until they set one up. Acknowledge the warning below to proceed anyway.",
        txId: null,
        newCommit: null,
      });
      return;
    }

    const amountWei = parseFlowToWei(amount);
    const oldBalanceWei = BigInt(shielded.balanceWei);
    if (amountWei > oldBalanceWei) {
      setSendState({
        status: "error",
        error: `Insufficient shielded balance: have ${formatWeiToFlow(oldBalanceWei)} FLOW, need ${amount} FLOW.`,
        txId: null,
        newCommit: null,
      });
      return;
    }

    setSendState({
      status: "resolving_coa",
      error: null,
      txId: null,
      newCommit: null,
    });

    let recipientCoaHex: string;
    try {
      recipientCoaHex = await getCoaEvmAddress(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "COA resolution failed";
      setSendState({
        status: "error",
        error: msg,
        txId: null,
        newCommit: null,
      });
      return;
    }

    // v0.4.4: a recipient MemoKey is REQUIRED for every shielded transfer —
    // not just when the user types a memo. The encrypted ShieldedNote that
    // accompanies each tip carries (amount, transferBlinding) plus the
    // optional memo text; without a MemoKey the recipient could never decrypt
    // those values and the tip would brick (commitment lands on-chain but
    // never unwrappable). Refuse to send if MemoKey isn't published.
    const recipientMemoPubkey = await getRecipientMemoPubkey(recipient);
    if (!recipientMemoPubkey) {
      setSendState({
        status: "error",
        error:
          "Recipient has no MemoKey published. Without it they cannot unwrap. Ask them to run setup (Wrap page) first.",
        txId: null,
        newCommit: null,
      });
      return;
    }

    setSendState({
      status: "building_proof",
      error: null,
      txId: null,
      newCommit: null,
    });

    try {
      setSendState({
        status: "submitting",
        error: null,
        txId: null,
        newCommit: null,
      });
      const result = await sendShieldedTipAction({
        recipientFlowAddr: recipient,
        recipientCoaHex,
        transferAmountWei: amountWei,
        oldBalanceWei,
        oldBlinding: BigInt(shielded.blinding),
        memo: memo || undefined,
        recipientMemoPubkey,
      });

      // PERSIST new (balance, blinding) so next tip works.
      const newState: ShieldedState = {
        balanceWei: result.newBalanceWei.toString(),
        blinding: result.newBlinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      // Emit a recovery carbon-copy: record the POST-SEND RESIDUAL as a
      // self-tip so it can be recovered from chain on any device. The residual
      // is (newBalanceWei, newBlinding) — i.e. what's left after this send.
      // Non-fatal if it fails — localStorage state is still correct.
      try {
        const myPubkey = await getRecipientMemoPubkey(userAddress);
        if (myPubkey && result.newBalanceWei > 0n) {
          await emitRecoverySelfTip({
            amount: result.newBalanceWei,
            blinding: result.newBlinding,
            kind: "residual",
            myPubkey,
          });
        }
      } catch {
        // Non-fatal — recovery self-tip failed; localStorage is still correct.
      }

      addSentTip({
        tipID: Date.now(),
        sender: userAddress,
        recipient,
        timestamp: new Date().toISOString(),
        memo: memo || null,
        claimed: false,
      });

      // Persist plaintext memo locally so the sender can read it back from
      // /tips. The on-chain ciphertext is encrypted to the recipient only.
      if (memo && memo.length > 0) {
        saveSentMemo({ sender: userAddress, recipient, memo });
      }

      setSendState({
        status: "success",
        error: null,
        txId: result.txId,
        newCommit: result.newCommit,
      });
      toast.success("Shielded tip sent!", {
        description: "Amount is HIDDEN on-chain. Ciphertext shown below.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      setSendState({
        status: "error",
        error: msg,
        txId: null,
        newCommit: null,
      });
      toast.error("Send failed", { description: msg });
    }
  }, [
    userAddress,
    shielded,
    recipient,
    amount,
    memo,
    addSentTip,
    recipientCoaOk,
    coaWarningAcknowledged,
  ]);

  const isSubmitting =
    sendState.status === "validating" ||
    sendState.status === "resolving_coa" ||
    sendState.status === "building_proof" ||
    sendState.status === "submitting";

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
          <div className="w-16 h-16 rounded-2xl bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_15%,transparent)]">
            <Gift className="w-8 h-8 text-[#00EF8B]" />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Connect your wallet to send shielded tips.
          </p>
          <Button onClick={() => authenticate()} size="lg">
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  // Needs wrap screen — pre-condition for the new orchestrator architecture.
  if (sendState.status === "needs_wrap") {
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
          <div className="w-10 h-10 rounded-lg bg-[#B45309]/15 border border-[#B45309]/30 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-[#B45309]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Wrap First</h1>
            <p className="text-sm text-muted-foreground">
              v0.3 orchestrator requires a pre-funded shielded slot
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20 p-6 space-y-4">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            <strong>Pre-condition:</strong> PrivateTip v0.3 is a pure
            orchestrator over JanusFlow. Per-tip escrow is gone. To send
            shielded tips you must first wrap N FLOW into your JanusFlow
            shielded slot.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            The wrap is a one-time visible deposit (msg.value boundary).
            Subsequent tips draw down your shielded balance, with amounts
            hidden by Pedersen commitments.
          </p>
          <Link href="/wrap">
            <Button size="sm" className="w-full">
              Open Wrap page
            </Button>
          </Link>
          <p className="text-[10px] text-muted-foreground">
            Alternative: run <code className="font-mono">node scripts/v03-smoke.mjs</code>{" "}
            from the CLI for fully-automated wrap.
          </p>
          <div className="border-t border-amber-200 dark:border-amber-800 pt-4">
            <p className="text-xs text-muted-foreground mb-2">
              MVP shortcut: paste your current shielded state
            </p>
            <PasteShieldedStateForm
              addr={userAddress!}
              onSaved={(s) => {
                setShielded(s);
                setSendState({
                  status: "idle",
                  error: null,
                  txId: null,
                  newCommit: null,
                });
              }}
            />
          </div>
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
        <div className="w-10 h-10 rounded-lg bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#00EF8B_12%,transparent)]">
          <Gift className="w-5 h-5 text-[#00EF8B]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Send a private tip</h1>
          <p className="text-sm text-muted-foreground">
            The amount is hidden. People can see who sent it and when, but not how much.
          </p>
        </div>
      </div>

      {/* Shielded balance summary */}
      {shielded && (
        <div className="mb-6 rounded-xl border border-[#00EF8B]/30 bg-[#00EF8B]/5 p-4">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-[#00EF8B] shrink-0 mt-0.5" />
            <div className="text-xs flex-1">
              <p className="font-medium text-foreground mb-1">
                Your shielded balance (local-known)
              </p>
              <p className="text-sm text-[#00EF8B] font-mono">
                {formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                (decryptable with your locally-stored blinding;
                on-chain only the Pedersen commit point is visible)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Form */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Recipient (Flow address)
          </label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 text-sm font-mono border rounded bg-background"
            disabled={isSubmitting || sendState.status === "success"}
          />
          {/* COA validator: surfaces "no COA" risk BEFORE submit. */}
          {isValidFlowAddress(recipient) && (
            <div className="mt-2">
              {recipientCoaChecking && (
                <p className="text-[10px] text-muted-foreground">
                  Checking recipient COA…
                </p>
              )}
              {!recipientCoaChecking && recipientCoaOk === true && (
                <p className="text-[10px] text-[#00EF8B]">
                  ✓ Recipient is ready to claim tips.
                </p>
              )}
              {!recipientCoaChecking && recipientCoaOk === false && (
                <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/30 p-2 mt-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-amber-800 dark:text-amber-200 space-y-1">
                      <p className="font-medium">
                        Recipient hasn&apos;t opened the app yet.
                      </p>
                      <p>
                        They&apos;ll need to connect, click &quot;Enable&quot;
                        and set up before they can claim. The FLOW waits
                        privately for them in the meantime.
                      </p>
                      <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={coaWarningAcknowledged}
                          onChange={(e) =>
                            setCoaWarningAcknowledged(e.target.checked)
                          }
                          className="h-3 w-3"
                        />
                        <span>Send anyway — I understand the risk.</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Amount (FLOW)
          </label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 1.5"
            className="w-full px-3 py-2 text-sm border rounded bg-background"
            disabled={isSubmitting || sendState.status === "success"}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Amount HIDDEN on-chain. You know what you sent. Recipient sees only their AGGREGATED balance (sum of all tips received) — never per-sender amounts. This is the feature for tips.
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Memo (optional, max 280 chars)
          </label>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={
              recipientMemoOk === false
                ? "Disabled — recipient has no MemoKey"
                : "Thanks for the tip!"
            }
            maxLength={280}
            className="w-full px-3 py-2 text-sm border rounded bg-background disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={
              isSubmitting ||
              sendState.status === "success" ||
              recipientMemoOk === false
            }
          />
          {recipientMemoOk === true && (
            <p className="text-[10px] text-[#00EF8B] mt-1">
              ✓ Your memo + amount get encrypted just for the recipient. Only they can read them, and they need them to claim the tip.
            </p>
          )}
          {recipientMemoOk === false && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1">
              Recipient hasn&apos;t enabled their private inbox yet. Send is blocked — they wouldn&apos;t be able to claim the tip. Ask them to open the app and click &quot;Enable&quot;.
            </p>
          )}
          {recipientMemoOk === null && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Every tip carries an encrypted note — recipient needs it to read the memo and claim the funds.
            </p>
          )}
        </div>
        <Button
          onClick={handleSendTip}
          className="w-full"
          size="lg"
          disabled={
            isSubmitting ||
            sendState.status === "success" ||
            !shielded ||
            recipientMemoOk === false
          }
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              {sendState.status === "validating" && "Validating…"}
              {sendState.status === "resolving_coa" && "Resolving recipient COA…"}
              {sendState.status === "building_proof" && "Generating Groth16 proof…"}
              {sendState.status === "submitting" && "Submitting…"}
            </>
          ) : (
            <>
              <Shield className="w-4 h-4 mr-2" />
              Send Shielded Tip
            </>
          )}
        </Button>
      </div>

      {/* Success: show ciphertext (visual proof of hiding) */}
      {sendState.status === "success" && sendState.newCommit && (
        <div className="mt-6 rounded-xl border border-[#00EF8B]/30 bg-[#00EF8B]/8 p-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_12%,transparent)]">
          <div className="flex items-start gap-3 mb-3">
            <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
            <div>
              <h3 className="text-lg font-bold mb-1">Shielded tip sent!</h3>
              <p className="text-xs text-muted-foreground">
                Amount HIDDEN on calldata, events, and storage. Only the
                Pedersen commit point updated on-chain.
              </p>
            </div>
          </div>
          <div className="mb-3">
            <p className="text-xs font-medium text-foreground mb-1">
              Your new residual commitment (point on BabyJubJub):
            </p>
            <p className="font-mono text-[10px] break-all text-[#00EF8B]">
              {formatPoint(sendState.newCommit)}
            </p>
          </div>
          <div className="mb-3">
            <p className="text-xs font-medium text-foreground mb-1">Transaction:</p>
            <p className="font-mono text-[10px] break-all">{sendState.txId}</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
            <EyeOff className="w-3 h-3" />
            Amount cryptographically hidden via Pedersen commitment
          </div>
          <div className="flex gap-3 justify-center">
            <Button variant="outline" size="sm" onClick={() => router.push("/tips")}>
              View My Tips
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setSendState({
                  status: "idle",
                  error: null,
                  txId: null,
                  newCommit: null,
                });
                setRecipient("");
                setAmount("");
                setMemo("");
              }}
            >
              Send Another
            </Button>
          </div>
        </div>
      )}

      {sendState.status === "error" && sendState.error && (
        <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">Send failed</p>
              <p className="text-xs text-destructive/80">{sendState.error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Footer: addresses */}
      <div className="mt-8 text-[10px] text-muted-foreground space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

// --- Paste-shielded-state form (MVP escape hatch) -----------------------------

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
