"use client";

/// Recipient BabyJubJub pubkey display component.
///
/// Fetches a recipient's registered BabyJubJub pubkey from the
/// JanusToken contract using @claucondor/sdk, and displays it with
/// copy-to-clipboard functionality.
///
/// If no pubkey is registered, shows a "not registered" state.

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Copy,
  Check,
  Key,
  Search,
  Loader2,
  AlertCircle,
  Fingerprint,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RecipientPubkeyData {
  /** x coordinate of the BabyJubJub pubkey (hex string) */
  x: string;
  /** y coordinate of the BabyJubJub pubkey (hex string) */
  y: string;
}

export interface RecipientPubkeyDisplayProps {
  /** Pre-configured address (e.g., from a tip to lookup). If omitted, user can enter one. */
  address?: string;
  /** External pubkey data (if already fetched by parent). */
  pubkeyData?: RecipientPubkeyData | null;
  /** Whether the pubkey is currently being fetched. */
  isLoading?: boolean;
  /** Error message if fetching failed. */
  error?: string | null;
  /** Callback when the user searches for a new address. */
  onSearch?: (address: string) => void;
  /** If true, the component handles its own address input + fetch. Default: false. */
  interactive?: boolean;
  /** Additional CSS classes. */
  className?: string;
}

// ─── Validation ────────────────────────────────────────────────────────────

const FLOW_ADDRESS_RE = /^0x[0-9a-fA-F]{16}$/;

function validateAddress(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Address is required";
  if (!FLOW_ADDRESS_RE.test(trimmed)) {
    return "Invalid Flow address (expected 0x + 16 hex chars)";
  }
  return undefined;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Format a BabyJubJub hex coordinate for display.
 * Shows first 16 hex chars + "..." + last 4 hex chars.
 */
function formatHexCoord(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length <= 24) return `0x${clean}`;
  return `0x${clean.slice(0, 16)}...${clean.slice(-4)}`;
}

/**
 * Check if a pubkey is the identity point (unregistered).
 * The identity point on BabyJubJub is (0, 1).
 */
function isIdentityPoint(x: string, y: string): boolean {
  const cleanX = x.startsWith("0x") ? x.slice(2) : x;
  const cleanY = y.startsWith("0x") ? y.slice(2) : y;
  return (
    BigInt(`0x${cleanX || "0"}`) === BigInt(0) &&
    BigInt(`0x${cleanY || "0"}`) === BigInt(1)
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

/**
 * RecipientPubkeyDisplay — Shows a recipient's registered BabyJubJub pubkey.
 *
 * In interactive mode, provides an address input and search button.
 * In non-interactive mode, displays pre-fetched data.
 * Always provides copy-to-clipboard for the full pubkey.
 */
export default function RecipientPubkeyDisplay({
  address: propAddress,
  pubkeyData,
  isLoading = false,
  error = null,
  onSearch,
  interactive = false,
  className = "",
}: RecipientPubkeyDisplayProps) {
  // ── Internal state (interactive mode) ───────────────────────────────────
  const [searchAddress, setSearchAddress] = useState(propAddress ?? "");
  const [searchError, setSearchError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  // Sync prop address into search field
  useEffect(() => {
    if (propAddress) setSearchAddress(propAddress);
  }, [propAddress]);

  // ── Copy handler ────────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    if (!pubkeyData) return;
    const text = `(${pubkeyData.x}, ${pubkeyData.y})`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [pubkeyData]);

  // ── Search handler ──────────────────────────────────────────────────────
  const handleSearch = useCallback(() => {
    const err = validateAddress(searchAddress);
    setSearchError(err);
    if (err) return;
    onSearch?.(searchAddress.trim());
  }, [searchAddress, onSearch]);

  // ── Determine pubkey state ──────────────────────────────────────────────
  const isUnregistered =
    pubkeyData && isIdentityPoint(pubkeyData.x, pubkeyData.y);
  const hasPubkey = pubkeyData && !isUnregistered;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className={`space-y-3 ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Fingerprint className="w-4 h-4 text-muted-foreground" />
        <Label className="text-sm font-medium">Recipient Encryption Pubkey</Label>
      </div>

      {/* Interactive search bar */}
      {interactive && (
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="text"
              placeholder="0x0000000000000000"
              value={searchAddress}
              onChange={(e) => {
                setSearchAddress(e.target.value);
                setSearchError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              disabled={isLoading}
              aria-invalid={searchError ? true : undefined}
              className="font-mono text-sm"
            />
            {searchError && (
              <p className="text-xs text-destructive mt-1">{searchError}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="default"
            onClick={handleSearch}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </Button>
        </div>
      )}

      {/* Pubkey display area */}
      <div className="rounded-lg border border-border bg-muted/30 p-3 min-h-[60px] flex items-center">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Fetching pubkey...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        ) : isUnregistered ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Key className="w-4 h-4 shrink-0" />
            No pubkey registered. Recipient must register first.
          </div>
        ) : hasPubkey ? (
          <div className="w-full">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Key className="w-3 h-3" />
                  <span className="font-mono">
                    x: {formatHexCoord(pubkeyData.x)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Key className="w-3 h-3 opacity-0" />
                  <span className="font-mono">
                    y: {formatHexCoord(pubkeyData.y)}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleCopy}
                title="Copy full pubkey"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Search className="w-4 h-4 shrink-0" />
            Enter an address to look up their pubkey
          </div>
        )}
      </div>
    </div>
  );
}
