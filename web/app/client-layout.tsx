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
import { motion, AnimatePresence } from "framer-motion";
import { Key, RefreshCw, AlertTriangle, Menu, X } from "lucide-react";
import { flowConfig } from "@/lib/fcl-config";
import ConnectWallet from "@/components/ConnectWallet";
import MainnetCountdown from "@/components/MainnetCountdown";
// Copy of /flow.json bundled inside web/ so Vercel's build root (web/) can resolve it.
// Keep web/flow.json in sync with /flow.json when contracts/aliases change.
import flowJSON from "../flow.json";

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

        // v0.6: check per-token keys (check FLOW token as primary indicator)
        const localKey = `openjanus:shielded:${userAddress.toLowerCase()}:flow`;
        const localRaw = localStorage.getItem(localKey);
        // Also check legacy v0.5 key format for migration.
        const legacyKey = `openjanus:shielded:${userAddress.toLowerCase()}`;
        const legacyRaw = localStorage.getItem(legacyKey);

        if (localRaw || legacyRaw) {
          // Local state exists — skip desync check (computeCommitment from SDK is
          // available but pulling heavy crypto into the banner is not worth it).
          // In v0.6 we trust the snapshot events (SDK recovers on demand).
          if (!cancelled) setShow(false);
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

  const handleClearLocal = useCallback(async () => {
    if (!userAddress) return;
    const { clearShieldedStateForAddr } = await import("@/lib/store");
    clearShieldedStateForAddr(userAddress);
    // Also clear legacy v0.5 key.
    localStorage.removeItem(`openjanus:shielded:${userAddress.toLowerCase()}`);
    localStorage.removeItem(`openjanus:tip-ingested:${userAddress.toLowerCase()}`);
    toast.success("Local shielded state cleared. Reloading…");
    setShow(false);
    setTimeout(() => window.location.reload(), 500);
  }, [userAddress]);

  const handleRecover = useCallback(async () => {
    if (!userAddress) return;
    setRecovering(true);
    // Import both modules upfront — dynamic import results are cached.
    const { getOrDeriveMemoPrivkey, getCoaEvmAddress } = await import("@/lib/tip-actions");
    const { recoverShieldedState } = await import("@/lib/recovery");
    try {
      toast.info("Recovering your shielded state from chain…");
      const privkey = await getOrDeriveMemoPrivkey(userAddress);

      let coaHex: string | undefined;
      try {
        coaHex = await getCoaEvmAddress(userAddress);
      } catch { /* no COA */ }

      if (!coaHex) {
        toast.warning("Cannot recover: no COA found for this account.");
        setShow(false);
        setRecovering(false);
        return;
      }

      // v0.6: recover per-token via SDK adapter latestSnapshot.
      const { saveShieldedState } = await import("@/lib/store");
      let anyRecovered = false;
      for (const tokenId of ["flow", "wflow", "mockusdc"] as const) {
        try {
          const snap = await recoverShieldedState(coaHex, privkey, tokenId);
          if (snap) {
            saveShieldedState(userAddress, tokenId, {
              balanceRaw: snap.balance.toString(),
              blinding: snap.blinding.toString(),
              lastUpdatedMs: snap.timestampMs,
            });
            anyRecovered = true;
          }
        } catch { /* try next token */ }
      }
      // mockft: try with Cadence address.
      try {
        const snap = await recoverShieldedState(userAddress, privkey, "mockft");
        if (snap) {
          saveShieldedState(userAddress, "mockft", {
            balanceRaw: snap.balance.toString(),
            blinding: snap.blinding.toString(),
            lastUpdatedMs: snap.timestampMs,
          });
          anyRecovered = true;
        }
      } catch { /* non-fatal */ }

      if (anyRecovered) {
        toast.success("Shielded state recovered from chain.");
        setShow(false);
        window.location.reload();
      } else {
        toast.warning("No recoverable state found on-chain. Re-wrap if funds are stuck.");
        setShow(false);
      }
    } catch (err) {
      toast.error("Recovery failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRecovering(false);
    }
  }, [userAddress]);

  const handleRestoreFromBackup = useCallback(async () => {
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
      // Write to new v0.6 key format (FLOW token).
      const { saveShieldedState } = await import("@/lib/store");
      saveShieldedState(userAddress, "flow", { balanceRaw: balanceWei, blinding });
      toast.success("Shielded state restored from backup.");
      setShow(false);
      window.location.reload();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, [userAddress, restoreJson]);

  if (!isLoggedIn || !show) return null;

  // --- Yellow stale-local banner ---
  if (mode === "stale-local") {
    return (
      <motion.div
        initial={{ y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -8, opacity: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-yellow-500/40 bg-[#0A1628]/95 px-4 py-3 text-xs backdrop-blur"
      >
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-yellow-400 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-yellow-200">
                Your local shielded state is out of sync with the chain.
              </p>
              <p className="text-yellow-300/80 mt-0.5">
                The on-chain commitment doesn&apos;t match what&apos;s stored in this browser.
                Likely cause: admin reset the slot, or this is stale state from another session.
                Clear local state to restart fresh.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              onClick={handleClearLocal}
              className="inline-flex items-center px-3 py-1 rounded border border-yellow-500/50 bg-yellow-950/40 text-yellow-200 font-medium hover:bg-yellow-900/40 transition-colors"
            >
              Clear local state
            </button>
            <button
              onClick={() => setShow(false)}
              className="inline-flex items-center px-3 py-1 rounded border border-yellow-600/30 bg-transparent text-yellow-400 hover:bg-yellow-900/20 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // --- Red desync error banner ---
  if (mode === "desync") {
    return (
      <motion.div
        initial={{ y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -8, opacity: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-red-500/40 bg-[#0A1628]/95 px-4 py-3 text-xs backdrop-blur"
      >
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-red-200">
                Recovery failed: chain state cannot be reconstructed.
              </p>
              <p className="text-red-300/80 mt-0.5">
                This wallet has activity from before recovery was enabled, or there&apos;s a deeper desync.
              </p>
            </div>
          </div>

          {!showRestoreForm ? (
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                onClick={() => setShowRestoreForm(true)}
                className="inline-flex items-center px-3 py-1 rounded border border-red-500/50 bg-red-950/40 text-red-200 font-medium hover:bg-red-900/40 transition-colors"
              >
                Restore from backup
              </button>
              <button
                onClick={() => setShow(false)}
                className="inline-flex items-center px-3 py-1 rounded border border-red-600/30 bg-transparent text-red-400 hover:bg-red-900/20 transition-colors"
              >
                Dismiss
              </button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-red-300/80">
                Paste your saved shielded state JSON: <code className="font-mono bg-red-950/60 px-1 rounded">{"{\"balanceWei\": \"...\", \"blinding\": \"...\"}"}</code>
              </p>
              <textarea
                value={restoreJson}
                onChange={(e) => setRestoreJson(e.target.value)}
                rows={3}
                className="w-full px-2 py-1.5 text-xs font-mono border border-red-700/40 rounded bg-red-950/30 text-foreground"
                placeholder='{"balanceWei": "5000000000000000000", "blinding": "12345678..."}'
              />
              {restoreError && (
                <p className="text-red-400 font-medium">{restoreError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleRestoreFromBackup}
                  className="inline-flex items-center px-3 py-1 rounded border border-red-500/50 bg-red-950/40 text-red-200 font-medium hover:bg-red-900/40 transition-colors"
                >
                  Restore
                </button>
                <button
                  onClick={() => { setShowRestoreForm(false); setRestoreError(null); }}
                  className="inline-flex items-center px-3 py-1 rounded border border-red-600/30 bg-transparent text-red-400 hover:bg-red-900/20 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // --- Blue normal recovery banner ---
  return (
    <motion.div
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -8, opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-blue-400/30 bg-[#0A1628]/95 px-4 py-2 text-xs backdrop-blur"
    >
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-blue-200 min-w-0">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 text-blue-400" />
          <span className="truncate sm:whitespace-normal">
            <strong>Your shielded state isn&apos;t loaded in this browser.</strong>{" "}
            Click Recover to reconstruct it from the chain using your wallet.
          </span>
        </span>
        <button
          onClick={handleRecover}
          disabled={recovering}
          className="shrink-0 inline-flex items-center px-3 py-1 rounded border border-blue-400/40 bg-blue-950/40 text-blue-200 font-medium hover:bg-blue-900/40 transition-colors disabled:opacity-50"
        >
          {recovering ? "Recovering…" : "Recover"}
        </button>
      </div>
    </motion.div>
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
    <motion.div
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -8, opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="sticky top-[calc(theme(spacing.7)+1px)] z-40 w-full border-b border-[#B45309]/40 bg-[#0A1628]/95 px-4 py-2 text-xs backdrop-blur"
    >
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-amber-200 min-w-0">
          <Key className="w-3.5 h-3.5 shrink-0 text-[#B45309]" />
          <span className="truncate sm:whitespace-normal">
            <strong>Your private inbox isn&apos;t active yet.</strong> Enable
            it to send, receive, and withdraw — takes one wallet signature.
          </span>
        </span>
        <Link
          href="/wrap"
          className="shrink-0 inline-flex items-center px-3 py-1 rounded border border-[#B45309]/50 bg-[#B45309]/10 text-amber-200 font-medium hover:bg-[#B45309]/20 transition-colors"
        >
          Set up now
        </Link>
      </div>
    </motion.div>
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
      {/* Mainnet countdown + faucet CTA (replaces standalone testnet banner) */}
      <MainnetCountdown />

      {/* Nav bar — Fraunces wordmark */}
      <nav className="sticky top-7 z-40 w-full border-b border-white/8 bg-[#0A1628]/90 backdrop-blur supports-[backdrop-filter]:bg-[#0A1628]/75">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            {/* Logo: stylized Janus "⟨⟩" motif + Fraunces wordmark + openjanus tag */}
            <Link href="/" className="flex items-center gap-2 group">
              {/* Janus glyph — breathing animation on hover */}
              <motion.span
                aria-hidden
                className="text-[#00EF8B] text-base leading-none select-none font-mono"
                style={{ letterSpacing: "-0.1em" }}
                animate={{ opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                whileHover={{ opacity: 1, scale: 1.1 }}
              >
                ⟨⟩
              </motion.span>
              <span
                className="font-bold text-xl tracking-tight text-foreground"
                style={{ fontFamily: "var(--font-fraunces, Georgia, serif)", fontWeight: 600 }}
              >
                PrivateTip
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[9px] uppercase tracking-wider text-[#00EF8B]/80 font-mono">
                Janus demo
              </span>
            </Link>

            <div className="hidden sm:flex items-center gap-4 text-sm font-medium">
              <NavLink href="/portfolio">Portfolio</NavLink>
              <NavLink href="/wrap">Wrap</NavLink>
              <NavLink href="/send">Send</NavLink>
              <NavLink href="/tips">Tips</NavLink>
              <NavLink href="/claim">Withdraw</NavLink>
              <NavLink href="/status">Status</NavLink>
              <NavLink href="/faucet">Faucet</NavLink>
              <NavLink href="/learn" highlight>Learn</NavLink>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectWallet />
            <MobileMenuButton />
          </div>
        </div>
        {/* Mobile nav dropdown */}
        <MobileNav />
      </nav>

      {/* Global MemoKey status banner */}
      <MemoKeyStatusBanner />

      {/* Recovery banner — shown when localStorage is empty but chain has state */}
      <RecoveryBanner />

      {/* Main content area */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="w-full border-t border-white/8 bg-[#0A1628]/60 px-4 py-4 text-[11px] text-foreground/50">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span className="font-mono">Consent-required privacy.</span>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/claucondor/private-tip"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              GitHub
            </a>
            <span className="text-foreground/30">·</span>
            <span className="font-mono text-foreground/40">v0.6.5</span>
            <span className="text-foreground/30">·</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#D4AF37]/40 bg-[#D4AF37]/10 text-[#D4AF37] font-mono text-[10px]">
              testnet
            </span>
          </div>
        </div>
      </footer>

      {/* Toast notifications */}
      <Toaster
        position="bottom-right"
        richColors
        closeButton
      />
    </FlowProvider>
  );
}

// Global mobile menu state — shared between button and nav panel
let _setMobileMenuOpen: ((v: boolean) => void) | null = null;

function MobileMenuButton() {
  const [open, setOpen] = useState(false);
  _setMobileMenuOpen = setOpen;

  return (
    <button
      type="button"
      aria-label="Toggle navigation"
      onClick={() => setOpen((v) => !v)}
      className="sm:hidden p-2 rounded-md text-foreground/60 hover:text-foreground hover:bg-white/8 transition-colors"
    >
      {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
    </button>
  );
}

function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Register setter so MobileMenuButton can toggle this
  useEffect(() => {
    _setMobileMenuOpen = setOpen;
  });

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (!open) return null;

  const links: { href: string; label: string; highlight?: boolean }[] = [
    { href: "/portfolio", label: "Portfolio" },
    { href: "/wrap",   label: "Wrap" },
    { href: "/send",   label: "Send" },
    { href: "/tips",   label: "Tips" },
    { href: "/claim",  label: "Withdraw" },
    { href: "/status", label: "Status" },
    { href: "/faucet", label: "Faucet" },
    { href: "/learn",  label: "Learn", highlight: true },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18 }}
      className="sm:hidden border-t border-white/8 bg-[#0A1628]/98 px-4 py-3 space-y-1"
    >
      {links.map(({ href, label, highlight }) => {
        const isActive = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive
                ? "bg-[#00EF8B]/10 text-[#00EF8B]"
                : highlight
                ? "text-purple-400 hover:bg-[#6B46C1]/10 hover:text-purple-300"
                : "text-foreground/70 hover:bg-white/5 hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </motion.div>
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
            ? "bg-[#6B46C1]/20 text-purple-300"
            : "text-purple-400 hover:bg-[#6B46C1]/10 hover:text-purple-300"
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
          ? "text-[#00EF8B] font-semibold"
          : "text-foreground/60 hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}
