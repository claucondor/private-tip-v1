"use client";

/// Testnet FLOW faucet — get 1 FLOW per IP per 24h.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Droplet, ExternalLink, ArrowRight, Wallet } from "lucide-react";
import { toast } from "sonner";

type ClaimState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; txId: string; explorerUrl: string }
  | { status: "error"; error: string };

interface FaucetInfo {
  enabled: boolean;
  address: string | null;
  amountPerClaim: string;
  cooldownHours: number;
}

function isValidFlowAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(addr.trim());
}

export default function FaucetPage() {
  const { user } = useFlowCurrentUser();
  const userAddress = user?.addr ?? null;

  const [recipient, setRecipient] = useState("");
  const [state, setState] = useState<ClaimState>({ status: "idle" });
  const [info, setInfo] = useState<FaucetInfo | null>(null);

  // Pre-fill with connected wallet address.
  useEffect(() => {
    if (userAddress && !recipient) setRecipient(userAddress);
  }, [userAddress, recipient]);

  // Load faucet config.
  useEffect(() => {
    fetch("/api/faucet")
      .then((r) => r.json())
      .then((data: FaucetInfo) => setInfo(data))
      .catch(() => setInfo({ enabled: false, address: null, amountPerClaim: "1.0", cooldownHours: 24 }));
  }, []);

  const handleClaim = useCallback(async () => {
    if (!isValidFlowAddress(recipient)) {
      toast.error("Invalid Flow address — expected 0x + 16 hex characters");
      return;
    }
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: recipient.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState({ status: "error", error: data.error ?? "Faucet failed" });
        toast.error(data.error ?? "Faucet failed");
        return;
      }
      setState({
        status: "success",
        txId: data.txId,
        explorerUrl: data.explorerUrl,
      });
      toast.success(`${data.amount} FLOW sent`, {
        description: `tx: ${data.txId.slice(0, 12)}…`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setState({ status: "error", error: msg });
      toast.error(msg);
    }
  }, [recipient]);

  const isSubmitting = state.status === "submitting";

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
          <Droplet className="w-3 h-3" />
          Testnet faucet
        </div>
        <h1
          className="text-4xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          Get testnet FLOW
        </h1>
        <p className="mt-2 text-foreground/70">
          Try PrivateTip without spending real money. 1 FLOW per IP, every 24
          hours.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#0A1628]/60 p-6 space-y-4">
        <div>
          <label
            htmlFor="recipient"
            className="block text-sm font-medium text-foreground/80 mb-1.5"
          >
            Your Flow address
          </label>
          <input
            id="recipient"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x0000000000000000"
            disabled={isSubmitting}
            className="w-full px-3 py-2 rounded border border-white/15 bg-white/5 text-sm font-mono text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-[#00EF8B]/40 focus:border-[#00EF8B]/40 disabled:opacity-50"
          />
          {!userAddress && (
            <p className="mt-1.5 text-xs text-foreground/50">
              No wallet connected — paste your testnet address manually, or
              connect from the top-right corner.
            </p>
          )}
        </div>

        <button
          onClick={handleClaim}
          disabled={isSubmitting || !recipient}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-[#00EF8B]/50 bg-[#00EF8B]/10 text-[#00EF8B] font-medium hover:bg-[#00EF8B]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSubmitting ? (
            <>
              <span className="w-3 h-3 border-2 border-[#00EF8B]/40 border-t-[#00EF8B] rounded-full animate-spin" />
              Sending 1 FLOW…
            </>
          ) : (
            <>
              <Droplet className="w-4 h-4" />
              Claim 1 testnet FLOW
            </>
          )}
        </button>

        {state.status === "success" && (
          <div className="mt-3 rounded border border-[#00EF8B]/30 bg-[#00EF8B]/5 p-3 text-sm">
            <p className="text-[#00EF8B] font-medium mb-1">
              Sent — should arrive within ~10 seconds.
            </p>
            <a
              href={state.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-foreground/70 hover:text-foreground"
            >
              View tx on Flowscan <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {state.status === "error" && (
          <div className="mt-3 rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">
            {state.error}
          </div>
        )}
      </div>

      {/* Next step CTA */}
      <div className="mt-8 rounded-lg border border-white/10 bg-[#0A1628]/60 p-6">
        <div className="flex items-start gap-3">
          <Wallet className="w-5 h-5 shrink-0 text-[#D4AF37] mt-0.5" />
          <div className="flex-1">
            <h2 className="font-semibold text-foreground mb-1">
              Got your FLOW? Activate your private wallet.
            </h2>
            <p className="text-sm text-foreground/70 mb-3">
              PrivateTip uses{" "}
              <strong className="text-foreground">consent-required privacy</strong>{" "}
              — recipients must publish a MemoKey before others can tip them
              privately. One signature, one tx.
            </p>
            <Link
              href="/wrap"
              className="inline-flex items-center gap-1.5 text-sm text-[#00EF8B] hover:text-[#00EF8B]/80 font-medium"
            >
              Set up my private wallet <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>

      {info?.address && (
        <p className="mt-6 text-center text-[10px] font-mono text-foreground/40">
          Faucet wallet: {info.address.slice(0, 8)}…{info.address.slice(-6)} ·{" "}
          {info.amountPerClaim} FLOW per claim · {info.cooldownHours}h cooldown
        </p>
      )}
    </div>
  );
}
