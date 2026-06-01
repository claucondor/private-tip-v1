"use client";

/// Privacy status checker — paste any Flow address, see if they're ready
/// to receive private tips. Shows COA + MemoKey + balance checks.
///
/// Use cases:
///   1. New user: see their own status, jump to /wrap to fix gaps.
///   2. Sender: check recipient status before sending, or grab an invite
///      link if recipient isn't activated.

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
  return `Hey — I want to send you a private tip on PrivateTip (consent-required privacy on Flow). Activate your private wallet in 1 transaction: ${PRIVATETIP_BASE}/wrap`;
}

export default function StatusPage() {
  const { user } = useFlowCurrentUser();
  const userAddress = user?.addr ?? null;

  const [address, setAddress] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<StatusResult | null>(null);

  // Pre-fill with own wallet on first load.
  useEffect(() => {
    if (userAddress && !address) setAddress(userAddress);
  }, [userAddress, address]);

  const runCheck = useCallback(async (addr: string) => {
    setChecking(true);
    setResult(null);
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
  const encodedUrl = encodeURIComponent(`${PRIVATETIP_BASE}/wrap`);

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
                <Link
                  href="/wrap"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-[#00EF8B] hover:text-[#00EF8B]/80"
                >
                  Activate your private wallet
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
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

          {isReady && (
            <div className="pt-3 border-t border-white/10">
              <Link
                href="/send"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#00EF8B] hover:text-[#00EF8B]/80"
              >
                {isOwnAddress
                  ? "Send a private tip"
                  : "Send a private tip to this address"}
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
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
