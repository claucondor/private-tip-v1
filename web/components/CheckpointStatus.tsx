"use client";

/// CheckpointStatus — compact chip showing whether the current user has an
/// on-chain ShieldedCheckpoint for a given token, and if so, its version + last updated block.
///
/// v0.8.2 (C.2): now accepts tokenAddress prop for per-token status.
/// Resolves COA from the Flow Cadence address, then reads public checkpoint
/// metadata (no signer required — metadata() is a public view).

import { useState, useEffect } from "react";
import { ShieldedCheckpointClient, getCoaEvmAddress, TOKEN_REGISTRY } from "@claucondor/sdk";
import type { CheckpointMetadata } from "@claucondor/sdk";
import { Loader2 } from "lucide-react";

interface CheckpointStatusProps {
  userAddress: string | null;
  /** EVM proxy address of the token to check. Defaults to FLOW proxy. */
  tokenAddress?: string;
  /** Short label shown on the chip (e.g. "FLOW", "mUSDC", "MockFT"). */
  tokenLabel?: string;
  /** Extra class names for the chip wrapper. */
  className?: string;
  /** When true, append "(singleton — v0.8.3)" note to the chip label. */
  singletonNote?: boolean;
}

export default function CheckpointStatus({
  userAddress,
  tokenAddress,
  tokenLabel,
  className = "",
  singletonNote = false,
}: CheckpointStatusProps) {
  const resolvedTokenAddress = tokenAddress ?? TOKEN_REGISTRY.flow.proxy;

  const [loading, setLoading] = useState(false);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<CheckpointMetadata | null>(null);

  useEffect(() => {
    if (!userAddress) {
      setInstalled(null);
      setMeta(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // Resolve COA EVM address from Flow Cadence address
        const coaAddr = await getCoaEvmAddress(userAddress, "testnet").catch(() => null);
        if (!coaAddr || coaAddr === "0x" || coaAddr.length < 5) {
          if (!cancelled) {
            setInstalled(false);
            setLoading(false);
          }
          return;
        }
        if (cancelled) return;

        const client = new ShieldedCheckpointClient();
        const [exists, metadata] = await Promise.all([
          client.exists(coaAddr, resolvedTokenAddress).catch(() => false),
          client.metadata(coaAddr, resolvedTokenAddress).catch(() => null),
        ]);

        if (cancelled) return;
        setInstalled(exists);
        setMeta(metadata);
      } catch {
        if (!cancelled) setInstalled(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userAddress, resolvedTokenAddress]);

  if (!userAddress) return null;

  const labelPrefix = tokenLabel ? `${tokenLabel}: ` : "";
  const singletonSuffix = singletonNote ? " (singleton — v0.8.3)" : "";

  if (loading) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border border-white/15 bg-white/5 text-foreground/50 ${className}`}
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        {labelPrefix}Loading…
      </span>
    );
  }

  if (!installed) {
    // No checkpoint yet — not a setup error, just no shielded state for this token.
    // Checkpoint is created on the user's first wrap+update for this token.
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border border-white/15 bg-white/5 text-foreground/60 ${className}`}
      >
        {labelPrefix}No shielded state yet{singletonSuffix}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border border-[#00EF8B]/25 bg-[#00EF8B]/8 text-[#00EF8B] ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[#00EF8B] shrink-0" />
      {labelPrefix}
      {meta
        ? `v${meta.version} · block ${meta.lastUpdatedBlock}${singletonSuffix}`
        : `Installed${singletonSuffix}`}
    </span>
  );
}
