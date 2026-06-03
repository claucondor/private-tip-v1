"use client";

/// Persistent testnet-only warning banner for PrivateTip.
///
/// Renders a prominent banner at the top of the page warning users that
/// this app is running on Flow testnet, NOT mainnet. Uses the testnet
/// configuration from fcl-config.ts.
///
/// The banner persists across all pages and cannot be dismissed — this is
/// intentional to prevent users from mistaking testnet for mainnet.

import { AlertTriangle, FlaskConical } from "lucide-react";
import { TESTNET_BANNER } from "@/lib/fcl-config";

export interface TestnetBannerProps {
  /** If true, render an even more prominent variant with icon accent */
  prominent?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * TestnetBanner — Persistent warning that this app is testnet-only.
 *
 * Cannot be dismissed. Shows at the top of every page.
 * The message is imported from fcl-config.ts so it automatically
 * adapts between dev and production builds.
 */
export default function TestnetBanner({
  prominent = false,
  className = "",
}: TestnetBannerProps) {
  if (prominent) {
    return (
      <div
        className={`sticky top-0 z-50 w-full bg-amber-50 dark:bg-amber-950/90 border-b border-amber-200 dark:border-amber-800 ${className}`}
      >
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-200">
          <FlaskConical className="w-4 h-4 shrink-0 text-amber-500" />
          <span>
            <strong className="font-semibold">Testnet Only</strong> —{" "}
            {TESTNET_BANNER}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sticky top-0 z-50 w-full bg-amber-50 dark:bg-amber-950/80 border-b border-amber-200 dark:border-amber-800 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:text-amber-200 ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline">Testnet Mode — </span>
        {TESTNET_BANNER}
      </span>
    </div>
  );
}
