"use client";

/// 10-day countdown to mainnet launch + faucet CTA.
/// Target: 2026-06-11 (10 days from 2026-06-01).
/// After target date, banner switches to "We launched" message.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Rocket, Droplet } from "lucide-react";

const MAINNET_TARGET = new Date("2026-06-11T00:00:00Z").getTime();

function getRemaining() {
  const diff = MAINNET_TARGET - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return { days, hours, minutes };
}

export default function MainnetCountdown() {
  const [remaining, setRemaining] = useState<ReturnType<typeof getRemaining>>(
    null
  );
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setRemaining(getRemaining());
    const i = setInterval(() => setRemaining(getRemaining()), 60_000);
    return () => clearInterval(i);
  }, []);

  if (!mounted) return null;

  const launched = remaining === null;

  return (
    <div className="sticky top-0 z-50 w-full border-b border-[#00EF8B]/30 bg-gradient-to-r from-[#00EF8B]/10 via-[#0A1628]/95 to-[#D4AF37]/10 backdrop-blur px-4 py-2 text-xs">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Rocket className="w-3.5 h-3.5 shrink-0 text-[#00EF8B]" />
          {launched ? (
            <span className="text-foreground/90 truncate">
              <strong className="text-[#00EF8B]">PrivateTip is live on mainnet.</strong>
              <span className="hidden sm:inline"> Try the testnet demo →</span>
            </span>
          ) : (
            <span className="text-foreground/90 truncate">
              <strong className="text-[#00EF8B]">Mainnet in</strong>{" "}
              <span className="font-mono text-[#D4AF37]">
                {remaining.days}d {remaining.hours}h
              </span>
              <span className="hidden sm:inline text-foreground/70">
                {" "}
                · Consent-required privacy, audited before launch
              </span>
            </span>
          )}
        </div>
        <Link
          href="/faucet"
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-[#00EF8B]/40 bg-[#00EF8B]/5 text-[#00EF8B] font-medium hover:bg-[#00EF8B]/15 transition-colors"
        >
          <Droplet className="w-3 h-3" />
          <span className="hidden sm:inline">Get testnet FLOW</span>
          <span className="sm:hidden">Faucet</span>
        </Link>
      </div>
    </div>
  );
}
