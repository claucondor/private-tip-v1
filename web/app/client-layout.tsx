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
// Recovery banner — Phase 1 stub.
//
// Phase 3 will rewrite this using ShieldedCheckpointClient.readAndDecrypt()
// to detect chain vs local desync. The v0.7 localStorage model this depended
// on (loadAllShieldedStates, sweepStaleShieldedCache, clearShieldedStateForAddr,
// recoverShieldedState from deleted recovery.ts, saveShieldedState) was removed
// in Phase 1. Return null until Phase 3 rewrites with the checkpoint model.
// ---------------------------------------------------------------------------

function RecoveryBanner() {
  // Phase 1 stub — Phase 3 will rewrite — Phase 1 left this here intentionally
  // because it consumes lib functions whose rewrite happens later.
  return null;
}


type MemoKeyBannerMode = "not_on_chain" | "session_missing";

/// Global MemoKey status banner — distinguishes first-time activation from
/// session unlock (key cleared on tab close, re-derived from wallet each session).
function MemoKeyStatusBanner() {
  const { user } = useFlowCurrentUser();
  const pathname = usePathname();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [bannerMode, setBannerMode] = useState<MemoKeyBannerMode | null>(null);

  useEffect(() => {
    if (!userAddress) {
      setBannerMode(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { getRecipientMemoPubkey } = await import("@/lib/tip-actions");
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const [onChainPub, sessionPriv] = await Promise.all([
        getRecipientMemoPubkey(userAddress).catch(() => null),
        Promise.resolve(getCachedMemoPrivkey(userAddress)),
      ]);
      if (cancelled) return;
      if (onChainPub === null) {
        setBannerMode("not_on_chain");
      } else if (sessionPriv === null) {
        setBannerMode("session_missing");
      } else {
        setBannerMode(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userAddress, pathname]);

  if (!isLoggedIn || bannerMode === null) return null;
  // Don't show on /wrap (has its own activation UI) or /status (activation happens there)
  if (pathname === "/wrap" || pathname === "/status") return null;

  const isNotOnChain = bannerMode === "not_on_chain";

  return (
    <motion.div
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -8, opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="sticky top-[calc(theme(spacing.7)+theme(spacing.14)+1px)] z-40 w-full border-b border-[#B45309]/40 bg-[#0A1628]/95 px-4 py-2 text-xs backdrop-blur"
    >
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-amber-200 min-w-0">
          <Key className="w-3.5 h-3.5 shrink-0 text-[#B45309]" />
          <span className="truncate sm:whitespace-normal">
            {isNotOnChain ? (
              <>
                <strong>Your private inbox isn&apos;t activated.</strong>{" "}
                Activate to receive tips — takes 2 steps.
              </>
            ) : (
              <>
                <strong>Unlock your private inbox for this session.</strong>{" "}
                Your key re-derives from your wallet — same key, never stored.
              </>
            )}
          </span>
        </span>
        <Link
          href="/status"
          className="shrink-0 inline-flex items-center px-3 py-1 rounded border border-[#B45309]/50 bg-[#B45309]/10 text-amber-200 font-medium hover:bg-[#B45309]/20 transition-colors"
        >
          {isNotOnChain ? "Activate" : "Unlock"}
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
            <span className="font-mono text-foreground/40">v0.7.5</span>
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
