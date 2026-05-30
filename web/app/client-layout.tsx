"use client";

/// Client-side layout wrapper — provides FlowProvider and toast notifications.
///
/// Split from layout.tsx because metadata must be exported from a Server
/// Component, while FlowProvider needs "use client".

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FlowProvider, useFlowCurrentUser } from "@onflow/react-sdk";
import { Toaster } from "sonner";
import { toast } from "sonner";
import { Key, RefreshCw, AlertTriangle } from "lucide-react";
import { flowConfig } from "@/lib/fcl-config";
import ConnectWallet from "@/components/ConnectWallet";
import flowJSON from "../../flow.json";

// ---------------------------------------------------------------------------
// Recovery banner — bidirectional sync detector.
// Three modes:
//   "recover"     — blue: localStorage empty + chain has state → offer Recover
//   "stale-local" — yellow: localStorage has state that doesn't match chain
//                   (admin reset, stale session, etc.) → offer Clear local
//   "desync"      — red: RecoveryDesyncError → manual escape hatches
// ---------------------------------------------------------------------------

type RecoveryBannerMode = "recover" | "stale-local" | "desync";

function RecoveryBanner() {
  const { user } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<RecoveryBannerMode>("recover");
  const [recovering, setRecovering] = useState(false);

  // Restore-from-backup state (manual escape hatch for desync).
  const [showRestoreForm, setShowRestoreForm] = useState(false);
  const [restoreJson, setRestoreJson] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // On wallet connect, validate localStorage state against on-chain commitment.
  // Three outcomes:
  //   - localStorage matches chain (or both empty) → no banner
  //   - localStorage empty + chain has state → blue "recover" banner
  //   - localStorage has state + chain mismatch → yellow "stale-local" banner
  useEffect(() => {
    if (!userAddress) {
      setShow(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Resolve COA — required for both directions of validation.
        const { getCoaEvmAddress, getCommitment, isIdentityPoint } = await import("@/lib/tip-actions");
        let coaHex: string;
        try {
          coaHex = await getCoaEvmAddress(userAddress);
        } catch {
          // No COA yet — nothing to validate against.
          if (!cancelled) setShow(false);
          return;
        }
        const commit = await getCommitment(coaHex);
        const chainIsIdentity = isIdentityPoint(commit);

        const localKey = `openjanus:shielded:${userAddress.toLowerCase()}`;
        const localRaw = localStorage.getItem(localKey);

        if (localRaw) {
          // Local state exists — validate via Pedersen against chain.
          try {
            const parsed = JSON.parse(localRaw) as { balanceWei?: string; blinding?: string };
            const balance = BigInt(parsed.balanceWei ?? "0");
            const blinding = BigInt(parsed.blinding ?? "0");

            // Fast path: empty local + identity chain → trivially synced.
            if (balance === 0n && blinding === 0n && chainIsIdentity) {
              if (!cancelled) setShow(false);
              return;
            }

            // General path: compute Pedersen client-side and compare.
            const { validatePedersenCommit } = await import("@/lib/recovery");
            const isValid = await validatePedersenCommit(balance, blinding, commit);

            if (!cancelled) {
              if (isValid) {
                setShow(false);
              } else {
                setMode("stale-local");
                setShow(true);
              }
            }
          } catch {
            // Parse or validation error → treat as stale-local (conservative).
            if (!cancelled) {
              setMode("stale-local");
              setShow(true);
            }
          }
          return;
        }

        // No local state. If chain has commitment, offer recovery.
        if (!cancelled) {
          setShow(!chainIsIdentity);
          setMode("recover");
        }
      } catch {
        // Non-fatal network error — hide banner.
        if (!cancelled) setShow(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userAddress]);

  const handleClearLocal = useCallback(() => {
    if (!userAddress) return;
    const addrLower = userAddress.toLowerCase();
    localStorage.removeItem(`openjanus:shielded:${addrLower}`);
    localStorage.removeItem(`openjanus:tip-ingested:${addrLower}`);
    toast.success("Local shielded state cleared. Reloading…");
    setShow(false);
    setTimeout(() => window.location.reload(), 500);
  }, [userAddress]);

  const handleRecover = useCallback(async () => {
    if (!userAddress) return;
    setRecovering(true);
    // Import both modules upfront — dynamic import results are cached.
    const [tipActions, recoveryMod] = await Promise.all([
      import("@/lib/tip-actions"),
      import("@/lib/recovery"),
    ]);
    const { getOrDeriveMemoPrivkey, getCoaEvmAddress } = tipActions;
    const { recoverShieldedStateFromChain, RecoveryDesyncError } = recoveryMod;
    try {
      toast.info("Recovering your shielded state from chain…");
      const privkey = await getOrDeriveMemoPrivkey(userAddress);

      // Resolve COA so recovery can validate against the on-chain commitment.
      let coaHex: string | undefined;
      try {
        coaHex = await getCoaEvmAddress(userAddress);
      } catch {
        // No COA — recovery will attempt it internally.
      }

      // v0.5.2: recoverShieldedStateFromChain signature changed to
      // (myFlowAddr, myCoaEvmAddr, myMemoPrivkey). COA is required.
      if (!coaHex) {
        toast.warning("Cannot recover: no COA found for this account.");
        setShow(false);
        return;
      }
      const recovered = await recoverShieldedStateFromChain(userAddress, coaHex, privkey);

      if (recovered) {
        const localKey = `openjanus:shielded:${userAddress.toLowerCase()}`;
        localStorage.setItem(localKey, JSON.stringify({
          balanceWei: recovered.balanceWei.toString(),
          blinding: recovered.blinding.toString(),
        }));
        toast.success("Shielded state recovered from chain.");
        setShow(false);
        // Reload to re-hydrate all pages.
        window.location.reload();
      } else {
        toast.warning("No recoverable state found on-chain. Clear localStorage and re-wrap if funds are stuck.");
        setShow(false);
      }
    } catch (err) {
      if (err instanceof RecoveryDesyncError) {
        // Switch banner to the red desync error mode — do NOT write localStorage.
        setMode("desync");
      } else {
        toast.error("Recovery failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setRecovering(false);
    }
  }, [userAddress]);

  const handleRestoreFromBackup = useCallback(() => {
    if (!userAddress) return;
    setRestoreError(null);
    try {
      const parsed = JSON.parse(restoreJson.trim()) as { balance?: string; balanceWei?: string; blinding?: string };
      const balanceWei = parsed.balanceWei ?? parsed.balance;
      const blinding = parsed.blinding;
      if (!balanceWei || !blinding) {
        setRestoreError("JSON must have balanceWei (or balance) and blinding fields.");
        return;
      }
      // Validate they're parseable bigints.
      BigInt(balanceWei);
      BigInt(blinding);
      const localKey = `openjanus:shielded:${userAddress.toLowerCase()}`;
      localStorage.setItem(localKey, JSON.stringify({ balanceWei, blinding }));
      toast.success("Shielded state restored from backup.");
      setShow(false);
      window.location.reload();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, [userAddress, restoreJson]);

  if (!isLoggedIn || !show) return null;

  // --- Yellow stale-local banner ---
  // Local state doesn't match on-chain commitment (admin reset, stale session,
  // device switch with leftover state, etc.). Offer to clear and start fresh.
  if (mode === "stale-local") {
    return (
      <div className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-yellow-500/50 bg-yellow-50/95 dark:bg-yellow-950/80 px-4 py-3 text-xs backdrop-blur">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-yellow-600 dark:text-yellow-400 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-yellow-900 dark:text-yellow-100">
                Your local shielded state is out of sync with the chain.
              </p>
              <p className="text-yellow-800 dark:text-yellow-200 mt-0.5">
                The on-chain commitment doesn&apos;t match what&apos;s stored in this browser.
                Likely cause: admin reset the slot, or this is stale state from another session.
                Clear local state to restart fresh.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              onClick={handleClearLocal}
              className="inline-flex items-center px-3 py-1 rounded border border-yellow-500/60 bg-yellow-50 dark:bg-yellow-950 text-yellow-900 dark:text-yellow-100 font-medium hover:bg-yellow-100 dark:hover:bg-yellow-900 transition-colors"
            >
              Clear local state
            </button>
            <button
              onClick={() => setShow(false)}
              className="inline-flex items-center px-3 py-1 rounded border border-yellow-300/60 bg-transparent text-yellow-700 dark:text-yellow-300 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/30 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Red desync error banner ---
  if (mode === "desync") {
    return (
      <div className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-red-500/50 bg-red-50/95 dark:bg-red-950/80 px-4 py-3 text-xs backdrop-blur">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-red-900 dark:text-red-100">
                Recovery failed: chain state cannot be reconstructed.
              </p>
              <p className="text-red-800 dark:text-red-200 mt-0.5">
                This wallet has activity from before recovery was enabled, or there&apos;s a deeper desync.
              </p>
            </div>
          </div>

          {!showRestoreForm ? (
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                onClick={() => setShowRestoreForm(true)}
                className="inline-flex items-center px-3 py-1 rounded border border-red-500/60 bg-red-50 dark:bg-red-950 text-red-900 dark:text-red-100 font-medium hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
              >
                Restore from backup
              </button>
              <button
                onClick={() => setShow(false)}
                className="inline-flex items-center px-3 py-1 rounded border border-red-300/60 bg-transparent text-red-700 dark:text-red-300 hover:bg-red-100/50 dark:hover:bg-red-900/30 transition-colors"
              >
                Dismiss
              </button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-red-800 dark:text-red-200">
                Paste your saved shielded state JSON: <code className="font-mono bg-red-100 dark:bg-red-900 px-1 rounded">{"{\"balanceWei\": \"...\", \"blinding\": \"...\"}"}</code>
              </p>
              <textarea
                value={restoreJson}
                onChange={(e) => setRestoreJson(e.target.value)}
                rows={3}
                className="w-full px-2 py-1.5 text-xs font-mono border border-red-300 dark:border-red-700 rounded bg-white dark:bg-red-950/50 text-foreground"
                placeholder='{"balanceWei": "5000000000000000000", "blinding": "12345678..."}'
              />
              {restoreError && (
                <p className="text-red-700 dark:text-red-300 font-medium">{restoreError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleRestoreFromBackup}
                  className="inline-flex items-center px-3 py-1 rounded border border-red-500/60 bg-red-50 dark:bg-red-950 text-red-900 dark:text-red-100 font-medium hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
                >
                  Restore
                </button>
                <button
                  onClick={() => { setShowRestoreForm(false); setRestoreError(null); }}
                  className="inline-flex items-center px-3 py-1 rounded border border-red-300/60 bg-transparent text-red-700 dark:text-red-300 hover:bg-red-100/50 dark:hover:bg-red-900/30 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Blue normal recovery banner ---
  return (
    <div className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-blue-400/40 bg-blue-50/95 dark:bg-blue-950/80 px-4 py-2 text-xs backdrop-blur">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-blue-900 dark:text-blue-100 min-w-0">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 text-blue-600" />
          <span className="truncate sm:whitespace-normal">
            <strong>Your shielded state isn&apos;t loaded in this browser.</strong>{" "}
            Click Recover to reconstruct it from the chain using your wallet.
          </span>
        </span>
        <button
          onClick={handleRecover}
          disabled={recovering}
          className="shrink-0 inline-flex items-center px-3 py-1 rounded border border-blue-400/60 bg-blue-50 dark:bg-blue-950 text-blue-900 dark:text-blue-100 font-medium hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors disabled:opacity-50"
        >
          {recovering ? "Recovering…" : "Recover"}
        </button>
      </div>
    </div>
  );
}

/// Global MemoKey status banner
function MemoKeyStatusBanner() {
  const { user } = useFlowCurrentUser();
  const pathname = usePathname();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    if (!userAddress) {
      setNeedsSetup(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { getRecipientMemoPubkey } = await import("@/lib/tip-actions");
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const [onChainPub, sessionPriv] = await Promise.all([
        getRecipientMemoPubkey(userAddress),
        Promise.resolve(getCachedMemoPrivkey(userAddress)),
      ]);
      if (cancelled) return;
      setNeedsSetup(onChainPub === null || sessionPriv === null);
    })();
    return () => {
      cancelled = true;
    };
  }, [userAddress, pathname]);

  if (!isLoggedIn || !needsSetup) return null;
  if (pathname === "/wrap") return null;

  return (
    <div className="sticky top-[calc(theme(spacing.7)+1px)] z-40 w-full border-b border-[#B45309]/40 bg-amber-50/95 dark:bg-[#0A1628]/90 px-4 py-2 text-xs backdrop-blur">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-amber-900 dark:text-amber-100 min-w-0">
          <Key className="w-3.5 h-3.5 shrink-0 text-[#B45309]" />
          <span className="truncate sm:whitespace-normal">
            <strong>Your private inbox isn&apos;t active yet.</strong> Enable
            it to send, receive, and withdraw — takes one wallet signature.
          </span>
        </span>
        <Link
          href="/wrap"
          className="shrink-0 inline-flex items-center px-3 py-1 rounded border border-[#B45309]/60 bg-amber-50 dark:bg-[#0A1628] text-amber-900 dark:text-amber-100 font-medium hover:bg-amber-100 dark:hover:bg-[#0A1628]/80 transition-colors"
        >
          Set up now
        </Link>
      </div>
    </div>
  );
}

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FlowProvider
      config={flowConfig}
      flowJson={flowJSON}
      colorMode="system"
    >
      {/* Testnet banner — gold accent */}
      <div className="sticky top-0 z-50 w-full border-b border-[#D4AF37]/40 bg-[#D4AF37]/10 dark:bg-[#D4AF37]/8 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:text-[#D4AF37]">
        <span className="font-mono">⬡</span>{" "}
        <span className="hidden sm:inline">Testnet Mode — </span>
        No real FLOW is used. For demonstration only.
      </div>

      {/* Nav bar — Fraunces wordmark */}
      <nav className="sticky top-7 z-40 w-full border-b border-border/60 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            {/* Logo: stylized Janus "⟵⟶" motif + Fraunces wordmark */}
            <Link href="/" className="flex items-center gap-2 group">
              {/* Janus two-faced glyph — two arcs facing out */}
              <span
                aria-hidden
                className="text-[#00EF8B] text-base leading-none select-none font-mono opacity-80 group-hover:opacity-100 transition-opacity"
                style={{ letterSpacing: "-0.1em" }}
              >
                ⟨⟩
              </span>
              <span
                className="font-bold text-xl tracking-tight"
                style={{ fontFamily: "var(--font-fraunces, Georgia, serif)", fontWeight: 600 }}
              >
                PrivateTip
              </span>
            </Link>

            <div className="hidden sm:flex items-center gap-4 text-sm font-medium">
              <NavLink href="/wrap">Wrap</NavLink>
              <NavLink href="/send">Send</NavLink>
              <NavLink href="/tips">Tips</NavLink>
              <NavLink href="/claim">Withdraw</NavLink>
              <NavLink href="/learn" highlight>Learn</NavLink>
            </div>
          </div>
          <ConnectWallet />
        </div>
      </nav>

      {/* Global MemoKey status banner */}
      <MemoKeyStatusBanner />

      {/* Recovery banner — shown when localStorage is empty but chain has state */}
      <RecoveryBanner />

      {/* Main content area */}
      <main className="flex-1">{children}</main>

      {/* Toast notifications */}
      <Toaster
        position="bottom-right"
        richColors
        closeButton
      />
    </FlowProvider>
  );
}

function NavLink({
  href,
  children,
  highlight,
}: {
  href: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;

  if (highlight) {
    return (
      <Link
        href={href}
        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
          isActive
            ? "bg-[#6B46C1]/15 text-[#6B46C1] dark:text-purple-300"
            : "text-[#6B46C1] dark:text-purple-300 hover:bg-[#6B46C1]/10"
        }`}
      >
        {children}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={`transition-colors ${
        isActive
          ? "text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}
