"use client";

/// TokenSelector — dropdown for selecting which Janus token to use.
/// Used on Wrap, Send, Claim pages.

import { SUPPORTED_TOKENS, type TokenId } from "@/lib/tokens";

const TOKEN_ICONS: Record<TokenId, string> = {
  flow:     "⬡",
  wflow:    "↻",
  mockusdc: "$",
  mockft:   "T",
};

interface TokenSelectorProps {
  value: TokenId;
  onChange: (id: TokenId) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function TokenSelector({
  value,
  onChange,
  disabled = false,
  label = "Token",
  className = "",
}: TokenSelectorProps) {
  return (
    <div className={className}>
      {label && (
        <label className="text-xs font-medium text-foreground/50 mb-1 block">{label}</label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as TokenId)}
          disabled={disabled}
          className="w-full appearance-none px-3 py-2 pr-8 rounded border border-white/15 bg-[#0D1E38]/80 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[#00EF8B]/40 focus:border-[#00EF8B]/40 disabled:opacity-50 cursor-pointer"
        >
          {SUPPORTED_TOKENS.map((t) => (
            <option key={t.id} value={t.id}>
              {TOKEN_ICONS[t.id]} {t.label}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
          <svg className="w-4 h-4 text-foreground/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Inline token badge for display. */
export function TokenBadge({ id }: { id: TokenId }) {
  const token = SUPPORTED_TOKENS.find((t) => t.id === id);
  if (!token) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-[#00EF8B]/25 bg-[#00EF8B]/8 text-[#00EF8B]">
      <span>{TOKEN_ICONS[id]}</span>
      <span>{token.label}</span>
    </span>
  );
}
