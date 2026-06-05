"use client";

/// Testnet environment banner + faucet CTA.
/// Shows a persistent "Testnet" label so users know this is not mainnet.
/// Mainnet launch is pending security audit completion.

import Link from "next/link";
import { FlaskConical, Droplet } from "lucide-react";

export default function MainnetCountdown() {
  return (
    <div className="sticky top-0 z-50 w-full border-b border-[#D4AF37]/30 bg-gradient-to-r from-[#D4AF37]/8 via-[#0A1628]/95 to-[#D4AF37]/8 backdrop-blur px-4 py-2 text-xs">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FlaskConical className="w-3.5 h-3.5 shrink-0 text-[#D4AF37]" />
          <span className="text-foreground/90 truncate">
            <strong className="text-[#D4AF37]">Testnet demo</strong>
            <span className="hidden sm:inline text-foreground/60">
              {" "}· Flow EVM testnet (chainId 545) · Funds have no real value · Mainnet pending audit
            </span>
          </span>
        </div>
        <Link
          href="/faucet"
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-[#D4AF37]/40 bg-[#D4AF37]/8 text-[#D4AF37] font-medium hover:bg-[#D4AF37]/15 transition-colors"
        >
          <Droplet className="w-3 h-3" />
          <span className="hidden sm:inline">Get testnet FLOW</span>
          <span className="sm:hidden">Faucet</span>
        </Link>
      </div>
    </div>
  );
}
