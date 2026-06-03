/// Token registry for PrivateTip v0.6 multi-token UI.
///
/// Wraps the SDK's TOKEN_REGISTRY for UI consumption. The SDK is the single
/// source of truth for addresses — never hardcode addresses here.

import { TOKEN_REGISTRY } from "@claucondor/sdk/network";

export const SUPPORTED_TOKENS = [
  { id: "flow"     as const, label: "FLOW",    symbol: "FLOW",    decimals: 18 },
  { id: "mockusdc" as const, label: "mUSDC",   symbol: "mUSDC",   decimals: 6  },
  { id: "mockft"   as const, label: "MockFT",  symbol: "MockFT",  decimals: 8  },
] as const;

export type TokenId = typeof SUPPORTED_TOKENS[number]["id"];

export type TokenMeta = typeof SUPPORTED_TOKENS[number];

/** Get metadata for a given token ID. */
export function getTokenMeta(id: TokenId): TokenMeta {
  const meta = SUPPORTED_TOKENS.find((t) => t.id === id);
  if (!meta) throw new Error(`Unknown token: ${id}`);
  return meta;
}

/** Get the SDK TOKEN_REGISTRY entry for a given token ID (addresses etc.) */
export function getTokenRegistryEntry(id: TokenId): typeof TOKEN_REGISTRY[keyof typeof TOKEN_REGISTRY] {
  return TOKEN_REGISTRY[id];
}

/**
 * Format a raw amount in token units to a display string.
 * Handles different decimal places per token.
 */
export function formatTokenAmount(amount: bigint, tokenId: TokenId, displayDecimals = 4): string {
  const meta = getTokenMeta(tokenId);
  const scale = 10n ** BigInt(meta.decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  const fracStr = frac.toString().padStart(meta.decimals, "0").slice(0, displayDecimals);
  return `${whole}.${fracStr}`;
}

/**
 * Parse a user-entered string amount to raw token units.
 */
export function parseTokenAmount(amount: string, tokenId: TokenId): bigint {
  const meta = getTokenMeta(tokenId);
  const decimals = meta.decimals;
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(fracPadded || "0");
}
