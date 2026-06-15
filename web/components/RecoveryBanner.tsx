"use client";

/// RecoveryBanner — surfaces two recovery conditions to the user:
///   1. ShieldedCheckpoint corrupted for one or more tokens → link to /portfolio.
///   2. MemoKey not published on-chain → link to /status to activate.
///
/// NOTE: pending_notes mode was removed in v0.8.1-alpha.7 fix sprint.
///
/// Root-cause: getCadenceInboxNotes (Cadence ShieldedInbox read via FCL) is
/// unreliable in the banner context because:
///   a) FCL requires a wallet interaction (unlock) to be fully warm.
///   b) The banner fires on mount, before the user clicks Unlock.
///   c) getCadenceInboxNotes catches any FCL error that includes the string
///      "capabilities.borrow" (present in the Cadence script source) and
///      silently returns [] — so an FCL-not-warm error looks identical to
///      "account has no inbox", producing cadenceCount = 0.
///   d) The banner useEffect only re-runs when userAddress changes, not when
///      the user later unlocks — so the stale count (0 Cadence notes) is
///      never corrected.
///
/// The portfolio page (getPortfolioView) reads the Cadence inbox correctly
/// because it fires only after unlock (FCL warm). Per-card pending counts on
/// /portfolio already surface this information without ambiguity.
///
/// Remaining modes that ARE uniquely surfaced by this banner:
///   - corrupted_checkpoint: written to sessionStorage by portfolio; not shown per-card.
///   - not_activated: checks EVM memoKey (reliable, no FCL query needed).
///
/// Rendered globally in client-layout. Dismissible per session (local state).
/// Resolves COA from the Flow Cadence address before querying EVM.

import { useState, useEffect } from "react";
import Link from "next/link";
import { sdk, getCoaEvmAddress } from "@claucondor/sdk";
import { X } from "lucide-react";

interface RecoveryBannerProps {
  userAddress: string | null;
  onDismiss?: () => void;
}

type BannerMode = "corrupted_checkpoint" | "not_initialized_slots" | "not_activated" | null;

export default function RecoveryBanner({ userAddress, onDismiss }: RecoveryBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState<BannerMode>(null);
  const [corruptedTokens, setCorruptedTokens] = useState<string[]>([]);

  useEffect(() => {
    if (!userAddress) {
      setMode(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const coaAddr = await getCoaEvmAddress(userAddress, "testnet").catch(() => null);
        const hasValidCoa = coaAddr && coaAddr !== "0x" && coaAddr.length >= 5;

        if (cancelled) return;

        // "Activated" == has memokey published on EVM. Pure EVM call — no FCL needed.
        const adapter = sdk.token("flow");
        const memoKey = hasValidCoa
          ? await adapter.getMemoKey(coaAddr!).catch(() => null)
          : null;

        if (cancelled) return;

        const hasMemoKey = !!memoKey && (memoKey.x !== 0n || memoKey.y !== 0n);

        // Check sessionStorage for corrupted tokens (written by portfolio page on load).
        let corrupted: string[] = [];
        try {
          corrupted = JSON.parse(sessionStorage.getItem("janus_corrupted_tokens") ?? "[]");
        } catch { /* ignore */ }

        let notInitialized: string[] = [];
        try {
          notInitialized = JSON.parse(sessionStorage.getItem("janus_not_initialized_tokens") ?? "[]");
        } catch { /* ignore */ }

        // Debug log — operator validates in browser console.
        // pending_notes mode was removed; see per-card counts on /portfolio instead.
        console.log("[RecoveryBanner] hasMemoKey=", hasMemoKey, "corrupted=", corrupted, "notInitialized=", notInitialized, "coaAddr=", coaAddr);

        if (corrupted.length > 0) {
          setCorruptedTokens(corrupted);
          setMode("corrupted_checkpoint");
        } else if (notInitialized.length > 0) {
          setMode("not_initialized_slots");
        } else if (!hasMemoKey) {
          setMode("not_activated");
        } else {
          setMode(null);
        }
      } catch {
        if (!cancelled) setMode(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userAddress]);

  if (!userAddress || dismissed || mode === null) return null;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const bannerColor = mode === "corrupted_checkpoint"
    ? "border-red-700/40 bg-red-950/30"
    : "border-amber-600/30 bg-amber-950/30";
  const textColor = mode === "corrupted_checkpoint" ? "text-red-300" : "text-amber-200";
  const dismissColor = mode === "corrupted_checkpoint"
    ? "text-red-400 hover:text-red-200 hover:bg-red-900/40"
    : "text-amber-400 hover:text-amber-200 hover:bg-amber-900/40";
  // not_initialized_slots uses same amber styling as not_activated

  return (
    <div className={`w-full border-b ${bannerColor} px-4 py-2.5`}>
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className={`text-xs ${textColor} flex-1 min-w-0 truncate sm:whitespace-normal`}>
          {mode === "corrupted_checkpoint" ? (
            <>
              <strong className="text-red-200">Checkpoint corrupted</strong> for{" "}
              {corruptedTokens.join(", ").toUpperCase()}.
              Send and withdraw are disabled.{" "}
              <Link
                href="/portfolio"
                className="underline underline-offset-2 font-medium hover:text-red-100 transition-colors"
              >
                View portfolio
              </Link>{" "}
              for details or contact support.
            </>
          ) : mode === "not_initialized_slots" ? (
            <>
              <strong className="text-amber-200">Shielded slots not initialized.</strong>{" "}
              <Link href="/status" className="underline underline-offset-2 font-medium hover:text-amber-100 transition-colors">
                Run Step 3 in /status
              </Link>{" "}
              to initialize, or wrap funds directly.
            </>
          ) : (
            <>
              Your private state hasn&apos;t been activated.{" "}
              <Link
                href="/status"
                className="underline underline-offset-2 font-medium hover:text-amber-100 transition-colors"
              >
                Set up wallet
              </Link>
            </>
          )}
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={handleDismiss}
          className={`shrink-0 p-1 rounded ${dismissColor} transition-colors`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
