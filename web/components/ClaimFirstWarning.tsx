import Link from "next/link";

interface ClaimFirstWarningProps {
  pendingCount: number;
  tokenSymbol: string;
  variant: "wrap" | "send";
}

export function ClaimFirstWarning({ pendingCount, tokenSymbol, variant }: ClaimFirstWarningProps) {
  if (pendingCount === 0) return null;

  const text =
    variant === "wrap"
      ? `⚠ You have ${pendingCount} pending ${tokenSymbol} note${pendingCount !== 1 ? "s" : ""}. Claim them first before wrapping to avoid checkpoint mismatch.`
      : `⚠ You have ${pendingCount} pending ${tokenSymbol} note${pendingCount !== 1 ? "s" : ""}. Claim them first before sending to avoid corrupting your shielded slot.`;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 px-3 py-3 mb-4 flex items-start justify-between gap-3 text-xs">
      <span className="text-amber-200/90 leading-relaxed">{text}</span>
      <Link
        href="/portfolio"
        className="shrink-0 px-2.5 py-1 rounded border border-amber-500/50 bg-amber-500/10 text-amber-200 font-medium hover:bg-amber-500/20 transition-colors text-[11px] whitespace-nowrap"
      >
        Go to portfolio
      </Link>
    </div>
  );
}
