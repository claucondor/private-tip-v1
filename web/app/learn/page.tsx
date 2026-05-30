/// /learn — Theory explainer for the openjanus privacy stack.
/// Rebuilt with openjanus design system: Fraunces headings, Janus palette,
/// framer-motion entrance animations, interactive crypto illustrations.

"use client";

import { useState, useRef, useCallback } from "react";
import { motion, useReducedMotion, AnimatePresence } from "framer-motion";
import {
  Lock,
  Eye,
  Key,
  Sparkles,
  Shield,
  BookOpen,
  ArrowRight,
  ExternalLink,
  Layers,
  RefreshCw,
  Cpu,
  GitBranch,
} from "lucide-react";
import Link from "next/link";

// ── Motion config ───────────────────────────────────────────────────────────

const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as const;

function useFadeIn(delay = 0) {
  const reduced = useReducedMotion();
  if (reduced) return { opacity: 1 };
  return {
    initial: { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, margin: "-80px" },
    transition: { duration: 0.55, ease: EASE_OUT_EXPO, delay },
  };
}

// ── Section wrapper ─────────────────────────────────────────────────────────

interface SectionProps {
  icon: React.ReactNode;
  iconBg: string;
  readTime: string;
  heading: string;
  subheading: string;
  children: React.ReactNode;
  id: string;
}

function Section({
  icon,
  iconBg,
  readTime,
  heading,
  subheading,
  children,
  id,
}: SectionProps) {
  const anim = useFadeIn();
  return (
    <motion.section
      id={id}
      {...anim}
      className="w-full max-w-3xl mx-auto px-4 py-12 border-b border-border last:border-0"
    >
      <div className="flex items-start gap-4 mb-6">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ring-1 ${iconBg}`}>
          {icon}
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            {readTime}
          </span>
          <h2
            className="text-xl sm:text-2xl font-bold leading-tight mt-0.5"
            style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
          >
            {heading}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{subheading}</p>
        </div>
      </div>
      <div>{children}</div>
    </motion.section>
  );
}

// ── Typography helpers ──────────────────────────────────────────────────────

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm sm:text-base text-foreground/90 leading-relaxed mb-4 last:mb-0">
      {children}
    </p>
  );
}

function Em({ children }: { children: React.ReactNode }) {
  return <em className="not-italic font-semibold text-foreground">{children}</em>;
}

function MathLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 flex justify-center">
      <span className="inline-block font-mono text-sm bg-[#6B46C1]/10 text-[#A78BFA] dark:text-purple-200 border border-[#6B46C1]/25 px-4 py-2 rounded-lg">
        {children}
      </span>
    </div>
  );
}

function Callout({
  accent,
  label,
  children,
}: {
  accent: "amber" | "emerald" | "purple" | "blue" | "gold" | "copper";
  label: string;
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    amber:   "bg-amber-50/60 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100",
    emerald: "bg-[#00EF8B]/8 border-[#00EF8B]/30 text-emerald-900 dark:text-emerald-100",
    purple:  "bg-[#6B46C1]/8 border-[#6B46C1]/30 text-[#A78BFA] dark:text-purple-200",
    blue:    "bg-blue-50/60 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700 text-blue-900 dark:text-blue-100",
    gold:    "bg-[#D4AF37]/8 border-[#D4AF37]/30 text-amber-900 dark:text-[#D4AF37]",
    copper:  "bg-[#B45309]/8 border-[#B45309]/30 text-[#FBBF24] dark:text-amber-300",
  };
  const labelStyles: Record<string, string> = {
    amber:   "text-amber-700 dark:text-amber-300",
    emerald: "text-[#00EF8B]",
    purple:  "text-[#A78BFA] dark:text-purple-300",
    blue:    "text-blue-700 dark:text-blue-300",
    gold:    "text-[#D4AF37]",
    copper:  "text-[#FBBF24]",
  };
  return (
    <div className={`rounded-xl border px-5 py-4 my-6 ${styles[accent]}`}>
      <p className={`text-[10px] uppercase tracking-widest font-bold mb-2 ${labelStyles[accent]}`}>
        {label}
      </p>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

// ── TOC ─────────────────────────────────────────────────────────────────────

const TOC_ITEMS = [
  { id: "public-chains",    label: "The problem" },
  { id: "pedersen",         label: "Pedersen commitment" },
  { id: "account-vs-utxo",  label: "Account vs UTXO" },
  { id: "shielded-note",    label: "ShieldedNote" },
  { id: "sign-derive",      label: "Sign-derive" },
  { id: "boundary",         label: "The boundary" },
  { id: "ceremony",         label: "Ceremony" },
  { id: "roadmap",          label: "What's next" },
];

// ── Section 1 illustration — public vs private toggle ──────────────────────

function PublicPrivateToggle() {
  const [isPrivate, setIsPrivate] = useState(false);
  const reduced = useReducedMotion();

  return (
    <div className="my-6 rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Transaction on-chain
        </span>
        <button
          type="button"
          onClick={() => setIsPrivate((p) => !p)}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            isPrivate
              ? "bg-[#6B46C1] text-white"
              : "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200"
          }`}
        >
          {isPrivate ? "🔒 Private mode" : "👁 Public mode"}
        </button>
      </div>
      <div className="p-4 font-mono text-xs space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-16 shrink-0">from:</span>
          <span className="text-foreground">0x4f2a…d391</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-16 shrink-0">to:</span>
          <span className="text-foreground">0x9c1b…fa22</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-16 shrink-0">amount:</span>
          <AnimatePresence mode="wait">
            {isPrivate ? (
              <motion.span
                key="private"
                initial={reduced ? {} : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? {} : { opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.3 }}
                className="px-2 py-0.5 rounded bg-[#6B46C1]/20 text-[#A78BFA] dark:text-purple-300 blur-[2px] select-none"
              >
                0x4e2f9c3d7a1b8e45f23c9d1a7b3e5f2a
              </motion.span>
            ) : (
              <motion.span
                key="public"
                initial={reduced ? {} : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? {} : { opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.3 }}
                className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 font-bold"
              >
                5.00 FLOW
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-16 shrink-0">memo:</span>
          <AnimatePresence mode="wait">
            {isPrivate ? (
              <motion.span
                key="pm"
                initial={reduced ? {} : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduced ? {} : { opacity: 0 }}
                className="text-[#6B46C1]/60 blur-[2px] select-none"
              >
                {"{encrypted ECIES blob}"}
              </motion.span>
            ) : (
              <motion.span
                key="pub"
                initial={reduced ? {} : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduced ? {} : { opacity: 0 }}
                className="text-muted-foreground"
              >
                Thanks for the talk!
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="px-4 py-2 border-t border-border bg-muted/20 text-[10px] text-muted-foreground">
        {isPrivate
          ? "Amount replaced by a Pedersen commitment point. Memo ECIES-encrypted. Toggle to compare."
          : "Fully public — amount, memo visible to all. Toggle to see private mode."}
      </div>
    </div>
  );
}

// ── Section 2 illustration — Pedersen curve interactive ────────────────────

function PedersenInteractive() {
  const [value, setValue] = useState("5");
  const [blinding, setBlinding] = useState("42");

  // Fake-but-plausible commitment visualization:
  // pointX = (parseInt(value)*37 + parseInt(blinding)*131) % 360
  const v = Math.abs(parseInt(value) || 0) % 1000;
  const b = Math.abs(parseInt(blinding) || 0) % 10000;
  const angle = ((v * 37 + b * 131) % 360) * (Math.PI / 180);
  const rx = 100, ry = 50;
  const cx = 130, cy = 70;
  const px = cx + rx * Math.cos(angle);
  const py = cy + ry * Math.sin(angle);
  const hue = (v * 13 + b * 7) % 360;

  return (
    <div className="my-6 rounded-xl border border-[#6B46C1]/20 bg-[#6B46C1]/5 p-4">
      <p className="text-xs font-semibold text-[#A78BFA] dark:text-purple-300 uppercase tracking-wider mb-3">
        Interactive: watch the commitment point move
      </p>
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
              Amount (a)
            </label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min="0"
              max="999"
              className="w-full px-3 py-2 text-sm font-mono border border-[#6B46C1]/30 rounded bg-background focus:outline-none focus:ring-2 focus:ring-[#6B46C1]/30"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
              Blinding factor (b)
            </label>
            <input
              type="number"
              value={blinding}
              onChange={(e) => setBlinding(e.target.value)}
              min="0"
              max="9999"
              className="w-full px-3 py-2 text-sm font-mono border border-[#6B46C1]/30 rounded bg-background focus:outline-none focus:ring-2 focus:ring-[#6B46C1]/30"
            />
          </div>
          <div className="rounded-lg bg-[#6B46C1]/10 px-3 py-2 text-xs font-mono text-[#A78BFA] dark:text-purple-200">
            C = a·G + b·H
          </div>
          <p className="text-[10px] text-muted-foreground">
            Same amount, different blinding → completely different point. This is perfect hiding.
          </p>
        </div>
        {/* SVG elliptic curve visualization */}
        <div className="shrink-0 flex items-center justify-center">
          <svg width="260" height="140" viewBox="0 0 260 140" className="overflow-visible">
            {/* Curve (sinusoidal approximation of BabyJub shape) */}
            <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke="#6B46C1" strokeOpacity="0.25" strokeWidth="1.5" />
            {/* Grid */}
            <line x1="30" y1={cy} x2={cx+rx+30} y2={cy} stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.5" />
            <line x1={cx} y1="20" x2={cx} y2={cy+ry+30} stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.5" />
            {/* Fixed generators */}
            <circle cx={cx + rx} cy={cy} r="3.5" fill="#00EF8B" opacity="0.7" />
            <text x={cx + rx + 5} y={cy + 4} fontSize="8" fill="#00EF8B" opacity="0.8">G</text>
            <circle cx={cx - rx} cy={cy} r="3.5" fill="#D4AF37" opacity="0.7" />
            <text x={cx - rx - 12} y={cy + 4} fontSize="8" fill="#D4AF37" opacity="0.8">H</text>
            {/* Commitment point */}
            <motion.circle
              cx={px}
              cy={py}
              r="5"
              fill={`hsl(${hue}, 70%, 55%)`}
              animate={{ cx: px, cy: py }}
              transition={{ type: "spring", stiffness: 180, damping: 22 }}
            />
            <motion.circle
              cx={px}
              cy={py}
              r="9"
              fill="transparent"
              stroke={`hsl(${hue}, 70%, 55%)`}
              strokeWidth="1.5"
              strokeOpacity="0.4"
              animate={{ cx: px, cy: py }}
              transition={{ type: "spring", stiffness: 180, damping: 22 }}
            />
            <text x={cx+5} y="15" fontSize="8" fill="currentColor" opacity="0.5">BabyJubJub curve</text>
            {/* Label C */}
            <motion.text
              fontSize="9"
              fill={`hsl(${hue}, 70%, 45%)`}
              fontWeight="600"
              animate={{ x: px + 8, y: py + 4 }}
              transition={{ type: "spring", stiffness: 180, damping: 22 }}
            >
              C
            </motion.text>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ── Section 3 illustration — Account vs UTXO ───────────────────────────────

function AccountVsUTXO() {
  const [step, setStep] = useState(0);
  const steps = ["Start", "Tip in", "Spend"];
  const accountBalance = [0, 3, 1.5];
  const utxoCoins = [
    [],
    [{ v: 3, id: 1 }],
    [{ v: 1.5, id: 2 }],
  ];

  return (
    <div className="my-6 rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
          Account vs UTXO model
        </span>
        <div className="flex gap-1">
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => setStep(i)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                step === i
                  ? "bg-[#6B46C1] text-white"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Account model */}
        <div className="p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">Account model</p>
          <div className="flex flex-col items-center gap-2">
            <div className="w-full rounded-lg border border-[#00EF8B]/30 bg-[#00EF8B]/8 px-3 py-4 text-center">
              <AnimatePresence mode="wait">
                <motion.p
                  key={step}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.25 }}
                  className="text-2xl font-bold text-[#00EF8B]"
                  style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
                >
                  {accountBalance[step]} FLOW
                </motion.p>
              </AnimatePresence>
              <p className="text-[10px] text-muted-foreground mt-1">single commitment</p>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              One opaque bucket. Homomorphic addition updates it.
            </p>
          </div>
        </div>
        {/* UTXO model */}
        <div className="p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">UTXO model</p>
          <div className="flex flex-col items-center gap-2">
            <div className="w-full min-h-[80px] rounded-lg border border-[#6B46C1]/30 bg-[#6B46C1]/5 px-3 py-3 flex flex-wrap gap-2 items-center justify-center">
              <AnimatePresence mode="popLayout">
                {utxoCoins[step].length === 0 ? (
                  <motion.p
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-xs text-muted-foreground italic"
                  >
                    no notes
                  </motion.p>
                ) : (
                  utxoCoins[step].map((coin) => (
                    <motion.div
                      key={coin.id}
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      transition={{ type: "spring", stiffness: 200, damping: 20 }}
                      className="w-14 h-14 rounded-full border-2 border-[#6B46C1]/40 bg-[#6B46C1]/15 flex items-center justify-center text-xs font-bold text-[#A78BFA] dark:text-purple-300"
                    >
                      {coin.v}
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              Individual notes. Spend consumes specific coins.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section 3 compare table (kept from original) ───────────────────────────

function CompareTable() {
  const rows = [
    { feature: "Balance model",      openjanus: "One accumulated commitment",         railgun: "Many unspent notes (UTXOs)",       aztec: "One accumulated commitment" },
    { feature: "Amount hiding",      openjanus: "Yes — Pedersen + Groth16",           railgun: "Yes — Groth16 (UTXO-per-note)",    aztec: "Yes — Honk / UltraHonk" },
    { feature: "Sender/recipient",   openjanus: "Visible (v0.5) → stealth v0.6",      railgun: "Hidden (stealth + UTXO set)",      aztec: "Hidden (account abstraction)" },
    { feature: "Pattern hiding",     openjanus: "Partial (commit changes visible)",    railgun: "Strong (UTXO set membership)",     aztec: "Strong" },
    { feature: "Flow ergonomics",    openjanus: "Native (resource model fits)",        railgun: "N/A — Ethereum only",              aztec: "N/A — L2 rollup" },
    { feature: "Tx complexity",      openjanus: "Low — one Cadence cross-VM tx",       railgun: "High — Merkle witnesses",          aztec: "High — kernel circuits" },
  ];
  return (
    <div className="overflow-x-auto my-6 rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Feature</th>
            <th className="px-3 py-2.5 text-left font-semibold text-[#00EF8B] uppercase tracking-wider">openjanus</th>
            <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Railgun</th>
            <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">Aztec</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.feature} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
              <td className="px-3 py-2 font-medium text-foreground/80">{row.feature}</td>
              <td className="px-3 py-2 text-emerald-800 dark:text-[#00EF8B] font-medium">{row.openjanus}</td>
              <td className="px-3 py-2 text-muted-foreground">{row.railgun}</td>
              <td className="px-3 py-2 text-muted-foreground">{row.aztec}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Section 4 illustration — ShieldedNote flight ───────────────────────────

function ShieldedNoteAnimation() {
  const [opened, setOpened] = useState(false);
  const reduced = useReducedMotion();

  return (
    <div className="my-6 rounded-xl border border-[#00EF8B]/25 bg-[#00EF8B]/5 p-4">
      <p className="text-xs font-semibold text-[#00EF8B] uppercase tracking-wider mb-4">
        ShieldedNote lifecycle
      </p>
      <div className="flex items-center justify-between gap-2">
        {/* Sender side */}
        <div className="flex flex-col items-center gap-1 text-center">
          <div className="w-10 h-10 rounded-full bg-[#6B46C1]/15 border border-[#6B46C1]/30 flex items-center justify-center text-sm">
            🧑
          </div>
          <p className="text-[10px] text-muted-foreground">Sender</p>
          <div className="text-[10px] font-mono bg-[#6B46C1]/10 rounded px-2 py-1 text-[#A78BFA] dark:text-purple-300">
            C = a·G + b·H
          </div>
        </div>

        {/* Animated envelope */}
        <div className="flex-1 flex items-center justify-center">
          <motion.div
            animate={reduced ? {} : { x: opened ? 40 : 0 }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
            className="text-2xl cursor-pointer select-none"
            onClick={() => setOpened(!opened)}
            title="Click to open"
          >
            {opened ? "📬" : "📩"}
          </motion.div>
          <div className="flex-1 h-px border-t border-dashed border-[#00EF8B]/40 mx-2" />
        </div>

        {/* Recipient side */}
        <div className="flex flex-col items-center gap-1 text-center">
          <div className="w-10 h-10 rounded-full bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center text-sm">
            🧑‍💻
          </div>
          <p className="text-[10px] text-muted-foreground">Recipient</p>
          <AnimatePresence mode="wait">
            {opened ? (
              <motion.div
                key="open"
                initial={reduced ? {} : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-[10px] font-mono bg-[#00EF8B]/10 rounded px-2 py-1 text-[#00EF8B] space-y-0.5"
              >
                <p>amount: 5 FLOW</p>
                <p>blinding: 0x4f2a…</p>
                <p>memo: "great talk!"</p>
              </motion.div>
            ) : (
              <motion.div
                key="closed"
                initial={reduced ? {} : { opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-[10px] font-mono text-muted-foreground italic"
              >
                (encrypted)
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-3 text-center">
        Click the envelope to simulate decryption with MemoKey privkey.
      </p>
    </div>
  );
}

// ── Section 5 illustration — Sign-derive HKDF ──────────────────────────────

function SignDeriveAnimation() {
  const [derived, setDerived] = useState(false);
  const [running, setRunning] = useState(false);
  const reduced = useReducedMotion();

  const run = useCallback(() => {
    if (running || derived) return;
    setRunning(true);
    setTimeout(() => {
      setRunning(false);
      setDerived(true);
    }, reduced ? 0 : 1200);
  }, [running, derived, reduced]);

  const mockSig = "0x4f2a9c3d7b1e8a45f23c9d1a7b3e5f2a91c4b7d2e8f3a6c91b4d7e2f5a8c3b6d9";
  const mockKey = "0x00EF8B7A3F2D91C4B6E5A8F23C9D1A7B";

  return (
    <div className="my-6 rounded-xl border border-[#D4AF37]/25 bg-[#D4AF37]/5 p-4">
      <p className="text-xs font-semibold text-[#D4AF37] uppercase tracking-wider mb-4">
        Sign-derive: same wallet → same key forever
      </p>
      <div className="space-y-3">
        {/* Step 1: wallet signature */}
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">1</div>
          <div className="flex-1">
            <p className="text-xs font-medium mb-1">Wallet signs fixed message</p>
            <div className="font-mono text-[10px] bg-background border border-border rounded px-3 py-2 text-muted-foreground break-all">
              "openjanus:memokey:v1"
            </div>
          </div>
        </div>

        {/* Step 2: HKDF box */}
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">2</div>
          <div className="flex-1">
            <p className="text-xs font-medium mb-1">Signature → HKDF-SHA256 → BabyJubJub scalar</p>
            <button
              type="button"
              onClick={run}
              disabled={derived}
              className="px-3 py-1.5 rounded bg-[#D4AF37]/20 border border-[#D4AF37]/40 text-[#D4AF37] text-xs font-semibold hover:bg-[#D4AF37]/30 transition-colors disabled:opacity-50 disabled:cursor-default"
            >
              {running ? "Deriving…" : derived ? "Derived ✓" : "Derive MemoKey →"}
            </button>
          </div>
        </div>

        {/* Output */}
        <AnimatePresence>
          {derived && (
            <motion.div
              initial={reduced ? {} : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="flex items-start gap-3"
            >
              <div className="w-6 h-6 rounded-full bg-[#00EF8B]/20 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 text-[#00EF8B]">✓</div>
              <div className="flex-1">
                <p className="text-xs font-medium mb-1 text-[#00EF8B]">MemoKey privkey (session-cached)</p>
                <div className="font-mono text-[10px] bg-background border border-[#00EF8B]/30 rounded px-3 py-2 text-[#00EF8B] break-all">
                  {mockKey}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Same wallet + same message = same key on any device, any time.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Second device */}
        {derived && (
          <motion.div
            initial={reduced ? {} : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-[10px] text-muted-foreground"
          >
            Open on a <strong>new device</strong> → wallet signs → HKDF → same{" "}
            <span className="font-mono text-[#00EF8B]">{mockKey.slice(0, 18)}…</span>
          </motion.div>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mt-3">
        The signature <span className="font-mono">{mockSig.slice(0, 20)}…</span> flows through HKDF.
        No storage needed. Lose nothing except your wallet credentials.
      </p>
    </div>
  );
}

// ── Section 6 illustration — Boundary diagram (enhanced) ───────────────────

function BoundaryDiagram() {
  return (
    <div className="my-6 rounded-xl border border-border bg-card overflow-hidden">
      {/* Public zone */}
      <div className="bg-[#B45309]/8 px-4 py-3 border-b border-border">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-[#FBBF24] mb-2">Public zone (visible)</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Wrap", value: "+2.0 FLOW", note: "entry" },
            { label: "Private zone", value: "· · ·", note: "hidden" },
            { label: "Withdraw", value: "−1.5 FLOW", note: "exit" },
          ].map((cell) => (
            <div key={cell.label} className="text-xs">
              <p className="text-[10px] text-muted-foreground uppercase mb-1">{cell.label}</p>
              <span className={`font-mono px-2 py-0.5 rounded text-xs ${
                cell.note === "hidden"
                  ? "bg-[#6B46C1]/15 text-[#6B46C1]/60 dark:text-purple-400/60 blur-[1px]"
                  : "bg-[#B45309]/15 text-[#FBBF24]"
              }`}>{cell.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Animated shimmer boundary */}
      <div className="janus-divider-shimmer" />

      {/* Private zone */}
      <div className="bg-[#00EF8B]/5 px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-[#00EF8B] mb-2">Private zone (your wallet)</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Wrap", value: "+2.0", tone: "emerald" },
            { label: "Tips sent", value: "−0.5", tone: "emerald" },
            { label: "Withdraw", value: "−1.5", tone: "emerald" },
          ].map((cell) => (
            <div key={cell.label} className="text-xs">
              <p className="text-[10px] text-muted-foreground uppercase mb-1">{cell.label}</p>
              <span className="font-mono px-2 py-0.5 rounded text-xs bg-[#00EF8B]/15 text-[#00EF8B]">{cell.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Section 7 illustration — Ceremony contributor nodes ────────────────────

function CeremonyAnimation() {
  const reduced = useReducedMotion();
  const contributors = [
    { label: "Researcher A", color: "#6B46C1", x: 40, y: 40 },
    { label: "Wallet Dev",   color: "#00EF8B", x: 200, y: 20 },
    { label: "Academic",    color: "#B45309", x: 340, y: 50 },
    { label: "Anon",        color: "#6B46C1", x: 80, y: 110 },
    { label: "Foundation",  color: "#00EF8B", x: 280, y: 100 },
  ];

  return (
    <div className="my-6 rounded-xl border border-[#D4AF37]/25 bg-[#D4AF37]/5 p-4 overflow-hidden">
      <p className="text-xs font-semibold text-[#D4AF37] uppercase tracking-wider mb-3">
        Multi-party ceremony — 1-of-N trust model
      </p>
      <div className="relative h-40">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 150" preserveAspectRatio="none">
          {contributors.map((c) => (
            <g key={c.label}>
              {/* Line to center */}
              <line
                x1={c.x} y1={c.y}
                x2={200} y2={75}
                stroke={c.color}
                strokeOpacity="0.3"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
            </g>
          ))}
          {/* Central ceremony point */}
          <circle cx={200} cy={75} r={22} fill="#D4AF37" fillOpacity="0.15" stroke="#D4AF37" strokeWidth="1.5" strokeOpacity="0.6" />
          <text x={200} y={79} textAnchor="middle" fontSize="10" fill="#D4AF37" fontWeight="600">Ceremony</text>
          {/* Flow VRF beacon */}
          <circle cx={200} cy={75} r={32} fill="none" stroke="#D4AF37" strokeWidth="1" strokeOpacity="0.2" strokeDasharray="6 4">
            {!reduced && (
              <animateTransform attributeName="transform" type="rotate" from="0 200 75" to="360 200 75" dur="8s" repeatCount="indefinite" />
            )}
          </circle>
        </svg>
        {/* Contributor dots */}
        {contributors.map((c) => (
          <div
            key={c.label}
            className="absolute w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
            style={{
              left: `${(c.x / 400) * 100}%`,
              top: `${(c.y / 150) * 100}%`,
              transform: "translate(-50%, -50%)",
              background: c.color,
              opacity: 0.85,
            }}
          >
            {c.label[0]}
          </div>
        ))}
        {/* Gold VRF beacon marker */}
        <div
          className="absolute w-8 h-8 rounded-full flex items-center justify-center text-[9px] font-bold text-[#0A1628]"
          style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)", background: "#D4AF37" }}
          title="Flow VRF beacon"
        >
          VRF
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        If ANY contributor destroyed their toxic waste honestly, the setup is sound.
        The Flow VRF beacon is the final contribution — tampering requires breaking BFT consensus.
      </p>
    </div>
  );
}

function CeremonyBadge() {
  return (
    <div className="inline-flex flex-wrap items-center gap-3 bg-muted/40 border border-border rounded-xl px-4 py-3 my-6 text-xs font-mono">
      <span className="flex items-center gap-1.5 text-[#A78BFA]">
        <span className="w-2 h-2 rounded-full bg-[#6B46C1]" />
        pot14
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="flex items-center gap-1.5 text-[#D4AF37]">
        <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
        Flow VRF beacon
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="flex items-center gap-1.5 text-[#00EF8B]">
        <span className="w-2 h-2 rounded-full bg-[#00EF8B]" />
        87 contributors
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">Phase 2 pending — operator update</span>
    </div>
  );
}

// ── Section 8 — Roadmap arches ─────────────────────────────────────────────

function RoadmapRow({
  version, label, description, status,
}: {
  version: string;
  label: string;
  description: string;
  status: "live" | "next" | "planned" | "research";
}) {
  const statusBadge: Record<string, string> = {
    live:     "bg-[#00EF8B]/15 text-[#00EF8B] border-[#00EF8B]/30",
    next:     "bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-300/40",
    planned:  "bg-[#D4AF37]/12 text-[#D4AF37] border-[#D4AF37]/30",
    research: "bg-[#6B46C1]/12 text-[#A78BFA] dark:text-purple-300 border-[#6B46C1]/30",
  };
  const statusLabel: Record<string, string> = {
    live: "Shipping now", next: "Next up", planned: "Planned", research: "Research track",
  };
  return (
    <div className="flex items-start gap-4 py-4 border-b border-border last:border-0">
      <div className="font-mono text-xs font-bold text-muted-foreground w-10 shrink-0 pt-0.5">{version}</div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="font-semibold text-sm text-foreground">{label}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${statusBadge[status]}`}>
            {statusLabel[status]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function LearnPage() {
  const heroAnim = useFadeIn(0);

  return (
    <div className="flex flex-col items-center janus-hex-bg">
      {/* Hero */}
      <motion.div
        {...heroAnim}
        className="w-full max-w-3xl mx-auto px-4 pt-14 pb-8 text-center"
      >
        {/* Janus arch SVG */}
        <div className="flex justify-center mb-6">
          <svg width="80" height="60" viewBox="0 0 80 60" fill="none" className="drop-shadow-[0_0_12px_rgba(107,70,193,0.4)]">
            {/* Left arch half */}
            <path d="M40 50 Q10 50 10 20 Q10 5 25 5" stroke="#6B46C1" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            {/* Right arch half */}
            <path d="M40 50 Q70 50 70 20 Q70 5 55 5" stroke="#00EF8B" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            {/* Left face */}
            <circle cx="20" cy="15" r="6" fill="#6B46C1" fillOpacity="0.3" stroke="#6B46C1" strokeWidth="1.5" />
            <circle cx="18" cy="14" r="1.2" fill="#6B46C1" />
            <circle cx="22" cy="14" r="1.2" fill="#6B46C1" />
            {/* Right face */}
            <circle cx="60" cy="15" r="6" fill="#00EF8B" fillOpacity="0.3" stroke="#00EF8B" strokeWidth="1.5" />
            <circle cx="58" cy="14" r="1.2" fill="#00EF8B" />
            <circle cx="62" cy="14" r="1.2" fill="#00EF8B" />
            {/* Keystone */}
            <circle cx="40" cy="5" r="4" fill="#D4AF37" fillOpacity="0.7" />
          </svg>
        </div>

        <h1
          className="text-3xl sm:text-4xl font-bold tracking-tight mb-3"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          The Two Faces of On-Chain Money
        </h1>
        <p className="text-base text-muted-foreground max-w-2xl mx-auto mb-6">
          A plain-language explainer for the cryptography behind PrivateTip and the{" "}
          <span className="font-mono text-sm bg-muted px-1.5 py-0.5 rounded">
            @openjanus/sdk
          </span>{" "}
          stack. No heavy notation. Show your work.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <BookOpen className="w-3 h-3" /> ~15 min read
          </span>
          <span>·</span>
          <span>8 sections</span>
          <span>·</span>
          <span>Updated May 2026</span>
        </div>

        {/* Back link */}
        <div className="mt-6 flex justify-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back to PrivateTip
          </Link>
        </div>
      </motion.div>

      {/* Shimmer divider under hero */}
      <div className="w-full max-w-3xl px-4 mb-2">
        <div className="janus-divider-shimmer rounded-full" />
      </div>

      {/* TOC */}
      <div className="w-full max-w-3xl mx-auto px-4 py-6">
        <div className="flex flex-wrap gap-2">
          {TOC_ITEMS.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-border bg-background hover:border-[#00EF8B]/40 hover:bg-[#00EF8B]/5 text-muted-foreground hover:text-foreground transition-all"
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>

      {/* ── Section 1: The problem with public chains ── */}
      <Section
        id="public-chains"
        icon={<Eye className="w-5 h-5" />}
        iconBg="bg-[#B45309]/15 text-[#FBBF24] ring-[#B45309]/30"
        readTime="2 min read"
        heading="The problem with public chains"
        subheading="Everything leaks by default — and that matters more than you think."
      >
        <P>
          Every transaction on a public blockchain reveals at least three things: who sent it,
          who received it, and how much moved. That&apos;s not a bug — it&apos;s the entire point
          of a public ledger. But it makes blockchains genuinely bad for a surprising number of
          real-world use cases.
        </P>
        <PublicPrivateToggle />
        <P>
          Think about tipping a creator. Would you tip more or less if your exact amount appeared
          publicly next to your wallet address forever? Most people tip less (anchoring) or skip
          entirely (privacy instinct). The same applies to donations, payroll, sealed bids —
          anything where the amount is commercially sensitive.
        </P>
        <Callout accent="copper" label="Where PrivateTip sits today">
          PrivateTip is <strong>confidential tier</strong> — amounts are cryptographically hidden,
          but sender and recipient addresses are visible on-chain. That&apos;s deliberate for v0.5:
          the &quot;who tipped whom&quot; visibility is social proof. Full anonymity is planned for
          v0.6. See the{" "}
          <a href="#roadmap" className="underline hover:text-foreground">roadmap</a>.
        </Callout>
      </Section>

      {/* ── Section 2: Pedersen commitment ── */}
      <Section
        id="pedersen"
        icon={<Lock className="w-5 h-5" />}
        iconBg="bg-[#6B46C1]/15 text-[#A78BFA] ring-[#6B46C1]/30"
        readTime="3 min read"
        heading="The Pedersen commitment"
        subheading="A sealed envelope that anyone can verify without opening."
      >
        <P>
          The core primitive is a <Em>Pedersen commitment</Em>. Take an amount and some random
          noise (a blinding factor), mix them mathematically in a one-way direction, and publish
          the result. The result proves you&apos;re committed to a specific amount, without
          revealing what that amount is.
        </P>
        <MathLine>C = a·G + b·H</MathLine>
        <PedersenInteractive />
        <P>
          Here <em>G</em> and <em>H</em> are fixed points on the BabyJubJub curve — generators
          chosen such that nobody knows the discrete logarithm relationship between them
          (&quot;nothing-up-my-sleeve&quot; parameters).
        </P>
        <Callout accent="purple" label="The homomorphic property">
          Adding two commitments gives a valid commitment to the sum:{" "}
          <span className="font-mono text-xs">C₁ + C₂ = (a₁+a₂)·G + (b₁+b₂)·H</span>.
          This is what makes an account model work: every incoming tip updates the
          commitment homomorphically, and the owner can always prove their total without
          revealing it.
        </Callout>
      </Section>

      {/* ── Section 3: Account vs UTXO ── */}
      <Section
        id="account-vs-utxo"
        icon={<Layers className="w-5 h-5" />}
        iconBg="bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 ring-blue-300/40"
        readTime="4 min read"
        heading="Account model vs UTXO model"
        subheading="Two schools of thought on how to structure private balances."
      >
        <P>
          The privacy industry has settled into two camps. The <Em>UTXO model</Em> treats each
          incoming payment as a discrete &quot;note&quot; — like a physical coin. The{" "}
          <Em>account model</Em> keeps one accumulated balance per address, updated
          homomorphically.
        </P>
        <AccountVsUTXO />
        <CompareTable />
        <P>
          openjanus chose the account model for v1. Flow&apos;s resource model maps cleanly to
          &quot;one owned object per user.&quot; Stealth addresses can be layered on top without
          rewriting the commitment math (planned v0.6 —{" "}
          <a href="#roadmap" className="underline hover:text-foreground">see roadmap</a>).
        </P>
      </Section>

      {/* ── Section 4: ShieldedNote ── */}
      <Section
        id="shielded-note"
        icon={<Key className="w-5 h-5" />}
        iconBg="bg-[#00EF8B]/15 text-[#00EF8B] ring-[#00EF8B]/30"
        readTime="2 min read"
        heading="The ShieldedNote — the recovery channel"
        subheading="Without this, private balances accumulate silently and can never be spent."
      >
        <P>
          Here&apos;s a subtle problem most explainers gloss over. Suppose Alice sends Bob 5 FLOW,
          privately. The on-chain commitment at Bob&apos;s address changes by some opaque amount.
          How does Bob know he received 5? Without the exact <em>(amount, blinding)</em> pair,
          he cannot construct a valid ZK proof when he wants to withdraw.
        </P>
        <ShieldedNoteAnimation />
        <P>
          The solution is the <Em>ShieldedNote</Em>. Every shielded transfer ships an encrypted
          payload alongside the commitment update. The payload contains the amount, blinding
          factor, and an optional memo — everything the recipient needs to reconstruct their
          position. It&apos;s encrypted using ECIES over BabyJubJub, addressed to the
          recipient&apos;s <Em>MemoKey</Em> public key.
        </P>
        <Callout accent="emerald" label="Why PrivateTip blocks sends to recipients without a MemoKey">
          If there&apos;s no MemoKey registered, the sender has no public key to encrypt the
          ShieldedNote to. The recipient would receive a commitment they can never decode — a
          permanently unspendable balance.
        </Callout>
      </Section>

      {/* ── Section 5: Sign-derive ── */}
      <Section
        id="sign-derive"
        icon={<RefreshCw className="w-5 h-5" />}
        iconBg="bg-[#D4AF37]/15 text-[#D4AF37] ring-[#D4AF37]/30"
        readTime="3 min read"
        heading="Sign-derive — the multi-device unlock"
        subheading="How your inbox key survives browser resets without a seed phrase."
      >
        <P>
          The MemoKey private key is the master key to your private inbox. Lose it and all your
          incoming tips are permanently inaccessible. The naive approach — store it in
          localStorage — fails the moment you clear storage, switch devices, or reinstall.
        </P>
        <SignDeriveAnimation />
        <P>
          openjanus&apos;s answer is <Em>sign-derive</Em>. Instead of a random key, you derive
          one deterministically from a wallet signature over a fixed message. The same wallet,
          same message, always produces the same signature bytes — which go through HKDF-SHA256
          to produce your BabyJubJub MemoKey scalar.
        </P>
        <Callout accent="gold" label="Why this works as a recovery mechanism">
          Open the app on any device. Connect the same wallet. Sign the same message. HKDF
          produces the same scalar. Your MemoKey is back — without a backup phrase, without a
          server, without persistent storage.
        </Callout>
      </Section>

      {/* ── Section 6: Boundary pattern ── */}
      <Section
        id="boundary"
        icon={<Eye className="w-5 h-5" />}
        iconBg="bg-[#B45309]/15 text-[#FBBF24] ring-[#B45309]/30"
        readTime="2 min read"
        heading="The boundary pattern"
        subheading="Amounts leak at entry and exit. Everything in between is opaque."
      >
        <P>
          When you <Em>wrap</Em> FLOW into your shielded balance, you&apos;re crossing the entry
          boundary. The amount is public at this point — the Cadence transaction must transfer real
          FLOW tokens, and that transfer is on-chain. From this moment, the amount disappears.
        </P>
        <BoundaryDiagram />
        <P>
          Every <Em>shielded transfer</Em> in between updates commitments without revealing
          amounts. When you <Em>withdraw</Em> (exit boundary), you provide a ZK proof that your
          commitment covers the claimed withdrawal amount, and the contract releases actual FLOW.
        </P>
        <Callout accent="copper" label="Practical privacy tip">
          For the strongest privacy, after withdrawing, immediately forward your FLOW to a
          fresh wallet you&apos;ve never used publicly. This breaks the link between your shielded
          identity and your future spending wallet.
        </Callout>
      </Section>

      {/* ── Section 7: Trusted setup ceremony ── */}
      <Section
        id="ceremony"
        icon={<Shield className="w-5 h-5" />}
        iconBg="bg-[#D4AF37]/15 text-[#D4AF37] ring-[#D4AF37]/30"
        readTime="3 min read"
        heading="The trusted setup ceremony"
        subheading="Why ZK proofs require a ceremony — and why multi-party computation makes it trustworthy."
      >
        <P>
          Groth16 requires a one-time <Em>trusted setup</Em>. During setup, a secret random value
          (&quot;toxic waste&quot;) is used to construct the proving and verification keys. If
          anyone learns this secret later, they can forge proofs.
        </P>
        <CeremonyAnimation />
        <P>
          <Em>Multi-party computation (MPC)</Em> makes this tractable. Many participants
          contribute randomness sequentially. If <em>even one participant</em> was honest and
          destroyed their secret, the setup is sound.
        </P>
        <CeremonyBadge />
        <Callout accent="gold" label="What this means in practice">
          Unlike random-oracle proofs (STARKs, Halo2), Groth16 is not trustless. The ceremony
          is a one-time cost paid by a diverse group — comparable to Zcash Sprout, Hermez,
          and Tornado Cash in production.
        </Callout>
      </Section>

      {/* ── Section 8: Roadmap ── */}
      <Section
        id="roadmap"
        icon={<GitBranch className="w-5 h-5" />}
        iconBg="bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 ring-blue-300/40"
        readTime="2 min read"
        heading="What's next (v0.5 → v1.0)"
        subheading="Privacy gains grouped by what they unlock, not by version."
      >
        <P>
          Every upgrade on the roadmap is anchored to a concrete use case that would be blocked
          without it.
        </P>

        <div className="rounded-xl border border-border overflow-hidden my-6">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Shipping + planned
            </span>
          </div>
          <div className="px-4">
            <RoadmapRow version="v0.5" label="128-bit balance range" status="live"
              description="Mainnet-ready math. Current proofs handle amounts up to 128 bits — effectively unbounded. The upgrade makes the range explicit in circuit constraints and adds overflow guards." />
            <RoadmapRow version="v0.6" label="Sender↔recipient unlink (stealth addresses)" status="next"
              description="ERC-5564-style stealth addresses. Senders derive a one-time address per recipient using their published viewing key. The public chain no longer reveals who tipped whom." />
            <RoadmapRow version="v0.7" label="Optional UTXO mode" status="planned"
              description="High-anonymity-set mode for sealed-bid auctions, dark pools, mixers. Account model stays the default. UTXO mode is a separate circuit + contract pair, opted into per-application." />
            <RoadmapRow version="v0.8" label="Encrypted history backup" status="planned"
              description="Portable balance recovery without device dependence. The full ShieldedNote history can be exported as an encrypted blob — recoverable from any device with the MemoKey." />
          </div>
        </div>

        <div className="rounded-xl border border-border overflow-hidden my-6">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Research track
            </span>
          </div>
          <div className="px-4">
            <RoadmapRow version="R1" label="FHE computation over encrypted state" status="research"
              description="Fully Homomorphic Encryption would allow the chain to compute over shielded balances without decryption — no ZK proofs required at the individual transfer level." />
            <RoadmapRow version="R2" label="Multi-circuit zkVM composition" status="research"
              description="Compose multiple specialized circuits into a single recursive proof. Flow's cross-VM atomic execution makes multi-circuit verification tractable." />
            <RoadmapRow version="R3" label="Post-quantum lattice variants" status="research"
              description="BabyJubJub and BN254 are vulnerable to a sufficiently powerful quantum computer. Lattice-based commitments would preserve the homomorphic property with long-term safety." />
          </div>
        </div>
      </Section>

      {/* ── CTA ── */}
      <motion.section
        {...useFadeIn(0.1)}
        className="w-full max-w-3xl mx-auto px-4 py-12"
      >
        <div className="relative overflow-hidden rounded-3xl border border-[#6B46C1]/20 bg-gradient-to-br from-[#6B46C1]/8 via-background to-[#00EF8B]/8 p-8 sm:p-10">
          <div className="absolute -top-16 -left-16 w-48 h-48 rounded-full bg-[#6B46C1]/15 blur-3xl pointer-events-none" aria-hidden />
          <div className="absolute -bottom-16 -right-16 w-48 h-48 rounded-full bg-[#00EF8B]/15 blur-3xl pointer-events-none" aria-hidden />
          <div className="relative text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[#6B46C1]/10 border border-[#6B46C1]/20 mb-5">
              <Cpu className="w-6 h-6 text-[#A78BFA]" />
            </div>
            <h2
              className="text-2xl sm:text-3xl font-bold mb-3"
              style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
            >
              Build something with this
            </h2>
            <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-6">
              The SDK ships Pedersen commitments, Groth16 proofs, ShieldedNote encryption,
              and sign-derive — all as drop-in primitives. PrivateTip is ~250 lines on top.
            </p>
            <div className="flex flex-wrap justify-center gap-2 text-xs mb-8">
              {[
                "Sealed-bid NFT auctions", "Hidden pack openings",
                "AlphaArena private positions", "Confidential payroll",
                "Anonymous donations", "Cross-VM privacy wallets",
                "Dark-pool AMMs", "ZK voting",
              ].map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2.5 py-1 rounded-full border border-border bg-background/60 text-foreground/80 font-medium hover:border-[#00EF8B]/30 transition-colors"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href="https://www.npmjs.com/package/@openjanus/sdk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#0A1628] dark:bg-[#00EF8B] text-[#00EF8B] dark:text-[#0A1628] font-mono text-sm font-semibold hover:opacity-90 transition-opacity shadow-[0_2px_12px_color-mix(in_oklch,#00EF8B_25%,transparent)]"
              >
                npm i @openjanus/sdk
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href="https://github.com/openjanus"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border bg-background/80 backdrop-blur text-sm font-medium hover:bg-background transition-colors"
              >
                Source &amp; docs on GitHub
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border bg-background/80 backdrop-blur text-sm font-medium hover:bg-background transition-colors"
              >
                Try PrivateTip
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </motion.section>
    </div>
  );
}
