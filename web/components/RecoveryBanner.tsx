"use client";

/// RecoveryBanner — surfaces two recovery conditions to the user:
///   1. Pending notes in their ShieldedInbox → link to /tips to drain.
///   2. ShieldedCheckpoint not installed → link to /status to activate.
///
/// Rendered globally in client-layout. Dismissible per session (local state).
/// Resolves COA from the Flow Cadence address before querying SDK clients.

import { useState, useEffect } from "react";
import Link from "next/link";
import { ShieldedInboxClient, ShieldedCheckpointClient, getCoaEvmAddress, sdk, getCadenceInboxNotes, TOKEN_REGISTRY } from "@claucondor/sdk";
import { FLOW_CADENCE_ACCESS, CADENCE_DEPLOYER_ADDRESS } from "@claucondor/sdk/network";
import { X } from "lucide-react";

interface RecoveryBannerProps {
  userAddress: string | null;
  onDismiss?: () => void;
}

type BannerMode = "corrupted_checkpoint" | "pending_notes" | "not_activated" | null;

export default function RecoveryBanner({ userAddress, onDismiss }: RecoveryBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState<BannerMode>(null);
  const [pendingCount, setPendingCount] = useState(0n);
  const [corruptedTokens, setCorruptedTokens] = useState<string[]>([]);
  const [cadenceUnavailable, setCadenceUnavailable] = useState(false);

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

        const ibClient = new ShieldedInboxClient();
        const cpClient = new ShieldedCheckpointClient();
        const adapter = sdk.token("flow");

        // "Activated" == has memokey published. ShieldedCheckpoint EVM only
        // exists AFTER the first wrap+update — its absence is NOT a setup gap.
        const [allEvmNotes, flowMeta, musdcMeta, memoKey, cadenceNotes] = await Promise.all([
          hasValidCoa
            ? ibClient.peekAll(coaAddr!).catch(() => [])
            : Promise.resolve([]),
          // Public checkpoint metadata reads (no memoPrivkey needed) — used for cursor filter.
          hasValidCoa
            ? cpClient.metadata(coaAddr!, TOKEN_REGISTRY.flow.proxy).catch(() => null)
            : Promise.resolve(null),
          hasValidCoa
            ? cpClient.metadata(coaAddr!, TOKEN_REGISTRY.mockusdc.proxy).catch(() => null)
            : Promise.resolve(null),
          hasValidCoa
            ? adapter.getMemoKey(coaAddr!).catch(() => null)
            : Promise.resolve(null),
          // Cadence ShieldedInbox (MockFT notes from JanusFT.shieldedTransfer)
          getCadenceInboxNotes(userAddress, {
            flowAccessNode: FLOW_CADENCE_ACCESS,
            inboxContractAddress: CADENCE_DEPLOYER_ADDRESS,
          }).catch((err) => {
            console.warn("[RecoveryBanner] Cadence inbox query failed:", err);
            return null as null;
          }),
        ]);

        if (cancelled) return;

        // Cursor-filtered EVM pending count: exclude notes already consumed by prior claims.
        // Notes at absoluteIndex < lastConsumedNoteIndex are captured in the checkpoint and
        // must not be counted as pending. headOffset=0 invariant holds since drainAll is
        // never called by claimBatchAtomic, so peek array index = absolute storage index.
        const flowCursor  = flowMeta?.lastConsumedNoteIndex  ?? 0n;
        const musdcCursor = musdcMeta?.lastConsumedNoteIndex ?? 0n;
        const evmCount = BigInt(
          allEvmNotes.filter((n, idx) => {
            const absIdx = BigInt(idx);
            const dep = n.depositor.toLowerCase();
            return (
              (dep === TOKEN_REGISTRY.flow.proxy.toLowerCase()     && absIdx >= flowCursor)  ||
              (dep === TOKEN_REGISTRY.mockusdc.proxy.toLowerCase() && absIdx >= musdcCursor)
            );
          }).length
        );

        if (cadenceNotes === null) {
          setCadenceUnavailable(true);
        } else {
          setCadenceUnavailable(false);
        }
        const count = evmCount + (cadenceNotes !== null ? BigInt(cadenceNotes.length) : 0n);
        const hasMemoKey =
          !!memoKey && (memoKey.x !== 0n || memoKey.y !== 0n);

        // Check sessionStorage for corrupted tokens (written by portfolio page).
        let corrupted: string[] = [];
        try {
          corrupted = JSON.parse(sessionStorage.getItem("janus_corrupted_tokens") ?? "[]");
        } catch { /* ignore */ }

        if (corrupted.length > 0) {
          setCorruptedTokens(corrupted);
          setMode("corrupted_checkpoint");
        } else if (count > 0n) {
          setPendingCount(count);
          setMode("pending_notes");
        } else if (!hasMemoKey) {
          setMode("not_activated");
        } else {
          // Memokey published + inbox empty — nothing to surface (no checkpoint
          // doesn't mean "not setup"; it just means no shielded state yet).
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
          ) : mode === "pending_notes" ? (
            <>
              You have{" "}
              <strong className="text-amber-100">{cadenceUnavailable ? "≥ " : ""}{pendingCount.toString()}</strong>{" "}
              pending shielded note{pendingCount !== 1n ? "s" : ""}{cadenceUnavailable ? " (Cadence inbox unavailable)" : ""}.{" "}
              <Link
                href="/portfolio"
                className="underline underline-offset-2 font-medium hover:text-amber-100 transition-colors"
              >
                Claim pending
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
          className={`shrink-0 p-1 rounded ${dismissColor} transition-colors`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
