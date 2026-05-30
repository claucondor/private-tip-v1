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
import { Key, RefreshCw } from "lucide-react";
import { flowConfig } from "@/lib/fcl-config";
import ConnectWallet from "@/components/ConnectWallet";
import flowJSON from "../../flow.json";

// ---------------------------------------------------------------------------
// Recovery banner — shown when localStorage is empty but chain has state.
// ---------------------------------------------------------------------------

function RecoveryBanner() {
  const { user } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [show, setShow] = useState(false);
  const [recovering, setRecovering] = useState(false);

  // On wallet connect, check: localStorage empty AND on-chain commit non-identity.
  useEffect(() => {
    if (!userAddress) {
      setShow(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Check local state first (cheap).
        const localKey = `openjanus:shielded:${userAddress.toLowerCase()}`;
        const hasLocal = !!localStorage.getItem(localKey);
        if (hasLocal) {
          // Already have state — no need to recover.
          if (!cancelled) setShow(false);
          return;
        }

        // Check on-chain commitment (requires COA).
        const { getCoaEvmAddress, getCommitment, isIdentityPoint } = await import("@/lib/tip-actions");
        let coaHex: string;
        try {
          coaHex = await getCoaEvmAddress(userAddress);
        } catch {
          return; // No COA yet — nothing to recover.
        }
        const commit = await getCommitment(coaHex);
        if (!cancelled) {
          setShow(!isIdentityPoint(commit));
        }
      } catch {
        // Non-fatal — hide banner on errors.
      }
    })();
    return () => { cancelled = true; };
  }, [userAddress]);

  const handleRecover = useCallback(async () => {
    if (!userAddress) return;
    setRecovering(true);
    try {
      const { getOrDeriveMemoPrivkey } = await import("@/lib/tip-actions");
      const { recoverShieldedStateFromChain } = await import("@/lib/recovery");

      toast.info("Recovering your shielded state from chain…");
      const privkey = await getOrDeriveMemoPrivkey(userAddress);
      const recovered = await recoverShieldedStateFromChain(userAddress, privkey);

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
      toast.error("Recovery failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRecovering(false);
    }
  }, [userAddress]);

  if (!isLoggedIn || !show) return null;

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
