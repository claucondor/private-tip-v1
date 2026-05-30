"use client";

/// PedersenCommitFormation — inline educational animation for wrap + claim.
///
/// Wrap (direction="in"):  FLOW coin enters boundary → Pedersen point materializes
/// Claim (direction="out"): Pedersen point cracks open → FLOW coin emerges
///
/// Plays once on mount, settles to static end state. Dismissible.
/// Mobile-safe: scales down on narrow viewports.

import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

interface Props {
  direction: "in" | "out";
  trigger?: boolean; // animate when true
  onDismiss?: () => void;
}

const EASE = [0.22, 1, 0.36, 1] as const;

export function PedersenCommitFormation({ direction, trigger = true, onDismiss }: Props) {
  const reduced = useReducedMotion();
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "transit" | "done">("idle");

  useEffect(() => {
    if (!trigger || dismissed) return;
    if (reduced) { setPhase("done"); return; }
    // Short delay then animate
    const t1 = setTimeout(() => setPhase("transit"), 200);
    const t2 = setTimeout(() => setPhase("done"), 3200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [trigger, dismissed, reduced]);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  if (dismissed) return null;

  const isIn = direction === "in";

  return (
    <AnimatePresence>
      {trigger && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="relative rounded-xl border border-[#B45309]/25 bg-[#0A1628]/80 backdrop-blur overflow-hidden p-4 mb-4"
        >
          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 p-1 rounded text-foreground/30 hover:text-foreground/70 transition-colors"
            aria-label="Dismiss animation"
          >
            <X className="w-3.5 h-3.5" />
          </button>

          <p className="text-[10px] uppercase tracking-widest text-[#B45309]/70 font-semibold mb-3">
            {isIn ? "What happens when you wrap" : "What happens when you unwrap"}
          </p>

          {/* Animation stage */}
          <div className="relative h-20 flex items-center justify-center overflow-hidden select-none">

            {/* Left side label */}
            <span className="absolute left-0 text-[9px] text-foreground/40 uppercase tracking-wider text-center w-16">
              {isIn ? "Public FLOW" : "Shielded zone"}
            </span>

            {/* Coin / Point — left actor */}
            <motion.div
              className="absolute"
              style={{ left: isIn ? 60 : "auto", right: isIn ? "auto" : 60 }}
              animate={
                phase === "transit"
                  ? isIn
                    ? { x: [0, 68, 68], opacity: [1, 1, 0], scale: [1, 0.8, 0] }
                    : { x: [0, 0, 0], opacity: [0, 0, 0] } // hidden for "out" path
                  : phase === "done" && isIn
                    ? { x: 68, opacity: 0, scale: 0 }
                    : {}
              }
              transition={{ duration: 2.2, ease: EASE, times: [0, 0.45, 1] }}
            >
              <div className="w-10 h-10 rounded-full bg-[#B45309]/20 border border-[#B45309]/40 flex items-center justify-center shadow-[0_0_12px_color-mix(in_oklch,#B45309_20%,transparent)]">
                <span className="text-[#B45309] font-bold text-xs font-mono">⬡</span>
              </div>
            </motion.div>

            {/* Boundary gate */}
            <motion.div
              className="absolute flex flex-col items-center gap-0.5"
              animate={
                phase === "transit"
                  ? { scaleY: [1, 1.15, 1], borderColor: ["rgba(0,239,139,0.3)", "rgba(0,239,139,0.7)", "rgba(0,239,139,0.3)"] }
                  : {}
              }
              transition={{ duration: 1.5, ease: "easeInOut", delay: 0.5 }}
            >
              <div className="h-10 w-px bg-gradient-to-b from-transparent via-[#00EF8B]/50 to-transparent" />
              <span className="text-[8px] text-[#00EF8B]/60 uppercase tracking-wider">boundary</span>
              <div className="h-10 w-px bg-gradient-to-b from-transparent via-[#00EF8B]/50 to-transparent" />
            </motion.div>

            {/* Pedersen commitment point — right actor for "in", left for "out" */}
            {isIn ? (
              <motion.div
                className="absolute right-4"
                animate={
                  phase === "transit"
                    ? { scale: [0, 0.5, 1.1, 1], opacity: [0, 0, 1, 1] }
                    : phase === "done"
                      ? { scale: 1, opacity: 1 }
                      : { scale: 0, opacity: 0 }
                }
                transition={{ duration: 2.2, ease: EASE, times: [0, 0.45, 0.8, 1] }}
              >
                <div className="w-10 h-10 rounded-full bg-[#6B46C1]/20 border border-[#6B46C1]/50 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#6B46C1_25%,transparent)]">
                  <span className="text-[#6B46C1] font-mono text-[10px] font-bold">P</span>
                </div>
                {phase === "done" && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[8px] text-[#6B46C1]/70"
                  >
                    commit point
                  </motion.div>
                )}
              </motion.div>
            ) : (
              // "out" — commitment cracks, FLOW emerges
              <>
                <motion.div
                  className="absolute left-4"
                  animate={
                    phase === "transit"
                      ? { scale: [1, 1.2, 1.4, 2], opacity: [1, 1, 0.4, 0] }
                      : phase === "done"
                        ? { scale: 2, opacity: 0 }
                        : { scale: 1, opacity: 1 }
                  }
                  transition={{ duration: 2.2, ease: EASE, times: [0, 0.3, 0.6, 1] }}
                >
                  <div className="w-10 h-10 rounded-full bg-[#6B46C1]/20 border border-[#6B46C1]/50 flex items-center justify-center">
                    <span className="text-[#6B46C1] font-mono text-[10px] font-bold">P</span>
                  </div>
                </motion.div>
                <motion.div
                  className="absolute right-4"
                  animate={
                    phase === "transit"
                      ? { scale: [0, 0.6, 1], opacity: [0, 0.5, 1], x: [0, 10, 0] }
                      : phase === "done"
                        ? { scale: 1, opacity: 1 }
                        : { scale: 0, opacity: 0 }
                  }
                  transition={{ duration: 2.2, ease: EASE, times: [0, 0.55, 1] }}
                >
                  <div className="w-10 h-10 rounded-full bg-[#B45309]/20 border border-[#B45309]/40 flex items-center justify-center shadow-[0_0_12px_color-mix(in_oklch,#B45309_20%,transparent)]">
                    <span className="text-[#B45309] font-bold text-xs font-mono">⬡</span>
                  </div>
                  {phase === "done" && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.2 }}
                      className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[8px] text-[#B45309]/70"
                    >
                      public FLOW
                    </motion.div>
                  )}
                </motion.div>
              </>
            )}

            {/* Right side label */}
            <span className="absolute right-0 text-[9px] text-foreground/40 uppercase tracking-wider text-center w-16">
              {isIn ? "Shielded zone" : "Public FLOW"}
            </span>
          </div>

          {/* Caption */}
          <p className="text-[10px] text-foreground/50 text-center mt-5">
            {isIn
              ? phase === "done"
                ? "Done — your value is now opaque on-chain."
                : "FLOW crosses the boundary → Pedersen commitment forms."
              : phase === "done"
                ? "Done — amount is now visible at the exit boundary."
                : "Commitment opens at the boundary → FLOW becomes public."}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
