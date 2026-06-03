"use client";

/// Privacy status checker — paste any Flow address, see if they're ready
/// to receive private tips. Shows COA + MemoKey + balance checks.
///
/// Also serves as the activation flow for new users:
///   Step 1: Sign to derive MemoKey privkey (session-only, deterministic)
///   Step 2: Publish pubkey + set up COA on-chain (one-time)
///
/// Returning users with a fresh session:
///   Single sign: re-derive the same privkey (no new key created)

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import {
  ShieldCheck,
  ShieldAlert,
  Check,
  X,
  ArrowRight,
  Copy,
  Share2,
  Send as Telegram,
  MessageCircle,
  Mail,
  Key,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface StatusResult {
  accountExists: boolean;
  hasCoa: boolean;
  hasMemoKey: boolean;
  coaAddress: string | null;
  error: string | null;
}

function isValidFlowAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(addr.trim());
}

const PRIVATETIP_BASE =
  typeof window !== "undefined" ? window.location.origin : "https://privatetip.condordev.xyz";

function buildInviteMessage(recipient: string): string {
  return `Hey — I want to send you a private tip on PrivateTip (consent-required privacy on Flow). Activate your private inbox here: ${PRIVATETIP_BASE}/status`;
}

// Inline activation state machine for own address
type ActivationStep =
  | "idle"           // not started
  | "step1_pending"  // deriving privkey (wallet signMessage)
  | "step1_done"     // privkey derived, ready for step 2
  | "step2_pending"  // publishing pubkey + COA on-chain
  | "done"           // fully activated
  | "unlock_pending" // re-deriving privkey for existing session (step 1 of 1)
  | "unlock_done";   // session key re-derived

export default function StatusPage() {
  const { user } = useFlowCurrentUser();
  const userAddress = user?.addr ?? null;

  const [address, setAddress] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<StatusResult | null>(null);

  // Inline activation state
  const [activationStep, setActivationStep] = useState<ActivationStep>("idle");
  const [activationError, setActivationError] = useState<string | null>(null);
  // Whether the privkey is in session memory for own address
  const [sessionHasKey, setSessionHasKey] = useState(false);

  // Pre-fill with own wallet on first load.
  useEffect(() => {
    if (userAddress && !address) setAddress(userAddress);
  }, [userAddress, address]);

  // Check session key state when result loads (own address only)
  useEffect(() => {
    if (!userAddress || !result) return;
    const isOwn = userAddress.toLowerCase() === address.trim().toLowerCase();
    if (!isOwn) return;
    import("@/lib/memo-key-session").then(({ getCachedMemoPrivkey }) => {
      setSessionHasKey(getCachedMemoPrivkey(userAddress) !== null);
    });
  }, [userAddress, result, address]);

  const runCheck = useCallback(async (addr: string) => {
    setChecking(true);
    setResult(null);
    setActivationStep("idle");
    setActivationError(null);
    try {
      const { getRecipientMemoPubkey, recipientHasCoa, getCoaEvmAddress } =
        await import("@/lib/tip-actions");

      const [memoPub, hasCoa] = await Promise.all([
        getRecipientMemoPubkey(addr).catch(() => null),
        recipientHasCoa(addr).catch(() => false),
      ]);

      let coaAddress: string | null = null;
      if (hasCoa) {
        try {
          coaAddress = await getCoaEvmAddress(addr);
        } catch {
          // non-fatal
        }
      }

      setResult({
        accountExists: true, // if either check ran without "account not found", account exists
        hasCoa,
        hasMemoKey: memoPub !== null,
        coaAddress,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Check failed";
      setResult({
        accountExists: false,
        hasCoa: false,
        hasMemoKey: false,
        coaAddress: null,
        error: msg,
      });
    } finally {
      setChecking(false);
    }
  }, []);

  // --- Activation handlers (inline, no navigation) ---

  const handleActivateStep1 = useCallback(async () => {
    if (!userAddress) return;
    setActivationStep("step1_pending");
    setActivationError(null);
    try {
      const { getOrDeriveMemoPrivkey } = await import("@/lib/tip-actions");
      await getOrDeriveMemoPrivkey(userAddress);
      setSessionHasKey(true);
      setActivationStep("step1_done");
      toast.success("Private key derived — ready to publish on-chain.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signature failed";
      setActivationError(msg);
      setActivationStep("idle");
      toast.error("Step 1 failed", { description: msg });
    }
  }, [userAddress]);

  const handleActivateStep2 = useCallback(async () => {
    if (!userAddress) return;
    setActivationStep("step2_pending");
    setActivationError(null);
    try {
      const { smartSetupAccount } = await import("@/lib/tip-actions");
      const { txId } = await smartSetupAccount({ flowAddr: userAddress });
      toast.success(`Activated! Tx: ${txId.slice(0, 10)}…`);
      setActivationStep("done");
      // Refresh status check
      await runCheck(userAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setActivationError(msg);
      setActivationStep("step1_done"); // stay at step2 prompt, allow retry
      toast.error("Step 2 failed", { description: msg });
    }
  }, [userAddress, runCheck]);

  const handleUnlock = useCallback(async () => {
    if (!userAddress) return;
    setActivationStep("unlock_pending");
    setActivationError(null);
    try {
      const { getOrDeriveMemoPrivkey } = await import("@/lib/tip-actions");
      await getOrDeriveMemoPrivkey(userAddress);
      setSessionHasKey(true);
      setActivationStep("unlock_done");
      toast.success("Private inbox unlocked for this session.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signature failed";
      setActivationError(msg);
      setActivationStep("idle");
      toast.error("Unlock failed", { description: msg });
    }
  }, [userAddress]);

  // Auto-check when address valid (debounced).
  useEffect(() => {
    if (!isValidFlowAddress(address)) {
      setResult(null);
      return;
    }
    const t = setTimeout(() => runCheck(address.trim()), 350);
    return () => clearTimeout(t);
  }, [address, runCheck]);

  const isOwnAddress =
    userAddress &&
    address &&
    userAddress.toLowerCase() === address.trim().toLowerCase();

  const isReady = result?.hasCoa && result?.hasMemoKey;

  // Share helpers — only relevant when checking someone else's address that needs activation.
  const inviteMsg = buildInviteMessage(address.trim());
  const encodedMsg = encodeURIComponent(inviteMsg);
  const encodedUrl = encodeURIComponent(`${PRIVATETIP_BASE}/status`);

  const shareLinks = [
    {
      label: "X",
      icon: Share2,
      href: `https://twitter.com/intent/tweet?text=${encodedMsg}`,
    },
    {
      label: "Telegram",
      icon: Telegram,
      href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedMsg}`,
    },
    {
      label: "WhatsApp",
      icon: MessageCircle,
      href: `https://wa.me/?text=${encodedMsg}`,
    },
    {
      label: "Email",
      icon: Mail,
      href: `mailto:?subject=Private%20tip%20on%20PrivateTip&body=${encodedMsg}`,
    },
  ];

  const copyInvite = () => {
    navigator.clipboard.writeText(inviteMsg);
    toast.success("Invite message copied");
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#D4AF37]/30 bg-[#D4AF37]/5 text-[10px] uppercase tracking-wider text-[#D4AF37] font-mono">
          <ShieldCheck className="w-3 h-3" />
          Privacy status
        </div>
        <h1
          className="text-4xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          Privacy status check
        </h1>
        <p className="mt-2 text-foreground/70">
          See if a Flow account is ready to receive private tips. Without an
          activated MemoKey, encryption isn&apos;t possible —{" "}
          <strong className="text-foreground">consent-required privacy</strong>.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#0A1628]/60 p-6">
        <label
          htmlFor="address"
          className="block text-sm font-medium text-foreground/80 mb-1.5"
        >
          Flow address
        </label>
        <input
          id="address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x0000000000000000"
          className="w-full px-3 py-2 rounded border border-white/15 bg-white/5 text-sm font-mono text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-[#D4AF37]/40 focus:border-[#D4AF37]/40"
        />
        {address.trim() && !isValidFlowAddress(address) && (
          <p className="mt-1.5 text-xs text-red-300">
            Invalid format — expected 0x + 16 hex characters.
          </p>
        )}
      </div>

      {checking && (
        <div className="mt-4 text-center text-xs text-foreground/50 font-mono">
          checking on-chain…
        </div>
      )}

      {result && !checking && (
        <div className="mt-6 rounded-lg border border-white/10 bg-[#0A1628]/60 p-6 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isReady ? (
                <ShieldCheck className="w-5 h-5 text-[#00EF8B]" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-[#D4AF37]" />
              )}
              <span
                className={`font-semibold ${
                  isReady ? "text-[#00EF8B]" : "text-[#D4AF37]"
                }`}
              >
                {isReady ? "Ready to receive private tips" : "Not yet activated"}
              </span>
            </div>
            <span className="font-mono text-[10px] text-foreground/40">
              {address.trim().slice(0, 8)}…{address.trim().slice(-4)}
            </span>
          </div>

          {/* Checklist */}
          <div className="space-y-2 text-sm">
            <StatusRow
              ok={result.hasCoa}
              label="EVM bridge (COA)"
              hint="Cross-chain account at /public/evm — required to hold wrapped FLOW"
            />
            <StatusRow
              ok={result.hasMemoKey}
              label="MemoKey published"
              hint="BabyJubJub pubkey at /public/openjanusMemoKey — required to encrypt tips"
            />
          </div>

          {result.coaAddress && (
            <div className="text-[10px] font-mono text-foreground/40">
              COA EVM: {result.coaAddress}
            </div>
          )}

          {/* Actions */}
          {!isReady && (
            <div className="pt-3 border-t border-white/10 space-y-3">
              {isOwnAddress ? (
                <InlineActivation
                  step={activationStep}
                  sessionHasKey={sessionHasKey}
                  hasMemoKeyOnChain={result?.hasMemoKey ?? false}
                  error={activationError}
                  onStep1={handleActivateStep1}
                  onStep2={handleActivateStep2}
                  onUnlock={handleUnlock}
                />
              ) : (
                <div>
                  <p className="text-sm text-foreground/70 mb-2">
                    This account hasn&apos;t opted in to receive privately yet.
                    Share an invite so they can activate:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={copyInvite}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/15 bg-white/5 text-xs text-foreground/80 hover:bg-white/10"
                    >
                      <Copy className="w-3 h-3" /> Copy message
                    </button>
                    {shareLinks.map((s) => (
                      <a
                        key={s.label}
                        href={s.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/15 bg-white/5 text-xs text-foreground/80 hover:bg-white/10"
                      >
                        <s.icon className="w-3 h-3" />
                        {s.label}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Activated but session key missing (own address, fully on-chain) */}
          {isReady && isOwnAddress && !sessionHasKey && activationStep !== "unlock_done" && (
            <div className="pt-3 border-t border-white/10">
              <InlineActivation
                step={activationStep}
                sessionHasKey={sessionHasKey}
                hasMemoKeyOnChain={true}
                error={activationError}
                onStep1={handleActivateStep1}
                onStep2={handleActivateStep2}
                onUnlock={handleUnlock}
              />
            </div>
          )}

          {isReady && (isOwnAddress ? sessionHasKey || activationStep === "unlock_done" : true) && (
            <div className="pt-3 border-t border-white/10 flex flex-wrap gap-3">
              <Link
                href="/send"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#00EF8B] hover:text-[#00EF8B]/80"
              >
                {isOwnAddress
                  ? "Send a private tip"
                  : "Send a private tip to this address"}
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
              {isOwnAddress && (
                <Link
                  href="/wrap"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground/50 hover:text-foreground/80"
                >
                  Wrap funds
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {/* Explainer card */}
      <div className="mt-8 rounded-lg border border-white/10 bg-[#0A1628]/40 p-5 text-sm text-foreground/70">
        <p className="font-medium text-foreground mb-1.5 flex items-center gap-1.5">
          <Share2 className="w-3.5 h-3.5 text-[#D4AF37]" />
          Why this check exists
        </p>
        <p>
          PrivateTip encrypts the tipped amount + memo with the recipient&apos;s
          MemoKey (BabyJubJub). Without one published on-chain, there&apos;s no
          key to encrypt to — so tips to unactivated accounts are blocked by
          design, not by bug. We call this{" "}
          <strong className="text-foreground">consent-required privacy</strong>:
          no random transfers, no spam, no funds-lost-forever scenarios.
        </p>
      </div>
    </div>
  );
}

function StatusRow({
  ok,
  label,
  hint,
}: {
  ok: boolean;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {ok ? (
        <span className="shrink-0 w-4 h-4 rounded-full bg-[#00EF8B]/15 flex items-center justify-center mt-0.5">
          <Check className="w-2.5 h-2.5 text-[#00EF8B]" />
        </span>
      ) : (
        <span className="shrink-0 w-4 h-4 rounded-full bg-red-500/15 flex items-center justify-center mt-0.5">
          <X className="w-2.5 h-2.5 text-red-400" />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <span
          className={`font-medium ${
            ok ? "text-foreground" : "text-foreground/60"
          }`}
        >
          {label}
        </span>
        <p className="text-xs text-foreground/50 mt-0.5">{hint}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline activation / unlock component
// ---------------------------------------------------------------------------

function InlineActivation({
  step,
  sessionHasKey,
  hasMemoKeyOnChain,
  error,
  onStep1,
  onStep2,
  onUnlock,
}: {
  step: ActivationStep;
  sessionHasKey: boolean;
  hasMemoKeyOnChain: boolean;
  error: string | null;
  onStep1: () => void;
  onStep2: () => void;
  onUnlock: () => void;
}) {
  // Case: fully activated on-chain, session key missing → unlock flow (1 step)
  if (hasMemoKeyOnChain && !sessionHasKey && step !== "unlock_done") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[#D4AF37]/25 bg-[#D4AF37]/6 px-4 py-3 text-sm">
          <p className="font-medium text-[#D4AF37] mb-1 flex items-center gap-1.5">
            <Key className="w-3.5 h-3.5" />
            Unlock your private inbox for this session
          </p>
          <p className="text-foreground/60 text-xs leading-relaxed">
            Your private key never persists across sessions. Each time you open the app,
            one wallet signature re-derives the <strong className="text-foreground/80">same key</strong> from
            your wallet — deterministic, not a new key. Your public key stays on-chain permanently.
          </p>
        </div>
        <button
          onClick={onUnlock}
          disabled={step === "unlock_pending"}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#D4AF37]/50 bg-[#D4AF37]/10 text-amber-200 text-sm font-medium hover:bg-[#D4AF37]/20 transition-colors disabled:opacity-50"
        >
          {step === "unlock_pending" ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for wallet signature…</>
          ) : (
            <><Key className="w-3.5 h-3.5" /> Unlock with wallet signature (1 click)</>
          )}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // Case: unlock complete
  if (step === "unlock_done") {
    return (
      <div className="rounded-lg border border-[#00EF8B]/25 bg-[#00EF8B]/6 px-4 py-3 text-sm">
        <p className="font-medium text-[#00EF8B] flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" />
          Private inbox unlocked for this session
        </p>
        <p className="text-foreground/60 text-xs mt-0.5">
          Your private key is now in session memory. It will be cleared when you close the tab.
        </p>
      </div>
    );
  }

  // Case: activation done
  if (step === "done") {
    return (
      <div className="rounded-lg border border-[#00EF8B]/25 bg-[#00EF8B]/6 px-4 py-3 text-sm">
        <p className="font-medium text-[#00EF8B] flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" />
          Activated — your private inbox is ready to receive tips.
        </p>
        <div className="flex flex-wrap gap-3 mt-2">
          <Link
            href="/send"
            className="inline-flex items-center gap-1 text-xs text-[#00EF8B] hover:text-[#00EF8B]/80"
          >
            Send a private tip <ArrowRight className="w-3 h-3" />
          </Link>
          <Link
            href="/wrap"
            className="inline-flex items-center gap-1 text-xs text-foreground/50 hover:text-foreground/70"
          >
            Wrap funds <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    );
  }

  // Case: step 1 done, waiting to proceed to step 2
  if (step === "step1_done") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[#00EF8B]/20 bg-[#00EF8B]/5 px-4 py-3 text-xs text-foreground/70">
          <span className="text-[#00EF8B] font-medium">Step 1 complete.</span>{" "}
          Your private key is derived and held in session memory. Now publish your public key on-chain.
        </div>
        <button
          onClick={onStep2}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#00EF8B]/40 bg-[#00EF8B]/10 text-[#00EF8B] text-sm font-medium hover:bg-[#00EF8B]/20 transition-colors"
        >
          <Key className="w-3.5 h-3.5" />
          Activate (Step 2 of 2) — Publish your public key on-chain
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // Case: step 2 pending
  if (step === "step2_pending") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[#00EF8B]/20 bg-[#00EF8B]/5 px-4 py-3 text-xs text-foreground/70">
          <span className="text-[#00EF8B] font-medium">Step 1 complete.</span>{" "}
          Your private key is derived. Publishing public key on-chain…
        </div>
        <button
          disabled
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#00EF8B]/40 bg-[#00EF8B]/10 text-[#00EF8B] text-sm font-medium opacity-50"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Waiting for on-chain confirmation…
        </button>
      </div>
    );
  }

  // Default: step === "idle" or step1_pending — first-time activation
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[#D4AF37]/25 bg-[#D4AF37]/6 px-4 py-3 text-sm">
        <p className="font-medium text-[#D4AF37] mb-1 flex items-center gap-1.5">
          <Key className="w-3.5 h-3.5" />
          Activate your private inbox (2 steps)
        </p>
        <ul className="text-foreground/60 text-xs space-y-1 leading-relaxed">
          <li>
            <strong className="text-foreground/80">Step 1:</strong> Sign to derive your private key
            — one-time deterministic derivation. Same wallet always gives the same key.
          </li>
          <li>
            <strong className="text-foreground/80">Step 2:</strong> Publish your public key on-chain
            (COA + MemoKey). One transaction, gas-only.
          </li>
        </ul>
        <p className="text-foreground/50 text-xs mt-2">
          Your private key never leaves the browser. It lives in session memory only and is cleared
          when the tab closes. Each new session, one wallet signature re-derives the same key.
        </p>
      </div>
      <button
        onClick={onStep1}
        disabled={step === "step1_pending"}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#D4AF37]/50 bg-[#D4AF37]/10 text-amber-200 text-sm font-medium hover:bg-[#D4AF37]/20 transition-colors disabled:opacity-50"
      >
        {step === "step1_pending" ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for wallet signature…</>
        ) : (
          <><Key className="w-3.5 h-3.5" /> Activate (Step 1 of 2) — Sign to derive your private key</>
        )}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
