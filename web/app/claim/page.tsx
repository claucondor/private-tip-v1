/// Claim page — v0.8.2 — consume inbox notes into shielded balance.
///
/// This page handles ONLY the inbox-claim flow:
///   1. Read pending inbox notes for the selected token
///   2. Decrypt locally with memoPrivkey
///   3. Generate batch-claim proof (circuit pads to N=10 with zeros if count < 10)
///   4. Submit atomic tx: drainAll + claimBatch + ShieldedCheckpoint.update
///
/// For withdrawing shielded balance to your underlying wallet, use /withdraw.
///
/// Token routing: FLOW + mUSDC → cadenceTx.claimBatchAtomic
///                MockFT (cadence-ft) → cadenceTx.claimBatchFtAtomic

"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import { ArrowLeft, Wallet, Inbox, ArrowRight } from "lucide-react";
import Link from "next/link";

import { BatchClaimCTA } from "@/components/BatchClaimCTA";
import { TokenSelector } from "@/components/TokenSelector";
import { type TokenId, getTokenMeta } from "@/lib/tokens";
import { TOKEN_PROXIES } from "@/lib/tip-actions";

const EASE = [0.22, 1, 0.36, 1] as const;

function ClaimPageInner() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const searchParams = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "flow") as TokenId;
  const [selectedToken, setSelectedToken] = useState<TokenId>(initialToken);

  const symbol = getTokenMeta(selectedToken).symbol;

  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/portfolio" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Portfolio
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#6B46C1]/12 border border-[#6B46C1]/30 flex items-center justify-center mb-6">
            <Wallet className="w-8 h-8 text-[#8B5CF6]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Connect Your Wallet
          </h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">
            Connect your wallet to claim pending inbox tips.
          </p>
          <motion.button
            onClick={() => authenticate()}
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
            className="janus-button-primary px-6 py-3 rounded-xl text-base"
          >
            Connect Wallet
          </motion.button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12 janus-page">
      <div className="mb-8">
        <Link href="/portfolio" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />Portfolio
        </Link>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="flex items-center gap-3 mb-8"
      >
        <div className="w-10 h-10 rounded-lg bg-[#6B46C1]/12 border border-[#6B46C1]/30 flex items-center justify-center">
          <Inbox className="w-5 h-5 text-[#8B5CF6]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
            Claim {symbol} tips
          </h1>
          <p className="text-sm text-foreground/50">
            Absorb inbox notes into your private shielded balance — stays inside the pool.
          </p>
        </div>
      </motion.div>

      {/* Token selector */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE, delay: 0.04 }}
        className="mb-4"
      >
        <TokenSelector
          value={selectedToken}
          onChange={setSelectedToken}
          label="Token to claim"
        />
      </motion.div>

      {/* Core claim CTA */}
      <BatchClaimCTA
        userAddress={userAddress}
        tokenId={selectedToken}
        tokenAddress={TOKEN_PROXIES[selectedToken]}
        onClaimed={() => { /* UI updates automatically via inboxCount reset */ }}
      />

      {/* Divider + withdraw link */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.15 }}
        className="mt-6 pt-5 border-t border-white/8"
      >
        <p className="text-xs text-foreground/40 mb-3">
          After claiming, your inbox tips become part of your shielded balance.
          To move them to your regular wallet, use Withdraw.
        </p>
        <Link
          href={`/withdraw?token=${selectedToken}`}
          className="inline-flex items-center gap-1.5 text-xs text-foreground/50 hover:text-foreground transition-colors"
        >
          Go to Withdraw
          <ArrowRight className="w-3 h-3" />
        </Link>
      </motion.div>
    </div>
  );
}

export default function ClaimPage() {
  return (
    <Suspense fallback={<div className="max-w-lg mx-auto px-4 py-12" />}>
      <ClaimPageInner />
    </Suspense>
  );
}
