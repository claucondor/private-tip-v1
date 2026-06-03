"use client";

/// ShieldedNoteLifecycle — 4-step interactive animation for /learn
///
/// Step 1: Sender constructs payload (amount, blinding, memo slide in)
/// Step 2: ECIES encryption (eph keypair → ECDH → AES key → ciphertext)
/// Step 3: Envelope flies on-chain (sender → chain → recipient)
/// Step 4: Recipient decrypts (click-triggered: MemoKey → plaintext reveals)
///
/// Auto-plays steps 1–3, then waits for user click to trigger step 4.
/// Replay button restarts from step 1.
/// useReducedMotion: snaps straight to step 4 final state.

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Lock, Key, ArrowRight, RefreshCw, Zap } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

type Step = 0 | 1 | 2 | 3 | 4; // 0=idle, 1=construct, 2=encrypt, 3=fly, 4=decrypt

// ── Sub-component: field slide-in row ───────────────────────────────────────

function FieldRow({
  label,
  value,
  color,
  delay,
  visible,
}: {
  label: string;
  value: string;
  color: string;
  delay: number;
  visible: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={reduced ? { opacity: 1, x: 0 } : { opacity: 0, x: -28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.45, ease: EASE, delay: reduced ? 0 : delay }}
          className="flex items-center gap-2 font-mono text-[11px] sm:text-xs"
        >
          <span className="text-foreground/40 w-16 shrink-0">{label}:</span>
          <span
            className="px-2 py-0.5 rounded font-semibold"
            style={{ color, background: color + "18", border: `1px solid ${color}30` }}
          >
            {value}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Sub-component: ECIES flow row ────────────────────────────────────────────

function ECIESRow({
  label,
  value,
  arrow,
  delay,
  visible,
  color = "#A78BFA",
}: {
  label: string;
  value: string;
  arrow?: string;
  delay: number;
  visible: boolean;
  color?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: reduced ? 0 : delay }}
          className="flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] flex-wrap"
        >
          <span className="text-foreground/40 shrink-0">{label}</span>
          {arrow && <span className="text-foreground/30">{arrow}</span>}
          <span style={{ color }} className="font-semibold break-all">{value}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ShieldedNoteLifecycle() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState<Step>(reduced ? 4 : 0);
  const [fieldCount, setFieldCount] = useState(0); // 0→3 fields appear in step 1
  const [eciesPhase, setEciesPhase] = useState(0); // 0→4 rows appear in step 2
  const [envelopePos, setEnvelopePos] = useState(0); // 0=left, 1=mid, 2=right
  const [decrypting, setDecrypting] = useState(false);
  const [decryptCount, setDecryptCount] = useState(0); // fields revealed 0→3
  const timerRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAllTimers = useCallback(() => {
    timerRef.current.forEach(clearTimeout);
    timerRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timerRef.current.push(t);
    return t;
  }, []);

  // ── Auto-play sequence ──────────────────────────────────────────────────────
  const startSequence = useCallback(() => {
    if (reduced) { setStep(4); setDecryptCount(3); return; }
    clearAllTimers();

    // Step 1: construct — fields slide in one by one
    setStep(1);
    setFieldCount(0);
    setEciesPhase(0);
    setEnvelopePos(0);
    setDecrypting(false);
    setDecryptCount(0);

    schedule(() => setFieldCount(1), 400);
    schedule(() => setFieldCount(2), 900);
    schedule(() => setFieldCount(3), 1400);

    // Step 2: encrypt
    schedule(() => {
      setStep(2);
      setEciesPhase(0);
    }, 2200);
    schedule(() => setEciesPhase(1), 2700);
    schedule(() => setEciesPhase(2), 3300);
    schedule(() => setEciesPhase(3), 3900);
    schedule(() => setEciesPhase(4), 4500);

    // Step 3: envelope flies
    schedule(() => {
      setStep(3);
      setEnvelopePos(0);
    }, 5600);
    schedule(() => setEnvelopePos(1), 6200);
    schedule(() => setEnvelopePos(2), 7200);

    // Step 4: wait for click — just set step
    schedule(() => setStep(4), 8000);
  }, [reduced, clearAllTimers, schedule]);

  useEffect(() => {
    startSequence();
    return clearAllTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDecrypt = useCallback(() => {
    if (decrypting || decryptCount === 3) return;
    setDecrypting(true);
    if (reduced) {
      setDecryptCount(3);
      return;
    }
    schedule(() => setDecryptCount(1), 400);
    schedule(() => setDecryptCount(2), 900);
    schedule(() => setDecryptCount(3), 1400);
  }, [decrypting, decryptCount, reduced, schedule]);

  const handleReplay = useCallback(() => {
    clearAllTimers();
    setDecrypting(false);
    setDecryptCount(0);
    startSequence();
  }, [clearAllTimers, startSequence]);

  // ── Step labels ─────────────────────────────────────────────────────────────
  const stepLabels: Record<Step, string> = {
    0: "Initializing…",
    1: "Sender packages the secret values",
    2: "ECIES turns it into ciphertext only the recipient can read",
    3: "The encrypted blob travels on-chain",
    4: decryptCount === 3
      ? "Recipient decrypted — all fields recovered"
      : "Recipient decrypts with their MemoKey privkey",
  };

  // ── Envelope X position percent for horizontal animation ───────────────────
  const envXPercent = envelopePos === 0 ? "0%" : envelopePos === 1 ? "40%" : "85%";

  return (
    <div className="rounded-2xl border border-[#A78BFA]/25 bg-[#0A1628]/60 backdrop-blur overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#A78BFA]/15 bg-[#A78BFA]/5">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#A78BFA] animate-pulse" />
          <span className="text-[10px] uppercase tracking-widest font-bold text-[#A78BFA]">
            ShieldedNote lifecycle
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Step indicators */}
          {([1, 2, 3, 4] as const).map((s) => (
            <div
              key={s}
              className="w-1.5 h-1.5 rounded-full transition-all duration-300"
              style={{
                background: step >= s ? "#A78BFA" : "rgba(167,139,250,0.2)",
                boxShadow: step === s ? "0 0 6px #A78BFA" : "none",
              }}
            />
          ))}
          <button
            type="button"
            onClick={handleReplay}
            className="ml-2 p-1 rounded text-foreground/30 hover:text-[#A78BFA] transition-colors"
            title="Replay"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Main stage — two columns: sender (left) + recipient (right) */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-0 min-h-[260px]">

        {/* ── LEFT: Sender panel ─────────────────────────────────────────────── */}
        <div className="p-4 border-b sm:border-b-0 sm:border-r border-[#A78BFA]/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-[#FBBF24]/15 border border-[#FBBF24]/30 flex items-center justify-center">
              <span className="text-sm">🧑</span>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-[#FBBF24]">Sender</span>
          </div>

          {/* Step 1: payload fields */}
          <AnimatePresence>
            {step >= 1 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-1.5 mb-3"
              >
                {/* JSON bracket open */}
                <AnimatePresence>
                  {fieldCount >= 1 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="font-mono text-[10px] text-foreground/30"
                    >
                      {"{"}
                    </motion.div>
                  )}
                </AnimatePresence>

                <FieldRow
                  label="  amount"
                  value="5.0 FLOW"
                  color="#FBBF24"
                  delay={0}
                  visible={fieldCount >= 1}
                />
                <FieldRow
                  label="  blinding"
                  value="0x9f27…ae5"
                  color="#A78BFA"
                  delay={0}
                  visible={fieldCount >= 2}
                />
                <FieldRow
                  label="  memo"
                  value='"Thanks!"'
                  color="#A78BFA"
                  delay={0}
                  visible={fieldCount >= 3}
                />

                <AnimatePresence>
                  {fieldCount >= 3 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                      className="font-mono text-[10px] text-foreground/30"
                    >
                      {"}"}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Step 2: ECIES rows */}
          <AnimatePresence>
            {step >= 2 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-1.5 mt-2 pt-2 border-t border-[#A78BFA]/10"
              >
                <ECIESRow
                  label="eph_priv ="
                  value="0x3c9f…"
                  delay={0}
                  visible={eciesPhase >= 1}
                  color="#A78BFA"
                />
                <ECIESRow
                  label="eph_pub ="
                  value="(curve pt)"
                  delay={0}
                  visible={eciesPhase >= 1}
                  color="#A78BFA"
                />
                <ECIESRow
                  label="ECDH →"
                  value="shared_secret"
                  delay={0}
                  visible={eciesPhase >= 2}
                  color="#FBBF24"
                />
                <ECIESRow
                  label="HKDF →"
                  value="aes_key"
                  delay={0}
                  visible={eciesPhase >= 3}
                  color="#FBBF24"
                />
                <ECIESRow
                  label="AES-GCM →"
                  value="██████████"
                  delay={0}
                  visible={eciesPhase >= 4}
                  color="#A78BFA"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── CENTER: Envelope flight track ──────────────────────────────────── */}
        <div className="relative flex flex-col items-center justify-center px-2 py-4 min-w-[80px] sm:min-w-[100px]">

          {/* Chain icon mid-point indicator */}
          <AnimatePresence>
            {step >= 3 && envelopePos >= 1 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1"
              >
                <div className="w-6 h-6 rounded border border-[#D4AF37]/40 bg-[#D4AF37]/10 flex items-center justify-center">
                  <Zap className="w-3 h-3 text-[#D4AF37]" />
                </div>
                <span className="text-[8px] text-[#D4AF37]/60 whitespace-nowrap">on-chain</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Dashed track line */}
          <div className="hidden sm:block absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px border-t border-dashed border-[#A78BFA]/20 pointer-events-none" />

          {/* Envelope — animates horizontally on desktop */}
          <AnimatePresence>
            {step >= 3 && (
              <motion.div
                key="envelope"
                className="relative z-10"
                initial={{ opacity: 0, x: 0 }}
                animate={{
                  opacity: 1,
                  x: envelopePos === 0 ? -32 : envelopePos === 1 ? 0 : 32,
                  y: envelopePos === 1 ? -8 : 0,
                  scale: envelopePos === 1 ? 1.15 : 1,
                }}
                transition={{ duration: 0.7, ease: EASE }}
              >
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center border text-xl cursor-default select-none"
                  style={{
                    background:
                      step >= 4 && decryptCount === 3
                        ? "rgba(0,239,139,0.15)"
                        : "rgba(167,139,250,0.12)",
                    borderColor:
                      step >= 4 && decryptCount === 3
                        ? "rgba(0,239,139,0.40)"
                        : "rgba(167,139,250,0.30)",
                    boxShadow:
                      step >= 4 && decryptCount === 3
                        ? "0 0 16px rgba(0,239,139,0.25)"
                        : "0 0 12px rgba(167,139,250,0.20)",
                  }}
                >
                  {step >= 4 && decryptCount === 3 ? "📬" : "📩"}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── RIGHT: Recipient panel ──────────────────────────────────────────── */}
        <div className="p-4 border-t sm:border-t-0 sm:border-l border-[#A78BFA]/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center">
              <span className="text-sm">🧑‍💻</span>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-[#00EF8B]">Recipient</span>
          </div>

          {/* Before decrypt: encrypted blob + click CTA */}
          <AnimatePresence mode="wait">
            {step >= 3 && decryptCount < 3 && (
              <motion.div
                key="locked"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="space-y-2"
              >
                {/* Ciphertext blob */}
                <div className="rounded-lg border border-[#A78BFA]/25 bg-[#A78BFA]/8 px-3 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-[#A78BFA]/60 mb-1">ciphertext</p>
                  <p className="font-mono text-[10px] text-[#A78BFA]/50 break-all leading-relaxed">
                    a3f7c2e94d18f52a069e3b71…
                    <span className="blur-[2px]">c4d9b2f1e7a3</span>
                  </p>
                </div>

                {/* MemoKey shown */}
                <AnimatePresence>
                  {step >= 4 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-1.5 font-mono text-[10px]"
                    >
                      <Key className="w-3 h-3 text-[#00EF8B] shrink-0" />
                      <span className="text-foreground/40">MemoKey:</span>
                      <span className="text-[#00EF8B]">0x00EF…8B7A</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Click-to-decrypt button */}
                <AnimatePresence>
                  {step >= 4 && !decrypting && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      onClick={handleDecrypt}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: "rgba(0,239,139,0.12)",
                        border: "1px solid rgba(0,239,139,0.35)",
                        color: "#00EF8B",
                        boxShadow: "0 0 12px rgba(0,239,139,0.15)",
                      }}
                    >
                      <Lock className="w-3 h-3" />
                      Click to decrypt with MemoKey
                    </motion.button>
                  )}
                </AnimatePresence>

                {decrypting && decryptCount < 3 && (
                  <div className="text-[10px] text-[#00EF8B]/60 text-center animate-pulse">
                    Decrypting…
                  </div>
                )}
              </motion.div>
            )}

            {/* After decrypt: plaintext fields reveal */}
            {decryptCount === 3 && (
              <motion.div
                key="decrypted"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-1.5"
              >
                <div className="font-mono text-[10px] text-foreground/30">{"{"}</div>
                <FieldRow label="  amount" value="5.0 FLOW" color="#00EF8B" delay={0} visible />
                <FieldRow label="  blinding" value="0x9f27…ae5" color="#00EF8B" delay={0.2} visible />
                <FieldRow label="  memo" value='"Thanks!"' color="#00EF8B" delay={0.4} visible />
                <div className="font-mono text-[10px] text-foreground/30">{"}"}</div>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="flex items-center gap-1.5 text-[10px] font-semibold text-[#00EF8B] pt-1"
                >
                  <span className="w-3.5 h-3.5 rounded-full bg-[#00EF8B]/20 border border-[#00EF8B]/40 flex items-center justify-center text-[8px]">✓</span>
                  Balance reconstructed
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Before envelope arrives */}
          <AnimatePresence>
            {step < 3 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[10px] text-foreground/25 italic"
              >
                Waiting for note…
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Step caption bar */}
      <div className="px-4 py-2.5 border-t border-[#A78BFA]/10 bg-[#A78BFA]/4 flex items-center gap-2">
        <div className="flex items-center gap-1 shrink-0">
          <div
            className="text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center"
            style={{ background: "#A78BFA22", color: "#A78BFA" }}
          >
            {step === 0 ? "·" : step}
          </div>
        </div>
        <p className="text-[10px] text-foreground/50 leading-tight">
          {stepLabels[step]}
        </p>
        {step === 4 && decryptCount === 3 && (
          <button
            type="button"
            onClick={handleReplay}
            className="ml-auto flex items-center gap-1 text-[10px] text-[#A78BFA] hover:text-[#A78BFA]/80 transition-colors"
          >
            <RefreshCw className="w-2.5 h-2.5" /> Replay
          </button>
        )}
        {step >= 1 && step < 4 && (
          <div className="ml-auto flex items-center gap-1">
            <ArrowRight className="w-2.5 h-2.5 text-foreground/20 animate-pulse" />
          </div>
        )}
      </div>
    </div>
  );
}
