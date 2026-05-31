/// Send Shielded Tip page — v0.3 + Janus dark theme redesign.
///
/// IMPORTANT — all business logic unchanged. Only visual layer updated.

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
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
import { encryptSnapshotToSelf } from "@/lib/recovery";
import { ShieldedNoteEncrypt } from "@/components/animations/ShieldedNoteEncrypt";

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

// --- Types ------------------------------------------------------------------

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

// --- Component --------------------------------------------------------------

export default function SendTipPage() {
  const router = useRouter();
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const addSentTip = useAppStore((s) => s.addSentTip);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const [recipientCoaOk, setRecipientCoaOk] = useState<boolean | null>(null);
  const [recipientCoaChecking, setRecipientCoaChecking] = useState(false);
  const [recipientMemoOk, setRecipientMemoOk] = useState<boolean | null>(null);
  const [coaWarningAcknowledged, setCoaWarningAcknowledged] = useState(false);

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [sendState, setSendState] = useState<SendState>({
    status: "idle",
    error: null,
    txId: null,
    newCommit: null,
  });

  const [showEncryptAnim, setShowEncryptAnim] = useState(false);

  // Debounced recipient-COA + MemoKey check
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
    return () => { cancelled = true; clearTimeout(t); };
  }, [recipient]);

  useEffect(() => {
    if (recipientMemoOk === false && memo.length > 0) setMemo("");
  }, [recipientMemoOk, memo]);

  useEffect(() => {
    if (!userAddress) return;
    const s = loadShieldedState(userAddress);
    if (!s) {
      setSendState({ status: "needs_wrap", error: null, txId: null, newCommit: null });
    } else {
      setShielded(s);
      setSendState({ status: "idle", error: null, txId: null, newCommit: null });
    }
  }, [userAddress]);

  const handleSendTip = useCallback(async () => {
    if (!userAddress || !shielded) {
      toast.error("Wallet not connected or shielded balance missing.");
      return;
    }

    // Show encryption animation at the moment of send
    setShowEncryptAnim(true);

    setSendState({ status: "validating", error: null, txId: null, newCommit: null });

    if (!isValidFlowAddress(recipient)) {
      setSendState({ status: "error", error: "Invalid recipient Flow address (must be 0x + 16 hex).", txId: null, newCommit: null });
      return;
    }
    if (!isValidFlowAmount(amount)) {
      setSendState({ status: "error", error: "Invalid amount.", txId: null, newCommit: null });
      return;
    }
    if (recipient.toLowerCase() === userAddress.toLowerCase()) {
      setSendState({ status: "error", error: "Cannot send a shielded tip to yourself (EVM contract forbids).", txId: null, newCommit: null });
      return;
    }

    let coaOk = recipientCoaOk;
    if (coaOk === null) {
      coaOk = await recipientHasCoa(recipient);
      setRecipientCoaOk(coaOk);
    }
    if (!coaOk && !coaWarningAcknowledged) {
      setSendState({
        status: "error",
        error: "Recipient has no COA at /public/evm. They cannot unwrap this tip until they set one up. Acknowledge the warning below to proceed anyway.",
        txId: null, newCommit: null,
      });
      return;
    }

    const amountWei = parseFlowToWei(amount);
    const oldBalanceWei = BigInt(shielded.balanceWei);
    if (amountWei > oldBalanceWei) {
      setSendState({
        status: "error",
        error: `Insufficient shielded balance: have ${formatWeiToFlow(oldBalanceWei)} FLOW, need ${amount} FLOW.`,
        txId: null, newCommit: null,
      });
      return;
    }

    setSendState({ status: "resolving_coa", error: null, txId: null, newCommit: null });

    let recipientCoaHex: string;
    try {
      recipientCoaHex = await getCoaEvmAddress(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "COA resolution failed";
      setSendState({ status: "error", error: msg, txId: null, newCommit: null });
      return;
    }

    const recipientMemoPubkey = await getRecipientMemoPubkey(recipient);
    if (!recipientMemoPubkey) {
      setSendState({
        status: "error",
        error: "Recipient has no MemoKey published. Without it they cannot unwrap. Ask them to run setup (Wrap page) first.",
        txId: null, newCommit: null,
      });
      return;
    }

    setSendState({ status: "building_proof", error: null, txId: null, newCommit: null });

    try {
      setSendState({ status: "submitting", error: null, txId: null, newCommit: null });

      let snapshotCt: Uint8Array | undefined;
      let snapshotEphX: bigint | undefined;
      let snapshotEphY: bigint | undefined;
      let myPubkeyForSnap: { x: bigint; y: bigint } | null = null;
      try {
        myPubkeyForSnap = await getRecipientMemoPubkey(userAddress);
      } catch { /* non-fatal */ }

      const result = await sendShieldedTipAction({
        recipientFlowAddr: recipient,
        recipientCoaHex,
        transferAmountWei: amountWei,
        oldBalanceWei,
        oldBlinding: BigInt(shielded.blinding),
        memo: memo || undefined,
        recipientMemoPubkey,
      });

      if (myPubkeyForSnap) {
        try {
          const snap = await encryptSnapshotToSelf(
            { balance: result.newBalanceWei, blinding: result.newBlinding },
            myPubkeyForSnap
          );
          snapshotCt = snap.ciphertext;
          snapshotEphX = snap.ephPubkey.x;
          snapshotEphY = snap.ephPubkey.y;
        } catch { /* non-fatal */ }
      }
      void snapshotCt; void snapshotEphX; void snapshotEphY;

      const newState: ShieldedState = {
        balanceWei: result.newBalanceWei.toString(),
        blinding: result.newBlinding.toString(),
      };
      saveShieldedState(userAddress, newState);
      setShielded(newState);

      addSentTip({
        tipID: Date.now(),
        sender: userAddress,
        recipient,
        timestamp: new Date().toISOString(),
        memo: memo || null,
        claimed: false,
      });

      if (memo && memo.length > 0) {
        saveSentMemo({ sender: userAddress, recipient, memo });
      }

      setSendState({ status: "success", error: null, txId: result.txId, newCommit: result.newCommit });
      toast.success("Shielded tip sent!", { description: "Amount is HIDDEN on-chain. Ciphertext shown below." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      setShowEncryptAnim(false);
      setSendState({ status: "error", error: msg, txId: null, newCommit: null });
      toast.error("Send failed", { description: msg });
    }
  }, [userAddress, shielded, recipient, amount, memo, addSentTip, recipientCoaOk, coaWarningAcknowledged]);

  const isSubmitting =
    sendState.status === "validating" ||
    sendState.status === "resolving_coa" ||
    sendState.status === "building_proof" ||
    sendState.status === "submitting";

  // Unauthenticated
  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#00EF8B]/12 border border-[#00EF8B]/25 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_12%,transparent)]">
            <Gift className="w-8 h-8 text-[#00EF8B]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">Connect your wallet to send shielded tips.</p>
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

  // Needs wrap screen
  if (sendState.status === "needs_wrap") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-[#B45309]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Wrap First</h1>
            <p className="text-sm text-foreground/50">PrivateTip requires a pre-funded shielded slot.</p>
          </div>
        </div>

        <div className="rounded-xl border border-[#B45309]/20 bg-[#B45309]/5 p-6 space-y-4">
          <p className="text-sm text-amber-200/80">
            <strong className="text-amber-200">Pre-condition:</strong> PrivateTip requires a pre-funded shielded slot. To send shielded tips you must first wrap N FLOW into your JanusFlow shielded slot.
          </p>
          <p className="text-xs text-amber-200/50">
            The wrap is a one-time visible deposit (msg.value boundary). Subsequent tips draw down your shielded balance with amounts hidden by Pedersen commitments.
          </p>
          <Link href="/wrap">
            <motion.span
              whileHover={{ scale: 1.01, y: -1 }}
              whileTap={{ scale: 0.99 }}
              className="janus-button-primary w-full py-3 rounded-xl text-sm flex items-center justify-center cursor-pointer mt-2"
            >
              Open Wrap page
            </motion.span>
          </Link>
          <div className="border-t border-white/8 pt-4">
            <p className="text-xs text-foreground/30 mb-2">MVP shortcut: paste your current shielded state</p>
            <PasteShieldedStateForm
              addr={userAddress!}
              onSaved={(s) => {
                setShielded(s);
                setSendState({ status: "idle", error: null, txId: null, newCommit: null });
              }}
            />
          </div>
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
        <div className="w-10 h-10 rounded-lg bg-[#6B46C1]/12 border border-[#6B46C1]/25 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#6B46C1_10%,transparent)]">
          <Gift className="w-5 h-5 text-[#6B46C1]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Send a private tip</h1>
          <p className="text-sm text-foreground/50">The amount is hidden. People can see who sent it — not how much.</p>
        </div>
      </motion.div>

      {/* Shielded balance */}
      {shielded && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE, delay: 0.05 }}
          className="mb-6 rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/5 p-4"
        >
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-[#00EF8B] shrink-0 mt-0.5" />
            <div className="text-xs flex-1">
              <p className="font-medium text-foreground/70 mb-1">Your shielded balance (local-known)</p>
              <p className="text-sm text-[#00EF8B] font-mono">{formatWeiToFlow(BigInt(shielded.balanceWei), 4)} FLOW</p>
              <p className="text-[10px] text-foreground/30 mt-1">
                (decryptable with your locally-stored blinding; on-chain only the Pedersen commit point is visible)
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Pre-send encryption animation */}
      <ShieldedNoteEncrypt
        trigger={showEncryptAnim && sendState.status !== "success"}
        success={false}
        onDismiss={() => setShowEncryptAnim(false)}
      />

      {/* Form */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.08 }}
        className="rounded-xl border border-[#6B46C1]/20 janus-purple-glow bg-[#0D1E38]/80 p-6 space-y-4"
      >
        <div>
          <label className="text-xs font-medium text-foreground/50 mb-1 block">Recipient (Flow address)</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
            className="janus-input font-mono"
            disabled={isSubmitting || sendState.status === "success"}
          />
          {/* COA validator */}
          {isValidFlowAddress(recipient) && (
            <div className="mt-2">
              {recipientCoaChecking && (
                <p className="text-[10px] text-foreground/40">Checking recipient COA…</p>
              )}
              {!recipientCoaChecking && recipientCoaOk === true && (
                <p className="text-[10px] text-[#00EF8B]">✓ Recipient is ready to claim tips.</p>
              )}
              {!recipientCoaChecking && recipientCoaOk === false && (
                <div className="rounded-lg border border-[#B45309]/30 bg-[#B45309]/8 p-2 mt-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-amber-200/70 space-y-1">
                      <p className="font-medium text-amber-200">Recipient hasn&apos;t opened the app yet.</p>
                      <p>They&apos;ll need to connect, click &quot;Enable&quot; and set up before they can claim. The FLOW waits privately for them.</p>
                      <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={coaWarningAcknowledged}
                          onChange={(e) => setCoaWarningAcknowledged(e.target.checked)}
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
          <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount (FLOW)</label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 1.5"
            className="janus-input"
            disabled={isSubmitting || sendState.status === "success"}
          />
          <p className="text-[10px] text-foreground/30 mt-1">
            Amount HIDDEN on-chain. Recipient sees only their aggregated balance — never per-sender amounts.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-foreground/50 block">Memo (optional, max 280 chars)</label>
            <span className="text-[10px] font-mono text-foreground/40">{memo.length}/280</span>
          </div>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={recipientMemoOk === false ? "Disabled — recipient has no MemoKey" : "Thanks for the tip!"}
            maxLength={280}
            className="janus-input disabled:opacity-40"
            disabled={isSubmitting || sendState.status === "success" || recipientMemoOk === false}
          />
          {recipientMemoOk === true && (
            <p className="text-[10px] text-[#00EF8B] mt-1">✓ Your memo + amount get encrypted just for the recipient.</p>
          )}
          {recipientMemoOk === false && (
            <p className="text-[10px] text-amber-400/70 mt-1">Recipient hasn&apos;t enabled their private inbox yet. Send is blocked — they wouldn&apos;t be able to claim the tip.</p>
          )}
          {recipientMemoOk === null && (
            <p className="text-[10px] text-foreground/30 mt-1">Every tip carries an encrypted note — recipient needs it to read the memo and claim the funds.</p>
          )}
        </div>

        <motion.button
          onClick={handleSendTip}
          disabled={isSubmitting || sendState.status === "success" || !shielded || recipientMemoOk === false}
          whileHover={!isSubmitting && !!shielded && recipientMemoOk !== false ? { scale: 1.01, y: -1 } : {}}
          whileTap={{ scale: 0.99 }}
          className="janus-button-primary w-full py-3 rounded-xl text-base disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: !isSubmitting ? undefined : "#00EF8B" }}
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {sendState.status === "validating" && "Validating…"}
              {sendState.status === "resolving_coa" && "Resolving recipient COA…"}
              {sendState.status === "building_proof" && "Generating Groth16 proof…"}
              {sendState.status === "submitting" && "Submitting…"}
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Shield className="w-4 h-4" />
              Send Shielded Tip
            </span>
          )}
        </motion.button>
      </motion.div>

      {/* Success */}
      {sendState.status === "success" && sendState.newCommit && (
        <>
          <ShieldedNoteEncrypt trigger={true} success={true} onDismiss={() => {}} />
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="mt-6 rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/8 p-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_8%,transparent)]"
          >
            <div className="flex items-start gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
              <div>
                <h3 className="text-lg font-bold mb-1 text-foreground">Shielded tip sent!</h3>
                <p className="text-xs text-foreground/50">Amount HIDDEN on calldata, events, and storage. Only the Pedersen commit point updated on-chain.</p>
              </div>
            </div>
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground/60 mb-1">Your new residual commitment (point on BabyJubJub):</p>
              <p className="font-mono text-[10px] break-all text-[#00EF8B]/70">{formatPoint(sendState.newCommit)}</p>
            </div>
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground/60 mb-1">Transaction:</p>
              <p className="font-mono text-[10px] break-all text-foreground/40">{sendState.txId}</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-foreground/40 mb-4">
              <EyeOff className="w-3 h-3" />
              Amount cryptographically hidden via Pedersen commitment
            </div>
            <div className="flex gap-3 justify-center">
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => router.push("/tips")}
                className="px-4 py-2 rounded-lg border border-white/12 bg-white/5 text-foreground/70 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                View My Tips
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setSendState({ status: "idle", error: null, txId: null, newCommit: null });
                  setRecipient(""); setAmount(""); setMemo("");
                  setShowEncryptAnim(false);
                }}
                className="janus-button-primary px-4 py-2 rounded-lg text-sm"
              >
                Send Another
              </motion.button>
            </div>
          </motion.div>
        </>
      )}

      {/* Error */}
      {sendState.status === "error" && sendState.error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-lg border border-red-500/20 bg-red-950/20 p-4"
        >
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300 mb-1">Send failed</p>
              <p className="text-xs text-red-400/70">{sendState.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Footer */}
      <div className="mt-8 text-[10px] text-foreground/20 space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono break-all">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono break-all">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

// --- Paste-shielded-state form -----------------------------------------------

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
