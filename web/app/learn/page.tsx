/// /learn — Theory explainer for the openjanus privacy stack.
/// Rebuilt with tabbed layout: How it works / Compare / Architecture / Roadmap
/// Framer-motion AnimatePresence tab transitions, URL hash routing, sticky tab nav.

"use client";

import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
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
  CheckCircle2,
  Clock,
  FlaskConical,
  Coins,
} from "lucide-react";
import Link from "next/link";
import { ShieldedNoteLifecycle } from "@/components/animations/ShieldedNoteLifecycle";

// ── Motion helpers ───────────────────────────────────────────────────────────

const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as const;

function useFadeIn(delay = 0) {
  const reduced = useReducedMotion();
  if (reduced) return {};
  return {
    initial: { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5, ease: EASE_OUT_EXPO, delay },
  };
}

// ── Typography helpers ───────────────────────────────────────────────────────

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
      <span className="inline-block font-mono text-sm bg-[#A78BFA]/10 text-[#A78BFA] border border-[#A78BFA]/25 px-4 py-2 rounded-lg">
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
    purple:  "bg-[#A78BFA]/8 border-[#A78BFA]/30 text-[#A78BFA]",
    blue:    "bg-blue-50/60 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700 text-blue-900 dark:text-blue-100",
    gold:    "bg-[#D4AF37]/8 border-[#D4AF37]/30 text-amber-900 dark:text-[#D4AF37]",
    copper:  "bg-[#FBBF24]/8 border-[#FBBF24]/30 text-[#FBBF24]",
  };
  const labelStyles: Record<string, string> = {
    amber:   "text-amber-700 dark:text-amber-300",
    emerald: "text-[#00EF8B]",
    purple:  "text-[#A78BFA]",
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

// ── Tab definition ────────────────────────────────────────────────────────────

type TabId = "how-it-works" | "compare" | "architecture" | "roadmap";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "how-it-works",  label: "How it works",  icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: "compare",       label: "Compare",        icon: <Layers className="w-3.5 h-3.5" /> },
  { id: "architecture",  label: "Architecture",   icon: <Cpu className="w-3.5 h-3.5" /> },
  { id: "roadmap",       label: "Roadmap",        icon: <GitBranch className="w-3.5 h-3.5" /> },
];

// ── Animations — unchanged from original, inline ─────────────────────────────

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
              ? "bg-[#A78BFA]/25 text-[#A78BFA] border border-[#A78BFA]/40"
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
                className="px-2 py-0.5 rounded bg-[#A78BFA]/20 text-[#A78BFA] blur-[2px] select-none"
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
                className="text-[#A78BFA]/60 blur-[2px] select-none"
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

function PedersenInteractive() {
  const [value, setValue] = useState("5");
  const [blinding, setBlinding] = useState("42");

  const v = Math.abs(parseInt(value) || 0) % 1000;
  const b = Math.abs(parseInt(blinding) || 0) % 10000;
  const angle = ((v * 37 + b * 131) % 360) * (Math.PI / 180);
  const rx = 100, ry = 50;
  const cx = 130, cy = 70;
  const px = cx + rx * Math.cos(angle);
  const py = cy + ry * Math.sin(angle);
  const hue = (v * 13 + b * 7) % 360;

  return (
    <div className="my-6 rounded-xl border border-[#A78BFA]/20 bg-[#A78BFA]/5 p-4">
      <p className="text-xs font-semibold text-[#A78BFA] uppercase tracking-wider mb-3">
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
              className="w-full px-3 py-2 text-sm font-mono border border-[#A78BFA]/30 rounded bg-background focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/30"
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
              className="w-full px-3 py-2 text-sm font-mono border border-[#A78BFA]/30 rounded bg-background focus:outline-none focus:ring-2 focus:ring-[#A78BFA]/30"
            />
          </div>
          <div className="rounded-lg bg-[#A78BFA]/10 px-3 py-2 text-xs font-mono text-[#A78BFA]">
            C = a·G + b·H
          </div>
          <p className="text-[10px] text-muted-foreground">
            Same amount, different blinding → completely different point. This is perfect hiding.
          </p>
        </div>
        <div className="shrink-0 flex items-center justify-center overflow-x-auto">
          <svg width="260" height="140" viewBox="0 0 260 140" className="overflow-visible min-w-[260px]">
            <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke="#A78BFA" strokeOpacity="0.25" strokeWidth="1.5" />
            <line x1="30" y1={cy} x2={cx+rx+30} y2={cy} stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.5" />
            <line x1={cx} y1="20" x2={cx} y2={cy+ry+30} stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.5" />
            <circle cx={cx + rx} cy={cy} r="3.5" fill="#00EF8B" opacity="0.7" />
            <text x={cx + rx + 5} y={cy + 4} fontSize="8" fill="#00EF8B" opacity="0.8">G</text>
            <circle cx={cx - rx} cy={cy} r="3.5" fill="#D4AF37" opacity="0.7" />
            <text x={cx - rx - 12} y={cy + 4} fontSize="8" fill="#D4AF37" opacity="0.8">H</text>
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
                  ? "bg-[#A78BFA]/25 text-[#A78BFA] border border-[#A78BFA]/40"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border">
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
        <div className="p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">UTXO model</p>
          <div className="flex flex-col items-center gap-2">
            <div className="w-full min-h-[80px] rounded-lg border border-[#A78BFA]/30 bg-[#A78BFA]/5 px-3 py-3 flex flex-wrap gap-2 items-center justify-center">
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
                      className="w-14 h-14 rounded-full border-2 border-[#A78BFA]/40 bg-[#A78BFA]/15 flex items-center justify-center text-xs font-bold text-[#A78BFA]"
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

function CompareTable() {
  const rows = [
    { feature: "Balance model",      openjanus: "One accumulated commitment",         railgun: "Many unspent notes (UTXOs)",       aztec: "One accumulated commitment" },
    { feature: "Amount hiding",      openjanus: "Yes — Pedersen + Groth16",           railgun: "Yes — Groth16 (UTXO-per-note)",    aztec: "Yes — Honk / UltraHonk" },
    { feature: "Sender/recipient",   openjanus: "Visible today → stealth on roadmap", railgun: "Hidden (stealth + UTXO set)",      aztec: "Hidden (account abstraction)" },
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
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">1</div>
          <div className="flex-1">
            <p className="text-xs font-medium mb-1">Wallet signs fixed message</p>
            <div className="font-mono text-[10px] bg-background border border-border rounded px-3 py-2 text-muted-foreground break-all">
              "openjanus:memokey:v1"
            </div>
          </div>
        </div>

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

function BoundaryDiagram() {
  return (
    <div className="my-6 rounded-xl border border-border bg-card overflow-hidden">
      <div className="bg-[#FBBF24]/8 px-4 py-3 border-b border-border">
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
                  ? "bg-[#A78BFA]/15 text-[#A78BFA]/60 blur-[1px]"
                  : "bg-[#FBBF24]/15 text-[#FBBF24]"
              }`}>{cell.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="janus-divider-shimmer" />
      <div className="bg-[#00EF8B]/5 px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-[#00EF8B] mb-2">Private zone (your wallet)</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Wrap", value: "+2.0" },
            { label: "Tips sent", value: "−0.5" },
            { label: "Withdraw", value: "−1.5" },
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

function CeremonyAnimation() {
  const reduced = useReducedMotion();
  const contributors = [
    { label: "Researcher A", color: "#A78BFA", x: 40, y: 40 },
    { label: "Wallet Dev",   color: "#00EF8B", x: 200, y: 20 },
    { label: "Academic",    color: "#FBBF24", x: 340, y: 50 },
    { label: "Anon",        color: "#A78BFA", x: 80, y: 110 },
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
          <circle cx={200} cy={75} r={22} fill="#D4AF37" fillOpacity="0.15" stroke="#D4AF37" strokeWidth="1.5" strokeOpacity="0.6" />
          <text x={200} y={79} textAnchor="middle" fontSize="10" fill="#D4AF37" fontWeight="600">Ceremony</text>
          <circle cx={200} cy={75} r={32} fill="none" stroke="#D4AF37" strokeWidth="1" strokeOpacity="0.2" strokeDasharray="6 4">
            {!reduced && (
              <animateTransform attributeName="transform" type="rotate" from="0 200 75" to="360 200 75" dur="8s" repeatCount="indefinite" />
            )}
          </circle>
        </svg>
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
        <span className="w-2 h-2 rounded-full bg-[#A78BFA]" />
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

// ── Roadmap Kanban ────────────────────────────────────────────────────────────

type RoadmapStatus = "now" | "next" | "later";

interface RoadmapCard {
  title: string;
  desc: string;
  status: RoadmapStatus;
  version: string;
}

const ROADMAP_CARDS: RoadmapCard[] = [
  // NOW
  {
    status: "now",
    version: "v0.5",
    title: "128-bit balance range",
    desc: "Mainnet-ready math — proofs handle amounts up to 128 bits with overflow guards.",
  },
  {
    status: "now",
    version: "v0.5",
    title: "Shielded transfer",
    desc: "Full Cadence cross-VM shielded tip in one transaction.",
  },
  {
    status: "now",
    version: "v0.5",
    title: "MemoKey sign-derive",
    desc: "Deterministic inbox key from wallet signature — no seed phrase.",
  },
  {
    status: "now",
    version: "v0.5",
    title: "Balance recovery",
    desc: "Reconstruct position on any device from ShieldedNote history.",
  },
  // NEXT
  {
    status: "next",
    version: "Next",
    title: "Sender↔recipient unlink",
    desc: "ERC-5564-style stealth addresses — the chain no longer reveals who tipped whom.",
  },
  {
    status: "next",
    version: "Next",
    title: "Fee management",
    desc: "Gas sponsorship for private txs — pay fees without revealing shielded balance.",
  },
  {
    status: "next",
    version: "Next",
    title: "Multisig admin",
    desc: "Multi-party key for contract upgrades and parameter changes.",
  },
  // LATER
  {
    status: "later",
    version: "v0.7+",
    title: "UTXO mode",
    desc: "Large hidden-set mode for dark pools and sealed-bid auctions.",
  },
  {
    status: "later",
    version: "v0.8",
    title: "Encrypted history backup",
    desc: "Portable recovery blob — ShieldedNote history exported and re-importable.",
  },
  {
    status: "later",
    version: "R1–R3",
    title: "ZK identity & FHE",
    desc: "Research track: FHE over encrypted state, lattice post-quantum variants.",
  },
];

const COL_META: Record<RoadmapStatus, { label: string; icon: React.ReactNode; color: string; border: string; bg: string }> = {
  now:   { label: "Now",   icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: "#00EF8B", border: "border-[#00EF8B]/30", bg: "bg-[#00EF8B]/5"  },
  next:  { label: "Next",  icon: <Clock className="w-3.5 h-3.5" />,       color: "#FBBF24", border: "border-[#FBBF24]/30", bg: "bg-[#FBBF24]/5"  },
  later: { label: "Later", icon: <FlaskConical className="w-3.5 h-3.5" />, color: "#A78BFA", border: "border-[#A78BFA]/30", bg: "bg-[#A78BFA]/5"  },
};

function RoadmapKanban() {
  const reduced = useReducedMotion();
  const cols: RoadmapStatus[] = ["now", "next", "later"];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 my-6">
      {cols.map((col) => {
        const meta = COL_META[col];
        const cards = ROADMAP_CARDS.filter((c) => c.status === col);
        return (
          <div key={col} className={`rounded-xl border ${meta.border} ${meta.bg} overflow-hidden`}>
            {/* Column header */}
            <div
              className="flex items-center gap-2 px-3 py-2.5 border-b"
              style={{ borderColor: meta.color + "22", background: meta.color + "10" }}
            >
              <span style={{ color: meta.color }}>{meta.icon}</span>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: meta.color }}>
                {meta.label}
              </span>
            </div>
            {/* Cards */}
            <div className="p-2 space-y-2">
              {cards.map((card, i) => (
                <motion.div
                  key={card.title}
                  initial={reduced ? {} : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: EASE_OUT_EXPO, delay: i * 0.08 }}
                  className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-xs font-semibold text-foreground leading-snug">{card.title}</span>
                    <span
                      className="text-[9px] font-mono shrink-0 px-1.5 py-0.5 rounded border"
                      style={{ color: meta.color, borderColor: meta.color + "40", background: meta.color + "12" }}
                    >
                      {card.version}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{card.desc}</p>
                </motion.div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab panels ────────────────────────────────────────────────────────────────

function TabHowItWorks() {
  return (
    <div className="space-y-10 py-6">
      {/* Section: The problem */}
      <section id="how-public-chains" className="scroll-mt-32">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-[#FBBF24]/15 border border-[#FBBF24]/30 flex items-center justify-center shrink-0">
            <Eye className="w-4 h-4 text-[#FBBF24]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              The problem with public chains
            </h2>
            <p className="text-xs text-muted-foreground">2 min · Everything leaks by default</p>
          </div>
        </div>
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
          the &quot;who tipped whom&quot; visibility is social proof. Sender/recipient unlink
          (stealth addresses) is on the roadmap.
        </Callout>
      </section>

      {/* Section: Pedersen */}
      <section id="how-pedersen" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#A78BFA]/15 border border-[#A78BFA]/30 flex items-center justify-center shrink-0">
            <Lock className="w-4 h-4 text-[#A78BFA]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              The Pedersen commitment
            </h2>
            <p className="text-xs text-muted-foreground">3 min · A sealed envelope anyone can verify</p>
          </div>
        </div>
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
      </section>

      {/* Section: ShieldedNote — THE GOOD ANIMATION */}
      <section id="how-shieldednote" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center shrink-0">
            <Key className="w-4 h-4 text-[#00EF8B]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              The ShieldedNote — the recovery channel
            </h2>
            <p className="text-xs text-muted-foreground">2 min · Without this, balances accumulate silently</p>
          </div>
        </div>
        <P>
          Here&apos;s a subtle problem most explainers gloss over. Suppose Alice sends Bob 5 FLOW,
          privately. The on-chain commitment at Bob&apos;s address changes by some opaque amount.
          How does Bob know he received 5? Without the exact <em>(amount, blinding)</em> pair,
          he cannot construct a valid ZK proof when he wants to withdraw.
        </P>
        {/* THE REDESIGNED ANIMATION */}
        <ShieldedNoteLifecycle />
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
      </section>

      {/* Section: What's NOT private */}
      <section id="how-not-private" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#FBBF24]/15 border border-[#FBBF24]/30 flex items-center justify-center shrink-0">
            <Eye className="w-4 h-4 text-[#FBBF24]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              What&apos;s NOT private
            </h2>
            <p className="text-xs text-muted-foreground">1 min · Honest scope of today&apos;s privacy guarantees</p>
          </div>
        </div>
        <P>
          PrivateTip hides <Em>amounts</Em>. It does not hide identities or patterns. Before you
          use it, know exactly what stays public:
        </P>
        <Callout accent="copper" label="What's NOT private">
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>Sender address (visible on-chain)</li>
            <li>Recipient address (visible on-chain)</li>
            <li>Transaction timestamp</li>
            <li>Tx graph / frequency / social pattern</li>
          </ul>
        </Callout>
        <P>
          If you need sender/recipient unlinkability, wait for stealth-address support on the
          roadmap — or compose PrivateTip with a separate stealth-address primitive.
        </P>
      </section>

      {/* Section: Fee model */}
      <section id="how-fees" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center shrink-0">
            <Coins className="w-4 h-4 text-[#00EF8B]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              Fees
            </h2>
            <p className="text-xs text-muted-foreground">30 sec · Boundary-only, hard-capped</p>
          </div>
        </div>
        <P>
          PrivateTip charges a <Em>0.1% fee at the boundary</Em> — when you wrap FLOW into a
          shielded balance and when you unwrap back out. Shielded transfers between users are
          free. The fee is hard-capped at 1% by the contract and flows to the openjanus admin
          COA.
        </P>
      </section>
    </div>
  );
}

function TabCompare() {
  return (
    <div className="space-y-10 py-6">
      {/* Account vs UTXO */}
      <section id="compare-models" className="scroll-mt-32">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950/60 border border-blue-300/40 flex items-center justify-center shrink-0">
            <Layers className="w-4 h-4 text-blue-700 dark:text-blue-300" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              Account model vs UTXO model
            </h2>
            <p className="text-xs text-muted-foreground">4 min · Two schools of privacy architecture</p>
          </div>
        </div>
        <P>
          The privacy industry has settled into two camps. The <Em>UTXO model</Em> treats each
          incoming payment as a discrete &quot;note&quot; — like a physical coin. The{" "}
          <Em>account model</Em> keeps one accumulated balance per address, updated
          homomorphically.
        </P>
        <AccountVsUTXO />
        <P>
          openjanus chose the account model for v1. Flow&apos;s resource model maps cleanly to
          &quot;one owned object per user.&quot; Stealth addresses can be layered on top without
          rewriting the commitment math.
        </P>
      </section>

      {/* Industry comparison */}
      <section id="compare-industry" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-[#00EF8B]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              openjanus vs Railgun vs Aztec
            </h2>
            <p className="text-xs text-muted-foreground">Feature-by-feature</p>
          </div>
        </div>
        <CompareTable />
        <Callout accent="emerald" label="Why Cadence cross-VM">
          openjanus runs the ZK verifier as an EVM contract but wraps it in a Cadence
          transaction — giving you Flow&apos;s resource model (no approvals, typed ownership)
          and EVM&apos;s mature proof toolchain in one atomic call. No other chain can do this.
        </Callout>
      </section>
    </div>
  );
}

function TabArchitecture() {
  return (
    <div className="space-y-10 py-6">
      {/* Sign-derive */}
      <section id="arch-sign-derive" className="scroll-mt-32">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/15 border border-[#D4AF37]/30 flex items-center justify-center shrink-0">
            <RefreshCw className="w-4 h-4 text-[#D4AF37]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              Sign-derive — the multi-device unlock
            </h2>
            <p className="text-xs text-muted-foreground">3 min · How your inbox key survives browser resets</p>
          </div>
        </div>
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
      </section>

      {/* Boundary pattern */}
      <section id="arch-boundary" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#FBBF24]/15 border border-[#FBBF24]/30 flex items-center justify-center shrink-0">
            <Eye className="w-4 h-4 text-[#FBBF24]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              The boundary pattern
            </h2>
            <p className="text-xs text-muted-foreground">2 min · Amounts leak at entry and exit only</p>
          </div>
        </div>
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
        <Callout accent="amber" label="Why withdraw amounts are always public — architecture, not a bug">
          Withdraw (unwrap) amounts are inherently public on Flow EVM. The contract
          sends native FLOW to the recipient via an internal transaction, which any
          block explorer shows regardless of what events are emitted. Calldata,
          the internal value transfer, the <Em>totalLocked</Em> storage delta, and
          the contract balance delta all independently reveal the amount. This is a
          property of EVM — not of this contract. The design is <Em>amount privacy
          on shielded transfers, transparency at boundaries</Em>.
        </Callout>
        <Callout accent="copper" label="Practical privacy tip">
          For the strongest privacy, after withdrawing, immediately forward your FLOW to a
          fresh wallet you&apos;ve never used publicly. This breaks the link between your shielded
          identity and your future spending wallet.
        </Callout>
      </section>

      {/* Ceremony */}
      <section id="arch-ceremony" className="scroll-mt-32 pt-2 border-t border-border">
        <div className="flex items-center gap-3 mb-4 mt-4">
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/15 border border-[#D4AF37]/30 flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-[#D4AF37]" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
              The trusted setup ceremony
            </h2>
            <p className="text-xs text-muted-foreground">3 min · Why ZK needs a ceremony — and why MPC makes it safe</p>
          </div>
        </div>
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

        {/* Architecture layers callout */}
        <div className="mt-8 rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Layer diagram</p>
          <div className="space-y-2">
            {[
              { label: "Cadence router", note: "Transaction entry · resource ownership", color: "#00EF8B" },
              { label: "EVM proxy (CrossVM call)", note: "Atomic bridge · Flow cross-VM", color: "#D4AF37" },
              { label: "Groth16 verifier", note: "On-chain proof check · 200k gas", color: "#A78BFA" },
              { label: "MemoStore", note: "ECIES-encrypted ShieldedNote registry", color: "#FBBF24" },
            ].map((row, i) => (
              <div key={row.label} className="flex items-center gap-3">
                <div
                  className="w-2 h-8 rounded-full shrink-0"
                  style={{ background: row.color + "40", borderLeft: `2px solid ${row.color}` }}
                />
                <div>
                  <p className="text-xs font-semibold" style={{ color: row.color }}>{row.label}</p>
                  <p className="text-[10px] text-muted-foreground">{row.note}</p>
                </div>
                {i < 3 && (
                  <div className="ml-auto">
                    <ArrowRight className="w-3 h-3 text-foreground/20 rotate-90" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function TabRoadmap() {
  return (
    <div className="py-6">
      <div className="mb-4">
        <h2 className="text-lg font-bold mb-1" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
          What&apos;s next (v0.5 → v1.0)
        </h2>
        <p className="text-sm text-muted-foreground">
          Every upgrade is anchored to a concrete use case that would be blocked without it.
        </p>
      </div>
      <RoadmapKanban />
      <Callout accent="emerald" label="Research track">
        R1–R3 items (FHE, multi-circuit zkVM, post-quantum lattices) are exploratory — no
        ship date. They require either ecosystem tooling maturation or protocol-level changes
        on Flow.
      </Callout>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LearnPage() {
  const [activeTab, setActiveTab] = useState<TabId>("how-it-works");
  const reduced = useReducedMotion();

  // URL hash sync on mount + back/forward
  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((t) => t.id === hash)) {
        setActiveTab(hash);
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const handleTabChange = useCallback((id: TabId) => {
    setActiveTab(id);
    window.history.replaceState(null, "", `#${id}`);
  }, []);

  const heroAnim = useFadeIn(0);

  const tabContent: Record<TabId, React.ReactNode> = {
    "how-it-works": <TabHowItWorks />,
    compare: <TabCompare />,
    architecture: <TabArchitecture />,
    roadmap: <TabRoadmap />,
  };

  return (
    <div className="flex flex-col items-center janus-hex-bg min-h-screen">
      {/* ── Compact Hero ───────────────────────────────────────────────────── */}
      <motion.div
        {...heroAnim}
        className="w-full max-w-3xl mx-auto px-4 pt-10 pb-6 text-center"
      >
        {/* Janus arch SVG — compact */}
        <div className="flex justify-center mb-4">
          <svg width="60" height="46" viewBox="0 0 80 60" fill="none" className="drop-shadow-[0_0_10px_rgba(167,139,250,0.4)]">
            <path d="M40 50 Q10 50 10 20 Q10 5 25 5" stroke="#A78BFA" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M40 50 Q70 50 70 20 Q70 5 55 5" stroke="#00EF8B" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle cx="20" cy="15" r="6" fill="#A78BFA" fillOpacity="0.3" stroke="#A78BFA" strokeWidth="1.5" />
            <circle cx="18" cy="14" r="1.2" fill="#A78BFA" />
            <circle cx="22" cy="14" r="1.2" fill="#A78BFA" />
            <circle cx="60" cy="15" r="6" fill="#00EF8B" fillOpacity="0.3" stroke="#00EF8B" strokeWidth="1.5" />
            <circle cx="58" cy="14" r="1.2" fill="#00EF8B" />
            <circle cx="62" cy="14" r="1.2" fill="#00EF8B" />
            <circle cx="40" cy="5" r="4" fill="#D4AF37" fillOpacity="0.7" />
          </svg>
        </div>

        <h1
          className="text-2xl sm:text-3xl font-bold tracking-tight mb-2"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          The Two Faces of On-Chain Money
        </h1>
        <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-3">
          Plain-language cryptography behind PrivateTip and the{" "}
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            @openjanus/sdk
          </span>{" "}
          stack.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground mb-4">
          <span className="flex items-center gap-1">
            <BookOpen className="w-3 h-3" /> ~15 min
          </span>
          <span>·</span>
          <span>4 tabs</span>
          <span>·</span>
          <span>Updated May 2026</span>
          <span>·</span>
          <Link href="/" className="flex items-center gap-1 hover:text-foreground transition-colors">
            ← Back
          </Link>
        </div>
      </motion.div>

      {/* ── Sticky Tab Nav ─────────────────────────────────────────────────── */}
      <div className="sticky top-[calc(theme(spacing.7)+theme(spacing.14))] z-30 w-full bg-background/90 backdrop-blur border-b border-border">
        <div className="max-w-3xl mx-auto px-4">
          <div className="flex gap-0 overflow-x-auto scrollbar-hide">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  className={`flex items-center gap-1.5 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-all border-b-2 ${
                    isActive
                      ? "border-[#00EF8B] text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  <span className={isActive ? "text-[#00EF8B]" : ""}>{tab.icon}</span>
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Tab content ────────────────────────────────────────────────────── */}
      <div className="w-full max-w-3xl mx-auto px-4 pb-16">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={reduced ? {} : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? {} : { opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
          >
            {tabContent[activeTab]}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── CTA (always visible, below tabs) ───────────────────────────────── */}
      <motion.section
        initial={reduced ? {} : { opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
        className="w-full max-w-3xl mx-auto px-4 pb-12"
      >
        <div className="relative overflow-hidden rounded-3xl border border-[#A78BFA]/20 bg-gradient-to-br from-[#A78BFA]/8 via-background to-[#00EF8B]/8 p-5 sm:p-8 md:p-10">
          <div className="absolute -top-16 -left-16 w-48 h-48 rounded-full bg-[#A78BFA]/15 blur-3xl pointer-events-none" aria-hidden />
          <div className="absolute -bottom-16 -right-16 w-48 h-48 rounded-full bg-[#00EF8B]/15 blur-3xl pointer-events-none" aria-hidden />
          <div className="relative text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[#A78BFA]/10 border border-[#A78BFA]/20 mb-5">
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
                "Confidential donations", "Cross-VM privacy wallets",
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
