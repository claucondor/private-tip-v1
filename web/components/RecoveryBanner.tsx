"use client";

/// RecoveryBanner — surfaces two recovery conditions to the user:
///   1. Pending notes in their ShieldedInbox → link to /tips to drain.
///   2. ShieldedCheckpoint not installed → link to /status to activate.
///
/// Rendered globally in client-layout. Dismissible per session (local state).
/// Resolves COA from the Flow Cadence address before querying SDK clients.

import { useState, useEffect } from "react";
import Link from "next/link";
import { ShieldedCheckpointClient, ShieldedInboxClient, getCoaEvmAddress } from "@claucondor/sdk";
import { X } from "lucide-react";

interface RecoveryBannerProps {
  userAddress: string | null;
  onDismiss?: () => void;
}

type BannerMode = "pending_notes" | "not_activated" | null;

export default function RecoveryBanner({ userAddress, onDismiss }: RecoveryBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState<BannerMode>(null);
  const [pendingCount, setPendingCount] = useState(0n);

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

        const cpClient = new ShieldedCheckpointClient();
        const ibClient = new ShieldedInboxClient();

        const [count, exists] = await Promise.all([
          hasValidCoa
            ? ibClient.count(coaAddr!).catch(() => 0n)
            : Promise.resolve(0n),
          hasValidCoa
            ? cpClient.exists(coaAddr!).catch(() => false)
            : Promise.resolve(false),
        ]);

        if (cancelled) return;

        if (count > 0n) {
          setPendingCount(count);
          setMode("pending_notes");
        } else if (!exists) {
          setMode("not_activated");
        } else {
          // count == 0 AND checkpoint exists — nothing to surface
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

  return (
    <div className="w-full border-b border-amber-600/30 bg-amber-950/30 px-4 py-2.5">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="text-xs text-amber-200 flex-1 min-w-0 truncate sm:whitespace-normal">
          {mode === "pending_notes" ? (
            <>
              You have{" "}
              <strong className="text-amber-100">{pendingCount.toString()}</strong>{" "}
              pending shielded note{pendingCount !== 1n ? "s" : ""}.{" "}
              <Link
                href="/tips"
                className="underline underline-offset-2 font-medium hover:text-amber-100 transition-colors"
              >
                Drain inbox
              </Link>
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
          className="shrink-0 p-1 rounded text-amber-400 hover:text-amber-200 hover:bg-amber-900/40 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
