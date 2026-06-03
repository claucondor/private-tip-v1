"use client";

/// Decrypted accumulated balance display for PrivateTip.
///
/// Shows the recipient's decrypted total balance from the JanusToken
/// ElGamal accumulator slot. Uses pre-computed BSGS for fast decryption
/// — no spinner needed for the typical 50-100ms operation.
///
/// States:
/// - Loading (first fetch)
/// - Ready (decrypted balance shown)
/// - Empty (no tips received / slot is zero)
/// - Not registered (no pubkey, no slot)
/// - Error (fetch or decryption failed)

import { useMemo } from "react";
import { Wallet, EyeOff, Loader2, AlertCircle, Gift, Coins } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────

export type BalanceStatus =
  | "loading"
  | "ready"
  | "empty"
  | "not_registered"
  | "error";

export interface BalanceDisplayProps {
  /** Current status of the balance fetch */
  status: BalanceStatus;
  /** Decrypted balance in FLOW (human-readable string, e.g. "42.5") */
  balance?: string | null;
  /** Original encrypted balance description (for display) */
  encryptedDescription?: string | null;
  /** Error message if status is "error" */
  error?: string | null;
  /** Title text above the balance (default: "Accumulated Balance") */
  title?: string;
  /** If true, render a compact variant (icon + number only) */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Format a FLOW amount for display.
 * - Strips trailing zeros after the decimal
 * - Shows at least 2 decimal places
 */
function formatFlowAmount(amount: string): string {
  const num = parseFloat(amount);
  if (isNaN(num)) return amount;
  if (num === 0) return "0.00";
  // Show up to 8 decimal places but strip trailing zeros
  const fixed = num.toFixed(8);
  const trimmed = fixed.replace(/\.?0+$/, "");
  // Ensure at least 2 decimal places for readability
  const parts = trimmed.split(".");
  if (parts.length === 1) return `${trimmed}.00`;
  if (parts[1].length < 2) return `${trimmed}0`.slice(0, trimmed.length + 1);
  return trimmed;
}

// ─── Component ─────────────────────────────────────────────────────────────

/**
 * BalanceDisplay — Shows the recipient's decrypted accumulated balance.
 *
 * Display logic by status:
 * - loading: Pulsing skeleton or spinner
 * - ready: FLOW amount with label
 * - empty: "No tips received yet"
 * - not_registered: "Register your pubkey to receive tips"
 * - error: Error message with retry suggestion
 */
export default function BalanceDisplay({
  status,
  balance = null,
  encryptedDescription = null,
  error = null,
  title = "Accumulated Balance",
  compact = false,
  className = "",
}: BalanceDisplayProps) {
  const formattedBalance = useMemo(
    () => (balance ? formatFlowAmount(balance) : null),
    [balance]
  );

  // ── Compact variant ────────────────────────────────────────────────────
  if (compact) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5 text-sm",
          className
        )}
      >
        {status === "loading" && (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">Loading...</span>
          </>
        )}
        {status === "ready" && formattedBalance && (
          <>
            <Coins className="w-3.5 h-3.5 text-emerald-500" />
            <span className="font-semibold tabular-nums">
              {formattedBalance} FLOW
            </span>
          </>
        )}
        {status === "empty" && (
          <span className="text-muted-foreground text-xs">No tips</span>
        )}
        {status === "not_registered" && (
          <span className="text-amber-500 text-xs">Register pubkey</span>
        )}
        {status === "error" && (
          <span className="text-destructive text-xs">Error</span>
        )}
      </div>
    );
  }

  // ── Full variant ───────────────────────────────────────────────────────
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-5",
        className
      )}
    >
      {/* Title */}
      <div className="flex items-center gap-2 mb-3">
        <Wallet className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      </div>

      {/* Balance content */}
      {status === "loading" && (
        <div className="flex items-center gap-3 py-2">
          <div className="w-10 h-10 rounded-lg bg-muted animate-pulse" />
          <div className="space-y-2 flex-1">
            <div className="h-6 w-32 bg-muted animate-pulse rounded" />
            <div className="h-3 w-48 bg-muted animate-pulse rounded" />
          </div>
        </div>
      )}

      {status === "ready" && formattedBalance && (
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold tracking-tight tabular-nums">
              {formattedBalance}
            </span>
            <span className="text-lg font-medium text-muted-foreground">
              FLOW
            </span>
          </div>
          {encryptedDescription && (
            <p className="text-xs text-muted-foreground mt-1">
              {encryptedDescription}
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Per-tipper amounts remain hidden
          </div>
        </div>
      )}

      {status === "empty" && (
        <div className="flex flex-col items-center py-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mb-3">
            <Gift className="w-5 h-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No tips received yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Share your address with friends to start receiving confidential tips
          </p>
        </div>
      )}

      {status === "not_registered" && (
        <div className="flex flex-col items-center py-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-950 flex items-center justify-center mb-3">
            <Wallet className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          </div>
          <p className="text-sm font-medium">Encryption pubkey not registered</p>
          <p className="text-xs text-muted-foreground mt-1">
            Register your BabyJubJub pubkey with JanusToken to start receiving
            confidential tips
          </p>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center py-4 text-center">
          <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center mb-3">
            <AlertCircle className="w-5 h-5 text-destructive" />
          </div>
          <p className="text-sm font-medium">Failed to load balance</p>
          <p className="text-xs text-muted-foreground mt-1">
            {error || "An unexpected error occurred. Try refreshing."}
          </p>
        </div>
      )}
    </div>
  );
}
