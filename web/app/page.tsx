/// Home page — PrivateTip landing screen.
///
/// Janus dark theme hero with animated privacy-flow visualization + existing
/// PrivacyFlowDiagram, BigPrimitive cards, and UseCaseTag chips below.

"use client";

import { useRouter } from "next/navigation";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion, useReducedMotion } from "framer-motion";
import {
  Gift,
  Lock,
  Eye,
  ArrowRight,
  Coins,
  Send,
  Key,
  Sparkles,
  ExternalLink,
} from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

// Pure helper (NOT a hook) — accepts `reduced` as input so it can be safely
// called from inside JSX without violating the Rules of Hooks. The caller
// invokes `useReducedMotion()` ONCE at the top of the component and passes
// the value in. Avoids the hook-count mismatch when called inline N times.
function fadeUp(reduced: boolean, delay = 0) {
  if (reduced) return { opacity: 1 } as const;
  return {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, ease: EASE, delay },
  };
}

// ── Hero coin flow animation ────────────────────────────────────────────────

function HeroCoinFlow() {
  const reduced = useReducedMotion();

  // Three coins travel left→right: public → shielded → public again
  const coins = [0, 1, 2];

  return (
    <div className="relative w-full max-w-sm mx-auto h-16 select-none" aria-hidden>
      {/* Track line */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-y-1/2" />

      {/* Boundary in */}
      <div className="absolute left-[30%] top-0 h-full flex flex-col items-center justify-center gap-px">
        <div className="w-px h-5 bg-[#FBBF24]/80" />
        <span className="text-[8px] text-[#FBBF24] uppercase tracking-wider whitespace-nowrap font-semibold">entry</span>
        <div className="w-px h-5 bg-[#FBBF24]/80" />
      </div>

      {/* Boundary out */}
      <div className="absolute left-[70%] top-0 h-full flex flex-col items-center justify-center gap-px">
        <div className="w-px h-5 bg-[#FBBF24]/80" />
        <span className="text-[8px] text-[#FBBF24] uppercase tracking-wider whitespace-nowrap font-semibold">exit</span>
        <div className="w-px h-5 bg-[#FBBF24]/80" />
      </div>

      {/* Shielded zone label */}
      <div className="absolute left-[32%] right-[32%] top-0 flex items-center justify-center h-full">
        <span className="text-[8px] text-[#A78BFA] uppercase tracking-widest font-semibold">hidden zone</span>
      </div>

      {/* Animated coins */}
      {coins.map((i) => (
        <motion.div
          key={i}
          className="absolute top-1/2 -translate-y-1/2"
          initial={{ left: "0%", opacity: 0 }}
          animate={
            reduced
              ? { left: "95%", opacity: 1 }
              : {
                  left: ["0%", "28%", "30%", "70%", "72%", "95%"],
                  opacity: [0, 1, 1, 1, 1, 0],
                  scale: [0.8, 1, 0.6, 0.6, 1, 0.8],
                }
          }
          transition={
            reduced
              ? {}
              : {
                  duration: 5,
                  delay: i * 1.8,
                  repeat: Infinity,
                  repeatDelay: 3.4,
                  ease: EASE,
                  times: [0, 0.28, 0.30, 0.70, 0.72, 1],
                }
          }
        >
          <motion.div
            animate={
              reduced
                ? {}
                : {
                    // After boundary: coin becomes purple commit point, before exit: back to copper
                    backgroundColor: ["#B45309", "#B45309", "#6B46C1", "#6B46C1", "#B45309", "#B45309"],
                    boxShadow: [
                      "0 0 6px rgba(180,83,9,0.4)",
                      "0 0 10px rgba(180,83,9,0.6)",
                      "0 0 12px rgba(107,70,193,0.5)",
                      "0 0 12px rgba(107,70,193,0.5)",
                      "0 0 10px rgba(180,83,9,0.6)",
                      "0 0 6px rgba(180,83,9,0.4)",
                    ],
                  }
            }
            transition={
              reduced
                ? {}
                : {
                    duration: 5,
                    delay: i * 1.8,
                    repeat: Infinity,
                    repeatDelay: 3.4,
                    times: [0, 0.28, 0.30, 0.70, 0.72, 1],
                  }
            }
            className="w-6 h-6 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "#B45309" }}
          >
            <span className="text-white/90 text-[10px] font-bold font-mono">⬡</span>
          </motion.div>
        </motion.div>
      ))}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const { user } = useFlowCurrentUser();
  const isLoggedIn = !!user?.addr;
  const reduced = useReducedMotion() ?? false;

  return (
    <div className="flex flex-col items-center janus-hex-bg">

      {/* ── HERO ────────────────────────────────────────────────────────── */}
      <section className="relative w-full min-h-screen flex flex-col items-center justify-center px-4 py-12 sm:py-20 text-center overflow-hidden">

        {/* Decorative ambient blobs */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full bg-[#00EF8B]/6 blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 rounded-full bg-[#6B46C1]/6 blur-3xl" />
          <div className="absolute top-1/3 right-0 w-64 h-64 rounded-full bg-[#B45309]/4 blur-3xl" />
        </div>

        {/* openjanus brand pill — clarifies this is a demo of the broader stack */}
        <motion.a
          {...fadeUp(reduced, 0)}
          href="https://github.com/openjanus"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 mb-6 px-3 py-1.5 rounded-full border border-[#00EF8B]/40 bg-[#00EF8B]/8 hover:bg-[#00EF8B]/15 hover:border-[#00EF8B]/60 transition-colors group"
        >
          <span className="text-[#00EF8B] text-sm font-mono leading-none" style={{ letterSpacing: "-0.1em" }} aria-hidden>⟨⟩</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-[#00EF8B]/90 font-medium">
            an openjanus demo
          </span>
          <ExternalLink className="w-3 h-3 text-[#00EF8B]/60 group-hover:text-[#00EF8B] transition-colors" />
        </motion.a>

        {/* Wordmark — slightly smaller now that the openjanus pill carries brand context */}
        <motion.div
          {...fadeUp(reduced, 0.05)}
          className="relative inline-flex items-center gap-3 mb-2"
        >
          <motion.span
            aria-hidden
            className="text-[#00EF8B] text-2xl leading-none select-none font-mono"
            style={{ letterSpacing: "-0.1em" }}
            animate={{ opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            ⟨⟩
          </motion.span>
          <h1
            className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
          >
            PrivateTip
          </h1>
        </motion.div>

        {/* Tagline */}
        <motion.p
          {...fadeUp(reduced, 0.1)}
          className="text-xl sm:text-2xl text-foreground/70 max-w-xl mx-auto mb-4"
        >
          Tip on Flow with the amount kept private.
        </motion.p>
        <motion.p
          {...fadeUp(reduced, 0.18)}
          className="text-sm text-foreground/70 max-w-lg mx-auto mb-3"
        >
          People see who tipped whom — but never how much. Powered by Pedersen
          commitments and Groth16 proofs.
        </motion.p>
        <motion.p
          {...fadeUp(reduced, 0.22)}
          className="text-[11px] text-foreground/50 max-w-lg mx-auto mb-10"
        >
          Privacy, not anonymity. Non-custodial. Sender and recipient addresses stay public on-chain.
        </motion.p>

        {/* Hero coin animation */}
        <motion.div {...fadeUp(reduced, 0.26)} className="w-full max-w-sm mb-12">
          <div className="mb-2 flex justify-between text-[10px] uppercase tracking-wider px-1 font-semibold">
            <span className="text-[#FBBF24]">Public</span>
            <span className="text-[#A78BFA]">Shielded zone</span>
            <span className="text-[#FBBF24]">Public</span>
          </div>
          <HeroCoinFlow />
          <p className="text-xs text-foreground/70 mt-3 text-center">
            Amounts become opaque at the entry boundary and re-appear only when withdrawn.
          </p>
        </motion.div>

        {/* CTAs */}
        <motion.div {...fadeUp(reduced, 0.32)} className="flex flex-col sm:flex-row items-center justify-center gap-3">
          {isLoggedIn ? (
            <>
              <motion.button
                onClick={() => router.push("/wrap")}
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                className="janus-button-primary text-base px-6 py-3 rounded-xl"
              >
                <Coins className="w-4 h-4 mr-2 inline" />
                Add private FLOW
              </motion.button>
              <motion.button
                onClick={() => router.push("/send")}
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/15 bg-white/5 text-foreground/80 text-base font-medium hover:bg-white/10 hover:text-foreground transition-colors"
              >
                Send a tip
                <ArrowRight className="w-4 h-4" />
              </motion.button>
              <motion.button
                onClick={() => router.push("/tips")}
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 bg-transparent text-foreground/60 text-sm font-medium hover:text-foreground/80 transition-colors"
              >
                View my tips
              </motion.button>
            </>
          ) : (
            <motion.p
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 3, repeat: Infinity }}
              className="text-sm text-foreground/50"
            >
              Connect your wallet to get started
            </motion.p>
          )}
        </motion.div>

        {isLoggedIn && (
          <motion.p {...fadeUp(reduced, 0.4)} className="text-xs text-foreground/30 mt-4">
            New here? Start at{" "}
            <button
              type="button"
              onClick={() => router.push("/wrap")}
              className="underline hover:text-foreground/60 transition-colors"
            >
              Add private FLOW
            </button>{" "}
            — one wallet sign + one tx and you&apos;re set.
          </motion.p>
        )}

        {/* Scroll cue */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
        >
          <motion.button
            onClick={() => router.push("/learn")}
            animate={{ y: [0, 4, 0] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            className="text-foreground/30 hover:text-foreground/60 transition-colors text-xs flex flex-col items-center gap-1"
          >
            <span>Learn how it works</span>
            <ArrowRight className="w-3.5 h-3.5 rotate-90" />
          </motion.button>
        </motion.div>
      </section>

      {/* ── HOW IT WORKS ────────────────────────────────────────────────── */}
      <section className="w-full max-w-5xl mx-auto px-4 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55, ease: EASE }}
          className="text-center mb-10"
        >
          <h2
            className="text-2xl sm:text-3xl font-bold mb-3 text-foreground"
            style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
          >
            What everyone sees vs what you see
          </h2>
          <p className="text-sm text-foreground/50 max-w-2xl mx-auto">
            The chain shows public traffic. Your wallet sees the real values.
            Amounts only become visible at the entry and exit boundaries.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
        >
          <PrivacyFlowDiagram />
        </motion.div>
      </section>

      {/* ── POWERED BY OPENJANUS ────────────────────────────────────────── */}
      <section className="w-full max-w-5xl mx-auto px-4 pb-24">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55, ease: EASE }}
          className="relative overflow-hidden rounded-3xl border border-[#6B46C1]/20 bg-[#0D1E38]/80 p-8 sm:p-12"
        >
          {/* Decorative blobs */}
          <div className="absolute -top-24 -left-24 w-72 h-72 rounded-full bg-[#6B46C1]/10 blur-3xl pointer-events-none" aria-hidden />
          <div className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full bg-[#00EF8B]/10 blur-3xl pointer-events-none" aria-hidden />

          <div className="relative">
            {/* Heading */}
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 backdrop-blur border border-[#00EF8B]/20 text-[11px] font-mono mb-4 text-foreground/70">
                <motion.span
                  className="w-1.5 h-1.5 rounded-full bg-[#00EF8B]"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
                @openjanus/sdk · v0.5.4 · audit in progress
              </div>
              <h2
                className="text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-foreground"
                style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
              >
                Privacy primitives,
                <br className="sm:hidden" /> drop-in for any Flow app.
              </h2>
              <p className="text-base text-foreground/50 max-w-2xl mx-auto">
                PrivateTip is a 250-line demo on top of openjanus. The SDK ships
                the hard parts so you can ship the app.
              </p>
            </div>

            {/* Primitives grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
              {[
                {
                  icon: <Lock className="w-5 h-5" />,
                  accent: "purple" as const,
                  name: "JanusFlow",
                  tagline: "Hidden-amount FLOW transfers",
                  detail: "Pedersen commitments + Groth16. Amounts never appear in calldata, events, or storage.",
                },
                {
                  icon: <Send className="w-5 h-5" />,
                  accent: "blue" as const,
                  name: "ShieldedNote",
                  tagline: "Encrypted recovery payload",
                  detail: "Bundles (amount, blinding, memo) — what every shielded transfer needs so recipients can reconstruct and unwrap.",
                },
                {
                  icon: <Key className="w-5 h-5" />,
                  accent: "emerald" as const,
                  name: "Sign-derive MemoKey",
                  tagline: "Wallet-derived inbox key",
                  detail: "Same wallet → same key on every device. No seed phrase, no localStorage secret, no on-chain leak.",
                },
                {
                  icon: <Sparkles className="w-5 h-5" />,
                  accent: "amber" as const,
                  name: "Groth16 + ceremony",
                  tagline: "Production-grade ZK",
                  detail: "Multi-party trusted setup (Hermez pot14 + Flow VRF beacon) backing every privacy proof.",
                  ceremony: true,
                },
                {
                  icon: <Coins className="w-5 h-5" />,
                  accent: "rose" as const,
                  name: "Cross-VM atomic ops",
                  tagline: "One tx, both chains",
                  detail: "A single Cadence transaction calls EVM Groth16 verifiers + updates storage — no bridges, no two-step UX.",
                },
                {
                  icon: <Eye className="w-5 h-5" />,
                  accent: "cyan" as const,
                  name: "Browser-safe SDK",
                  tagline: "Lazy Node imports",
                  detail: "Crypto barrel routes heavy lifting through API routes — keeps Turbopack bundles small and fast.",
                },
              ].map((p, i) => (
                <motion.div
                  key={p.name}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.45, ease: EASE, delay: i * 0.06 }}
                >
                  <BigPrimitive {...p} />
                </motion.div>
              ))}
            </div>

            {/* Boundary shimmer line */}
            <div className="janus-divider-shimmer mb-8 rounded-full" />

            {/* Use cases */}
            <div className="rounded-2xl bg-white/3 border border-white/8 p-5 mb-6">
              <p className="text-xs uppercase tracking-wider font-semibold text-foreground/40 mb-2">
                What else could you build with this?
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <UseCaseTag>Sealed-bid NFT auctions</UseCaseTag>
                <UseCaseTag>Hidden-pack openings</UseCaseTag>
                <UseCaseTag>Private trading arenas</UseCaseTag>
                <UseCaseTag>Confidential payroll</UseCaseTag>
                <UseCaseTag>Confidential donations</UseCaseTag>
                <UseCaseTag>Cross-VM privacy wallets</UseCaseTag>
              </div>
            </div>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href="https://www.npmjs.com/package/@openjanus/sdk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#00EF8B] text-[#0A1628] font-mono text-sm font-semibold hover:opacity-90 transition-opacity shadow-[0_2px_16px_color-mix(in_oklch,#00EF8B_30%,transparent)]"
              >
                npm i @openjanus/sdk
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href="https://github.com/openjanus"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-white/12 bg-white/5 text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-white/8 transition-colors"
              >
                Source & docs on GitHub
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </motion.div>
      </section>
    </div>
  );
}

// ─── Local components ──────────────────────────────────────────────────────

function PrivacyFlowDiagram() {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#0D1E38]/70 overflow-hidden shadow-sm">
      {/* Public lane */}
      <div className="bg-[#B45309]/8 border-b border-white/8 px-3 sm:px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye className="w-4 h-4 text-[#B45309]" />
          <span className="text-xs font-semibold text-[#B45309]/80">
            Public chain — what observers see
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <PublicCell label="You wrap" value="+2.0 FLOW" tone="visible" note="visible at entry" />
          <PublicCell label="You send" value="0x4e…f3a" tone="opaque" note="amount opaque" />
          <PublicCell label="Friend tips" value="0xd1…9c2" tone="opaque" note="amount opaque" />
          <PublicCell label="You withdraw" value="−1.5 FLOW" tone="visible" note="visible at exit" />
        </div>
      </div>

      {/* Boundary band — simplified on mobile (no absolute grid overlay) */}
      <div className="relative h-10 sm:h-12 bg-gradient-to-b from-[#B45309]/5 via-[#0A1628]/50 to-[#00EF8B]/5 flex items-center justify-center">
        <div className="absolute top-1/2 left-0 right-0 -translate-y-1/2 janus-divider-shimmer opacity-50" />
        <span className="relative z-10 text-[9px] uppercase tracking-widest font-semibold text-[#6B46C1]/70 bg-[#0A1628]/80 px-3 py-1 rounded-full">
          hidden zone
        </span>
      </div>

      {/* Private lane */}
      <div className="bg-[#00EF8B]/5 border-t border-white/8 px-3 sm:px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Key className="w-4 h-4 text-[#00EF8B]" />
          <span className="text-xs font-semibold text-[#00EF8B]/80">
            Your wallet — what you see
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <PrivateCell label="You wrap" value="+2.0" running="balance: 2.0" />
          <PrivateCell label="You send" value="−0.5" running="balance: 1.5" />
          <PrivateCell label="Friend tips" value="+1.0" running="balance: 2.5" />
          <PrivateCell label="You withdraw" value="−1.5" running="balance: 1.0" />
        </div>
      </div>

      {/* Caption strip */}
      <div className="border-t border-white/8 bg-white/3 px-3 sm:px-5 py-3 flex flex-col sm:flex-row flex-wrap items-start sm:items-center justify-between gap-2 text-[11px]">
        <span className="text-foreground/40 inline-flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-[#6B46C1] shrink-0" />
          Inside the hidden zone: Pedersen commitments hide amounts, ECIES encrypts memos.
        </span>
        <span className="text-foreground/40 inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3 text-[#D4AF37] shrink-0" />
          Sender ↔ recipient stays public — that&apos;s the social proof part of tipping.
        </span>
      </div>
    </div>
  );
}

function PublicCell({ label, value, tone, note }: { label: string; value: string; tone: "visible" | "opaque"; note: string }) {
  const visible = tone === "visible";
  return (
    <div className="flex flex-col items-center text-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-foreground/40">{label}</span>
      <span
        className={`px-2 py-1 rounded text-xs font-mono font-semibold tabular-nums ${
          visible
            ? "bg-[#B45309]/15 text-[#B45309]"
            : "bg-white/5 text-white/20 blur-[0.5px]"
        }`}
      >
        {value}
      </span>
      <span className="text-[10px] text-foreground/30 italic">{note}</span>
    </div>
  );
}

function PrivateCell({ label, value, running }: { label: string; value: string; running: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-foreground/40">{label}</span>
      <span className="px-2 py-1 rounded text-xs font-mono font-semibold tabular-nums bg-[#00EF8B]/15 text-[#00EF8B]">
        {value}
      </span>
      <span className="text-[10px] text-[#00EF8B]/60 font-mono">{running}</span>
    </div>
  );
}

function BoundaryArrow({ direction, label }: { direction: "down" | "up"; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-[#B45309]">
      <div className="relative h-6 w-px bg-[#B45309]/50">
        <div className={`absolute left-1/2 -translate-x-1/2 ${direction === "down" ? "bottom-0" : "top-0"}`}>
          <ArrowRight className={`w-3 h-3 ${direction === "down" ? "rotate-90" : "-rotate-90"}`} />
        </div>
      </div>
      <span className="text-[9px] mt-0.5 whitespace-nowrap font-medium text-[#B45309]/70">{label}</span>
    </div>
  );
}

function PrivacyBand({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-foreground/30">
      <div className="h-6 w-full border-t-2 border-dashed border-[#6B46C1]/30 relative">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[9px] uppercase tracking-wider bg-[#0A1628] px-1.5 text-[#6B46C1]/50">{label}</span>
        </div>
      </div>
      <span className="text-[9px] mt-0.5 italic text-[#6B46C1]/40">no amounts leak</span>
    </div>
  );
}

interface BigPrimitiveProps {
  icon: React.ReactNode;
  accent: "purple" | "blue" | "emerald" | "amber" | "rose" | "cyan";
  name: string;
  tagline: string;
  detail: string;
  ceremony?: boolean;
}

const BIG_ACCENT: Record<BigPrimitiveProps["accent"], string> = {
  purple: "bg-[#6B46C1]/15 text-purple-300 ring-[#6B46C1]/25",
  blue: "bg-blue-950/50 text-blue-300 ring-blue-700/30",
  emerald: "bg-[#00EF8B]/12 text-[#00EF8B] ring-[#00EF8B]/25",
  amber: "bg-[#D4AF37]/12 text-[#D4AF37] ring-[#D4AF37]/25",
  rose: "bg-rose-950/50 text-rose-300 ring-rose-700/30",
  cyan: "bg-cyan-950/50 text-cyan-300 ring-cyan-700/30",
};

function BigPrimitive({ icon, accent, name, tagline, detail, ceremony }: BigPrimitiveProps) {
  return (
    <motion.div
      whileHover={{ y: -2, boxShadow: "0 4px 24px rgba(0,239,139,0.08)" }}
      transition={{ duration: 0.2 }}
      className={`janus-primitive-card bg-white/3 border-white/8 ${ceremony ? "janus-ceremony" : ""}`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ring-1 ${BIG_ACCENT[accent]}`}>
        {icon}
      </div>
      <h3 className="font-mono text-sm font-semibold text-foreground">{name}</h3>
      <p className="text-[11px] text-foreground/40 font-medium uppercase tracking-wider mb-2">{tagline}</p>
      <p className="text-xs text-foreground/60 leading-relaxed">{detail}</p>
    </motion.div>
  );
}

function UseCaseTag({ children }: { children: React.ReactNode }) {
  return (
    <motion.span
      whileHover={{ borderColor: "rgba(0,239,139,0.3)", color: "rgba(245,240,225,0.9)" }}
      transition={{ duration: 0.15 }}
      className="inline-flex items-center px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-foreground/60 font-medium text-xs cursor-default"
    >
      {children}
    </motion.span>
  );
}
