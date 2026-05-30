"use client";

/// ShieldedNoteEncrypt — inline educational animation for the send flow.
///
/// Shows: plaintext note → encrypts to ciphertext bytes → flies to recipient lock.
/// Plays once when trigger=true, settles to static end state. Dismissible.

import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Lock, X } from "lucide-react";

interface Props {
  trigger?: boolean;
  success?: boolean; // after send — show "recipient can decrypt"
  onDismiss?: () => void;
}

const EASE = [0.22, 1, 0.36, 1] as const;

const CIPHERTEXT_CHARS = ["a3f", "7c2", "e9b", "4d1", "8f5", "2a0", "6e3", "1b7"];

export function ShieldedNoteEncrypt({ trigger = true, success = false, onDismiss }: Props) {
  const reduced = useReducedMotion();
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "encrypting" | "done">("idle");

  useEffect(() => {
    if (!trigger || dismissed) return;
    if (reduced) { setPhase("done"); return; }
    const t1 = setTimeout(() => setPhase("encrypting"), 300);
    const t2 = setTimeout(() => setPhase("done"), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [trigger, dismissed, reduced]);

  useEffect(() => {
    // Reset when trigger goes false then true again
    if (!trigger) setPhase("idle");
  }, [trigger]);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  if (dismissed) return null;

  return (
    <AnimatePresence>
      {trigger && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="relative rounded-xl border border-[#6B46C1]/25 bg-[#0A1628]/80 backdrop-blur overflow-hidden p-4 mb-4"
        >
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 p-1 rounded text-foreground/30 hover:text-foreground/70 transition-colors"
            aria-label="Dismiss animation"
          >
            <X className="w-3.5 h-3.5" />
          </button>

          <p className="text-[10px] uppercase tracking-widest text-[#6B46C1]/70 font-semibold mb-3">
            {success ? "Tip delivered privately" : "What happens when you send"}
          </p>

          <div className="relative h-16 flex items-center justify-center overflow-hidden select-none gap-3">

            {/* Note source (left) */}
            <motion.div
              className="shrink-0 flex flex-col items-center gap-1"
              animate={
                phase === "encrypting"
                  ? { opacity: [1, 0.4, 0] }
                  : phase === "done"
                    ? { opacity: 0 }
                    : { opacity: 1 }
              }
              transition={{ duration: 1.5, ease: "easeIn", times: [0, 0.6, 1] }}
            >
              <div className="px-2 py-1 rounded bg-[#00EF8B]/10 border border-[#00EF8B]/25 text-[10px] font-mono text-[#00EF8B]">
                1.5 FLOW
              </div>
              <span className="text-[8px] text-foreground/30">plaintext</span>
            </motion.div>

            {/* Cipher bytes flying across */}
            <div className="flex-1 relative h-10">
              {CIPHERTEXT_CHARS.map((char, i) => (
                <motion.span
                  key={char + i}
                  className="absolute font-mono text-[9px] text-[#6B46C1]/70"
                  style={{ top: `${(i % 3) * 12}px`, left: `${i * 12}%` }}
                  initial={{ opacity: 0, x: -10 }}
                  animate={
                    phase === "encrypting" || phase === "done"
                      ? {
                          opacity: [0, 1, phase === "done" ? 0 : 1],
                          x: [0, 30, phase === "done" ? 80 : 30],
                        }
                      : { opacity: 0 }
                  }
                  transition={{
                    duration: 2,
                    delay: i * 0.12,
                    ease: EASE,
                    times: [0, 0.5, 1],
                  }}
                >
                  {char}
                </motion.span>
              ))}
            </div>

            {/* Lock (right) */}
            <motion.div
              className="shrink-0 flex flex-col items-center gap-1"
              animate={
                phase === "done"
                  ? { scale: [0.9, 1.1, 1], opacity: 1 }
                  : { scale: 1, opacity: phase === "encrypting" ? 0.6 : 0.4 }
              }
              transition={{ duration: 0.5, ease: EASE }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center"
                style={{
                  background: phase === "done" ? "rgba(0,239,139,0.15)" : "rgba(107,70,193,0.12)",
                  border: `1px solid ${phase === "done" ? "rgba(0,239,139,0.3)" : "rgba(107,70,193,0.25)"}`,
                  boxShadow: phase === "done" ? "0 0 16px rgba(0,239,139,0.2)" : "none",
                  transition: "all 0.5s ease",
                }}
              >
                <Lock className="w-4 h-4" style={{ color: phase === "done" ? "#00EF8B" : "#6B46C1" }} />
              </div>
              <span className="text-[8px] text-foreground/30">
                {phase === "done" ? "recipient key" : "MemoKey"}
              </span>
            </motion.div>
          </div>

          <p className="text-[10px] text-foreground/50 text-center mt-2">
            {success
              ? "The recipient can decrypt this with their MemoKey — no one else can."
              : phase === "done"
                ? "Amount encrypted. Only the recipient's MemoKey can read it."
                : "Your tip is being encrypted to the recipient's public key."}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
