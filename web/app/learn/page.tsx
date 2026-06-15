/// /learn — App guide for PrivateTip users.
/// 4-tab layout: what / how / privacy / faq
/// Focus: app usage, not protocol theory.

"use client";

import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Shield,
  BookOpen,
  ExternalLink,
  Zap,
  HelpCircle,
} from "lucide-react";
import Link from "next/link";
import { ShieldedNoteLifecycle } from "@/components/animations/ShieldedNoteLifecycle";

// ── Motion helpers ────────────────────────────────────────────────────────────

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

// ── Typography helpers ────────────────────────────────────────────────────────

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-foreground/90 leading-relaxed mb-4 last:mb-0">
      {children}
    </p>
  );
}

function Em({ children }: { children: React.ReactNode }) {
  return <em className="not-italic font-semibold text-foreground">{children}</em>;
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

// ── Tab definition ─────────────────────────────────────────────────────────────

type TabId = "what" | "how" | "privacy" | "faq";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "what",    label: "What is it",  icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: "how",     label: "How to use",  icon: <Zap className="w-3.5 h-3.5" /> },
  { id: "privacy", label: "Privacy",     icon: <Shield className="w-3.5 h-3.5" /> },
  { id: "faq",     label: "FAQ",         icon: <HelpCircle className="w-3.5 h-3.5" /> },
];

// ── PublicPrivateToggle ────────────────────────────────────────────────────────

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
          ? "Amount replaced by a cryptographic commitment. Memo ECIES-encrypted. Toggle to compare."
          : "Fully public — amount, memo visible to all. Toggle to see private mode."}
      </div>
    </div>
  );
}

// ── SignDeriveAnimation ────────────────────────────────────────────────────────

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
            <p className="text-xs font-medium mb-1">Wallet signs a fixed message</p>
            <div className="font-mono text-[10px] bg-background border border-border rounded px-3 py-2 text-muted-foreground break-all">
              "openjanus:memokey:v1"
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">2</div>
          <div className="flex-1">
            <p className="text-xs font-medium mb-1">Signature → HKDF-SHA256 → MemoKey scalar</p>
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

// ── Step component ─────────────────────────────────────────────────────────────

function Step({
  n,
  title,
  children,
  isLast = false,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center shrink-0">
        <div className="w-7 h-7 rounded-full bg-[#00EF8B]/15 border border-[#00EF8B]/30 flex items-center justify-center text-xs font-bold text-[#00EF8B]">
          {n}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-2 min-h-[24px]" />}
      </div>
      <div className="pb-8 flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground mb-2">{title}</p>
        <div className="text-sm text-foreground/80 leading-relaxed space-y-2">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── FaqItem ────────────────────────────────────────────────────────────────────

function FaqItem({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start justify-between gap-3 py-4 text-left"
      >
        <span className="text-sm font-medium text-foreground leading-snug">{question}</span>
        <span className={`text-muted-foreground mt-0.5 shrink-0 transition-transform duration-200 ${open ? "rotate-45" : ""}`}>
          +
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? {} : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduced ? {} : { opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
            className="overflow-hidden"
          >
            <div className="pb-5 text-sm text-foreground/80 leading-relaxed space-y-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Tab: What is PrivateTip? ───────────────────────────────────────────────────

function TabWhat() {
  return (
    <div className="space-y-8 py-6">
      <section>
        <h2
          className="text-base font-bold mb-3"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          What is PrivateTip?
        </h2>
        <P>
          PrivateTip lets you send and receive tips on Flow without revealing the amount.
          Your wallet address stays public. The number moves privately.
        </P>
        <P>
          It runs across two environments simultaneously — Flow EVM handles the cryptographic
          proofs and FLOW/mUSDC balances; Flow Cadence handles resource ownership and
          account setup. One transaction, two environments, no extra wallet popups.
        </P>

        <PublicPrivateToggle />

        <Callout accent="copper" label="Privacy scope — v0.8">
          PrivateTip hides <strong>amounts only</strong>. Sender and recipient addresses
          are visible on-chain. Sender/recipient unlinking is on the roadmap.
        </Callout>
      </section>

      <section>
        <h3 className="text-sm font-bold mb-3 text-foreground/90">Who uses it</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              role: "Creator",
              icon: "🎨",
              desc: "Accept tips from multiple supporters. No one sees who gave more or less.",
            },
            {
              role: "Tipper",
              icon: "💸",
              desc: "Send a private tip. Amount is cryptographically hidden from the explorer.",
            },
            {
              role: "Community",
              icon: "🌐",
              desc: "Fund a shared goal without social pressure from visible amounts.",
            },
          ].map((item) => (
            <div
              key={item.role}
              className="rounded-xl border border-border bg-card px-4 py-3"
            >
              <div className="text-xl mb-2">{item.icon}</div>
              <p className="text-xs font-semibold text-foreground mb-1">{item.role}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-card">
          {[
            { label: "Tips sent", value: "—" },
            { label: "Active users", value: "—" },
            { label: "Tokens supported", value: "FLOW, mUSDC" },
          ].map((stat) => (
            <div key={stat.label} className="px-4 py-4 text-center">
              <p
                className="text-lg font-bold text-foreground"
                style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
              >
                {stat.value}
              </p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                {stat.label}
              </p>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 text-center">
          Stats will update when the indexer goes live.
        </p>
      </section>
    </div>
  );
}

// ── Tab: How to use ───────────────────────────────────────────────────────────

function TabHow() {
  return (
    <div className="py-6">
      <h2
        className="text-base font-bold mb-6"
        style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
      >
        How to use PrivateTip
      </h2>

      <div className="relative">
        {/* Step 1: Activate */}
        <Step n={1} title="Activate (3 signatures)">
          <p>Activation runs 3 on-chain steps in sequence:</p>
          <ul className="space-y-1.5 text-xs text-muted-foreground list-none pl-0 mt-2">
            <li className="flex gap-2">
              <span className="font-mono text-[#D4AF37] shrink-0">1a</span>
              <span>
                <strong>Sign locally.</strong> Your wallet signs a fixed message.
                The app derives your MemoKey from that signature — no server, no storage.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-[#D4AF37] shrink-0">1b</span>
              <span>
                <strong>Publish MemoKey + install Cadence resources.</strong>{" "}
                Registers your inbox public key on-chain so others can encrypt tips to you.
                Sets up the Cadence resource in your account (needed for MockFT shielded balance).
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-[#D4AF37] shrink-0">1c</span>
              <span>
                <strong>Initialize ShieldedCheckpoint slots (EVM).</strong>{" "}
                Creates your per-token checkpoint on-chain. This is what lets you recover
                your balance on any device without losing funds.
              </span>
            </li>
          </ul>
          <p className="text-xs text-muted-foreground mt-3">
            Check activation status at{" "}
            <Link href="/status" className="text-[#00EF8B] hover:underline">
              /status
            </Link>
            .
          </p>
          <SignDeriveAnimation />
        </Step>

        {/* Step 2: Receive */}
        <Step n={2} title="Receive a tip">
          <p>
            When someone tips you, their transaction updates your shielded commitment
            on-chain and drops an encrypted note into your <Em>ShieldedInbox</Em>.
            The inbox lives on Flow EVM for FLOW and mUSDC.
          </p>
          <p className="text-xs text-muted-foreground">
            You won&apos;t see the amount until you claim. The note sits encrypted in
            the contract, readable only by your MemoKey.
          </p>
        </Step>

        {/* Step 3: Claim */}
        <Step n={3} title="Claim (required before sending or wrapping again)">
          <p>
            Claiming decrypts your inbox notes and rebuilds your spendable balance.
            One claim proof covers up to <Em>10 notes at once</Em>. If you have more
            than 10 pending, you&apos;ll need multiple claims.
          </p>
          <ShieldedNoteLifecycle />
          <Callout accent="amber" label="Submit is disabled when you have unclaimed tips">
            This is a safety guarantee, not a soft warning. The UI blocks wrap/send
            while pending notes exist. If you try to bypass it, the SDK throws a{" "}
            <span className="font-mono text-xs">CheckpointDivergenceError</span>
            , and the contract would revert anyway. All three layers agree: claim first.
          </Callout>
        </Step>

        {/* Step 4: Send */}
        <Step n={4} title="Send a tip">
          <p>
            Enter a recipient address and an amount. The app generates a ZK proof
            and sends it in one cross-VM transaction.
          </p>
          <p className="text-xs text-muted-foreground">
            The recipient must have activated. Without a registered MemoKey, there
            is no key to encrypt the note to — the transaction will be blocked.
          </p>
        </Step>

        {/* Step 5: Withdraw */}
        <Step n={5} title="Withdraw (unwrap to regular wallet)" isLast>
          <p>
            Submit a withdrawal with a ZK proof. The contract verifies your balance
            and releases real FLOW or mUSDC to your wallet.
          </p>
          <Callout accent="amber" label="Withdrawal amounts are public">
            The withdrawal amount appears on-chain — the actual token transfer is
            visible in any block explorer. This is an EVM property, not a protocol choice.
          </Callout>
        </Step>
      </div>
    </div>
  );
}

// ── Tab: Privacy ──────────────────────────────────────────────────────────────

type PrivacyRow = {
  op: string;
  amount: string;
  amountHidden: boolean;
  sender: string;
  senderHidden: boolean | null;
  recipient: string;
};

const PRIVACY_ROWS: PrivacyRow[] = [
  {
    op: "Wrap",
    amount: "Visible",
    amountHidden: false,
    sender: "Visible",
    senderHidden: false,
    recipient: "n/a",
  },
  {
    op: "Send tip",
    amount: "Hidden",
    amountHidden: true,
    sender: "Hidden (no on-chain link)",
    senderHidden: true,
    recipient: "Sender can't see your other tips",
  },
  {
    op: "Claim",
    amount: "Hidden",
    amountHidden: true,
    sender: "n/a",
    senderHidden: null,
    recipient: "n/a",
  },
  {
    op: "Withdraw",
    amount: "Visible",
    amountHidden: false,
    sender: "Visible",
    senderHidden: false,
    recipient: "n/a",
  },
];

function TabPrivacy() {
  return (
    <div className="space-y-8 py-6">
      {/* Privacy table */}
      <section>
        <h2
          className="text-base font-bold mb-4"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          What&apos;s hidden, what&apos;s not
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                  Operation
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                  Sender
                </th>
                <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                  Recipient
                </th>
              </tr>
            </thead>
            <tbody>
              {PRIVACY_ROWS.map((row, i) => (
                <tr key={row.op} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                  <td className="px-3 py-2.5 font-medium text-foreground">{row.op}</td>
                  <td
                    className={`px-3 py-2.5 text-[11px] font-medium ${
                      row.amountHidden ? "text-[#00EF8B]" : "text-[#FBBF24]"
                    }`}
                  >
                    {row.amountHidden ? "✓ " : "✗ "}
                    {row.amount}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-[11px] ${
                      row.senderHidden === null
                        ? "text-muted-foreground"
                        : row.senderHidden
                        ? "text-[#00EF8B] font-medium"
                        : "text-[#FBBF24] font-medium"
                    }`}
                  >
                    {row.senderHidden !== null
                      ? `${row.senderHidden ? "✓ " : "✗ "}${row.sender}`
                      : row.sender}
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
                    {row.recipient}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          ✓ = hidden from public ledger &nbsp; ✗ = visible on-chain
        </p>
      </section>

      {/* Live toggle */}
      <section>
        <h3 className="text-sm font-bold mb-2 text-foreground/90">See the difference live</h3>
        <PublicPrivateToggle />
      </section>

      {/* 3-layer safety */}
      <section>
        <h3 className="text-sm font-bold mb-3 text-foreground/90">
          Three layers prevent state corruption
        </h3>
        <div className="space-y-2">
          {[
            {
              layer: "UI",
              label: "Submit disabled",
              desc: "Send and wrap buttons are disabled while you have unclaimed notes pending.",
            },
            {
              layer: "SDK",
              label: "CheckpointDivergenceError",
              desc: "The SDK throws before signing if it detects your local state diverges from the on-chain checkpoint.",
            },
            {
              layer: "Contract",
              label: "C_old mismatch revert",
              desc: "The EVM contract verifies your commitment matches before updating it. Diverged state causes a revert.",
            },
          ].map((item) => (
            <div
              key={item.layer}
              className="flex gap-3 rounded-lg border border-border bg-card px-4 py-3 items-start"
            >
              <span className="font-mono text-[10px] font-bold text-[#A78BFA] uppercase w-16 shrink-0 mt-0.5">
                {item.layer}
              </span>
              <div>
                <p className="text-xs font-semibold text-foreground mb-0.5">{item.label}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* MockFT note */}
      <section>
        <h3 className="text-sm font-bold mb-3 text-foreground/90">
          MockFT vs FLOW/mUSDC — where your balance lives
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[#00EF8B]/25 bg-[#00EF8B]/5 px-4 py-3">
            <p className="text-xs font-bold text-[#00EF8B] mb-1">FLOW &amp; mUSDC</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Shielded balance lives in a shared EVM contract pool.
              Your commitment is a slot in a mapping — not visible as yours, just an entry.
            </p>
          </div>
          <div className="rounded-xl border border-[#A78BFA]/25 bg-[#A78BFA]/5 px-4 py-3">
            <p className="text-xs font-bold text-[#A78BFA] mb-1">MockFT</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Shielded balance lives in a Cadence resource{" "}
              <Em>in your own account</Em> — not in a central pool.
              Nobody else can access or read it.
            </p>
          </div>
        </div>
      </section>

      {/* vs other tools */}
      <section>
        <h3 className="text-sm font-bold mb-3 text-foreground/90">vs other tools</h3>
        <div className="space-y-2">
          {[
            {
              tool: "Venmo",
              line: "Amounts and transaction notes are public by default. No cryptographic hiding. Social graph is fully visible.",
            },
            {
              tool: "Tornado Cash",
              line: "Hides amounts and identity by breaking the on-chain link entirely. Sanctioned — restricted in many jurisdictions.",
            },
            {
              tool: "PrivateTip",
              line: "Hides amounts only. Sender/recipient addresses visible. No sanctions risk. Privacy not impunity.",
            },
          ].map((row) => (
            <div
              key={row.tool}
              className="flex gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <span className="text-xs font-bold text-foreground w-28 shrink-0">{row.tool}</span>
              <span className="text-xs text-muted-foreground leading-relaxed">{row.line}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Honest limitations */}
      <section>
        <Callout accent="amber" label="What PrivateTip does not protect">
          <ul className="list-disc pl-5 space-y-1.5 text-sm">
            <li>Wallet addresses — wrap and withdraw events are linked to your address.</li>
            <li>Transaction timestamps and frequency — patterns are visible.</li>
            <li>Anonymity set — small user count means timing correlations are possible.</li>
            <li>IP address — use a VPN if you need network-level privacy.</li>
            <li>Who tipped whom — addresses are visible, only the amount is hidden.</li>
          </ul>
        </Callout>
      </section>
    </div>
  );
}

// ── Tab: FAQ ──────────────────────────────────────────────────────────────────

function TabFaq() {
  return (
    <div className="py-6">
      <h2
        className="text-base font-bold mb-6"
        style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
      >
        FAQ &amp; Troubleshooting
      </h2>

      <div className="rounded-xl border border-border bg-card px-4 divide-y divide-border overflow-hidden">
        <FaqItem question="Why do I need to claim before sending again?">
          <p>
            When you receive a tip, the on-chain commitment updates immediately — before
            you claim. Your local state is now behind the chain.
          </p>
          <p>
            If you tried to send using the old commitment, the contract would revert with
            a <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded">C_old mismatch</span>{" "}
            error. So the UI disables send/wrap until you claim and sync.
          </p>
          <p>
            Claiming decrypts the incoming notes locally and rebuilds your spendable state.
            Check your inbox at{" "}
            <Link href="/portfolio" className="text-[#00EF8B] hover:underline">
              /portfolio
            </Link>
            .
          </p>
        </FaqItem>

        <FaqItem question="What if I clear my browser or switch devices?">
          <p>
            Your shielded balance is safe. It is backed up to your{" "}
            <Em>ShieldedCheckpoint</Em> on-chain — a per-token EVM contract slot tied to
            your address that stores your encrypted state.
          </p>
          <p>
            On a new device: connect the same wallet, sign to derive the MemoKey, and the
            app fetches your checkpoint from the chain and re-decrypts your state.
            Nothing is lost.
          </p>
        </FaqItem>

        <FaqItem question="What if I lose my MemoKey?">
          <p>
            You can re-derive it at any time. Connect the same wallet and the app signs
            the same fixed message. The key is deterministic — same wallet, same result,
            on any device.
          </p>
          <p>
            The only thing you need to protect is your wallet seed phrase.
            There is no separate MemoKey backup to manage.
          </p>
        </FaqItem>

        <FaqItem question="Why does my balance show 'pending'?">
          <p>
            Pending means you have incoming encrypted notes that haven&apos;t been claimed
            yet. Your on-chain commitment has already updated — you just haven&apos;t
            decrypted those notes locally.
          </p>
          <p>
            Click <strong>Claim</strong>. One claim processes up to 10 notes at once.
            After claiming, your spendable balance is updated and the pending state clears.
          </p>
        </FaqItem>

        <FaqItem question="Why does a block explorer show I have a shielded balance?">
          <p>
            The on-chain commitment is public — its existence, not its value.
            A block explorer can see that your address has a shielded commitment entry,
            but cannot decode the amount.
          </p>
          <p>
            This is the expected model: <Em>amounts hidden, addresses visible</Em>.
          </p>
        </FaqItem>

        <FaqItem question="Where can I see my incoming notes?">
          <p>
            Go to{" "}
            <Link href="/portfolio" className="text-[#00EF8B] hover:underline">
              /portfolio
            </Link>
            . After claiming, your decrypted notes appear there — amount, memo,
            sender address, and timestamp.
          </p>
          <p>
            Notes are re-derived from your MemoKey on every session.
            No browser storage is required.
          </p>
        </FaqItem>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LearnPage() {
  const [activeTab, setActiveTab] = useState<TabId>("what");
  const reduced = useReducedMotion();

  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((t) => t.id === hash)) setActiveTab(hash);
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
    what:    <TabWhat />,
    how:     <TabHow />,
    privacy: <TabPrivacy />,
    faq:     <TabFaq />,
  };

  return (
    <div className="flex flex-col items-center janus-hex-bg min-h-screen">
      {/* Hero */}
      <motion.div
        {...heroAnim}
        className="w-full max-w-3xl mx-auto px-4 pt-10 pb-6 text-center"
      >
        <div className="flex justify-center mb-4">
          <svg
            width="60"
            height="46"
            viewBox="0 0 80 60"
            fill="none"
            className="drop-shadow-[0_0_10px_rgba(167,139,250,0.4)]"
          >
            <path
              d="M40 50 Q10 50 10 20 Q10 5 25 5"
              stroke="#A78BFA"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M40 50 Q70 50 70 20 Q70 5 55 5"
              stroke="#00EF8B"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
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
          PrivateTip — How it works
        </h1>
        <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-3">
          Private tips on Flow. Amount hidden. Wallet visible. Simple to use.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground mb-4">
          <span className="flex items-center gap-1">
            <BookOpen className="w-3 h-3" /> 5 min
          </span>
          <span>·</span>
          <span>Updated June 2026 (v0.8)</span>
          <span>·</span>
          <Link
            href="/"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            ← Back
          </Link>
        </div>
      </motion.div>

      {/* Sticky tab nav */}
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

      {/* Tab content */}
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

      {/* CTA — Building on Janus? */}
      <motion.section
        initial={reduced ? {} : { opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
        className="w-full max-w-3xl mx-auto px-4 pb-12"
      >
        <div className="relative overflow-hidden rounded-2xl border border-[#A78BFA]/20 bg-gradient-to-br from-[#A78BFA]/8 via-background to-[#00EF8B]/8 px-6 py-8">
          <div
            className="absolute -top-12 -left-12 w-40 h-40 rounded-full bg-[#A78BFA]/12 blur-3xl pointer-events-none"
            aria-hidden
          />
          <div
            className="absolute -bottom-12 -right-12 w-40 h-40 rounded-full bg-[#00EF8B]/12 blur-3xl pointer-events-none"
            aria-hidden
          />
          <div className="relative">
            <p className="text-xs uppercase tracking-widest font-bold text-[#A78BFA] mb-2">
              Protocol docs
            </p>
            <h2
              className="text-xl font-bold mb-2"
              style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
            >
              Building on Janus?
            </h2>
            <p className="text-sm text-muted-foreground mb-5">
              View protocol docs, contracts, and SDK reference →
            </p>
            <a
              href="https://github.com/openjanus/contracts"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#A78BFA]/40 bg-[#A78BFA]/10 text-[#A78BFA] text-sm font-semibold hover:bg-[#A78BFA]/20 transition-colors"
            >
              View on GitHub
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </motion.section>
    </div>
  );
}
