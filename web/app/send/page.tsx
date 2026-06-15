/// Send Shielded Tip page — v0.7 multi-token + EVM-only recipient support.
///
/// v0.7 changes:
///   - Token selector drives the ENTIRE UI (balance, amount label, decimals, errors)
///   - Recipient field accepts BOTH Flow (16 hex) AND EVM (40 hex) addresses
///   - EVM-only recipients: their memokey is queried directly from MemoKeyRegistry
///   - Shielded balance loads per selected token (not always FLOW)

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Gift,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  EyeOff,
  Shield,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { useRouter } from "next/navigation";

import {
  isValidFlowAddress,
  isValidFlowAmount,
  getCoaEvmAddress,
  recipientHasCoa,
  sendTip,
  getShieldedStateForCoa,
  TOKEN_PROXIES,
  EVM_RPC,
  EVM_CHAIN_ID,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  getRecipientMemoPubkey,
  getMemoPubkeyByEvmAddr,
  getOrDeriveMemoPrivkey,
  type Point,
} from "@/lib/tip-actions";
import { TOKEN_REGISTRY, TOKEN_RECIPIENT_TYPES, SHIELDED_CHECKPOINT_ADDRESS, SHIELDED_INBOX_ADDRESS, FLOW_EVM_RPC, FLOW_CADENCE_ACCESS } from "@claucondor/sdk/network";
import { ethers } from "ethers";
import { getPortfolioView } from "@claucondor/sdk";
// loadShieldedState and saveShieldedState removed from @/lib/store in v0.8.
// Phase 4/5/6 will rewrite — Phase 1 left this here intentionally because it
// consumes lib functions whose rewrite happens later.
import { TokenSelector } from "@/components/TokenSelector";
import type { TokenId } from "@/lib/tokens";
import { parseTokenAmount, formatTokenAmount, getTokenMeta } from "@/lib/tokens";
import { ShieldedNoteEncrypt } from "@/components/animations/ShieldedNoteEncrypt";
import { ClaimFirstWarning } from "@/components/ClaimFirstWarning";

const EASE = [0.22, 1, 0.36, 1] as const;

// --- Recipient address helpers ------------------------------------------------

function isFlowAddr(addr: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(addr.trim());
}

function isEvmAddr(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function isValidRecipient(addr: string): boolean {
  return isFlowAddr(addr) || isEvmAddr(addr);
}

// --- Types ------------------------------------------------------------------

/** Shielded balance state read from the on-chain ShieldedCheckpoint. */
interface ShieldedState {
  balanceWei: string;
  blinding: string;
  /** Inbox cursor — last consumed note index (needed for sendTip's inboxCursor param). */
  lastConsumedNoteIndex: string;
}

type SendStatus =
  | "idle"
  | "loading_balance" // reading checkpoint from chain
  | "needs_unlock"    // memoPrivkey not in session — user must sign
  | "needs_wrap"      // no shielded balance for this token yet
  | "validating"
  | "resolving_coa"
  | "building_proof"
  | "submitting"
  | "success"
  | "error";

interface SendState {
  status: SendStatus;
  error: string | null;
  txId: string | null;
}

// --- Component --------------------------------------------------------------

export default function SendTipPage() {
  const router = useRouter();
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const addSentTip = useAppStore((s) => s.addSentTip);

  const [selectedToken, setSelectedToken] = useState<TokenId>("flow");
  const tokenMeta = getTokenMeta(selectedToken);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  // Recipient resolution state
  const [recipientEvmAddr, setRecipientEvmAddr] = useState<string | null>(null);
  const [recipientCoaOk, setRecipientCoaOk] = useState<boolean | null>(null);
  const [recipientCoaChecking, setRecipientCoaChecking] = useState(false);
  const [recipientMemoOk, setRecipientMemoOk] = useState<boolean | null>(null);
  const [resolvedMemoPubkey, setResolvedMemoPubkey] = useState<Point | null>(null);
  const [coaWarningAcknowledged, setCoaWarningAcknowledged] = useState(false);

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [senderCoaEvmAddr, setSenderCoaEvmAddr] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>({
    status: "idle",
    error: null,
    txId: null,
  });

  const [showEncryptAnim, setShowEncryptAnim] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Derive the allowed recipient address types for the selected token.
  // mockft → Cadence only; mockusdc → EVM only; flow → both.
  const allowedRecipientTypes = TOKEN_RECIPIENT_TYPES[selectedToken as keyof typeof TOKEN_RECIPIENT_TYPES] as ReadonlyArray<"cadence" | "evm">;

  // Validate whether the current recipient input is allowed for this token.
  const recipientTypeOk = (() => {
    if (!recipient) return true;
    if (allowedRecipientTypes.includes("cadence" as never) && allowedRecipientTypes.includes("evm" as never)) return isValidRecipient(recipient);
    if (allowedRecipientTypes.includes("evm" as never)) return isEvmAddr(recipient);
    if (allowedRecipientTypes.includes("cadence" as never)) return isFlowAddr(recipient);
    return false;
  })();

  // Human-readable label + placeholder for the recipient field.
  const recipientFieldLabel = (() => {
    if (allowedRecipientTypes.length === 2) return "Recipient Cadence or EVM address";
    if (allowedRecipientTypes[0] === "evm") return "Recipient EVM address (0x…40 hex)";
    return "Recipient Cadence address (0x…16 hex)";
  })();

  const recipientFieldPlaceholder = (() => {
    if (allowedRecipientTypes.length === 2) return "0x... (16-hex Cadence or 40-hex EVM)";
    if (allowedRecipientTypes[0] === "evm") return "0x... (40-hex EVM address)";
    return "0x... (16-hex Cadence address)";
  })();

  // Debounced recipient check — handles both Flow and EVM addresses
  useEffect(() => {
    setCoaWarningAcknowledged(false);
    setRecipientEvmAddr(null);

    if (!isValidRecipient(recipient)) {
      setRecipientCoaOk(null);
      setRecipientMemoOk(null);
      setResolvedMemoPubkey(null);
      return;
    }

    let cancelled = false;
    setRecipientCoaChecking(true);

    const t = setTimeout(async () => {
      try {
        if (isEvmAddr(recipient)) {
          // EVM-only recipient: no COA lookup needed, query registry directly
          const memoPub = await getMemoPubkeyByEvmAddr(recipient.trim(), selectedToken === "mockft" ? "flow" : selectedToken);
          if (!cancelled) {
            setRecipientEvmAddr(recipient.trim());
            setRecipientCoaOk(true); // EVM addr IS the final addr, no COA needed
            setRecipientMemoOk(memoPub !== null);
            setResolvedMemoPubkey(memoPub);
          }
        } else {
          // Cadence address: check COA + memokey
          // For mockft: COA is needed only for memokey lookup, NOT for the tx address.
          const [coaOk, memoPub] = await Promise.all([
            recipientHasCoa(recipient),
            getRecipientMemoPubkey(recipient, selectedToken === "mockft" ? "flow" : selectedToken),
          ]);
          // Resolve COA EVM address for display and memokey lookup — never used as tx recipient for mockft.
          let resolvedCoa: string | null = null;
          if (coaOk) {
            try {
              resolvedCoa = await getCoaEvmAddress(recipient);
            } catch { /* non-fatal */ }
          }
          if (!cancelled) {
            setRecipientEvmAddr(resolvedCoa);
            setRecipientCoaOk(coaOk);
            setRecipientMemoOk(memoPub !== null);
            setResolvedMemoPubkey(memoPub);
          }
        }
      } catch {
        if (!cancelled) {
          setRecipientCoaOk(false);
          setRecipientMemoOk(false);
          setResolvedMemoPubkey(null);
        }
      } finally {
        if (!cancelled) setRecipientCoaChecking(false);
      }
    }, 400);

    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient, selectedToken]);

  useEffect(() => {
    if (recipientMemoOk === false && memo.length > 0) setMemo("");
  }, [recipientMemoOk, memo]);

  // Resolve COA + load shielded balance from on-chain checkpoint on mount + token change.
  // Requires memoPrivkey in session. If not cached, transitions to "needs_unlock".
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;

    (async () => {
      setSendState({ status: "loading_balance", error: null, txId: null });
      setShielded(null);
      try {
        // Resolve COA EVM address
        const coa = await getCoaEvmAddress(userAddress);
        if (cancelled) return;
        setSenderCoaEvmAddr(coa);

        // Check for cached memoPrivkey — don't prompt wallet on mount
        const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
        const cachedPrivkey = getCachedMemoPrivkey(userAddress);
        if (cachedPrivkey === null) {
          if (!cancelled) setSendState({ status: "needs_unlock", error: null, txId: null });
          return;
        }

        // Derive per-token proxy address
        const entry = TOKEN_REGISTRY[selectedToken];
        // cadence-ft (MockFT) has no EVM checkpoint — getShieldedStateForCoa will return null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tokenProxy = entry.variant === "cadence-ft"
          ? TOKEN_PROXIES[selectedToken as keyof typeof TOKEN_PROXIES]
          : (entry as any).proxy as string;

        // Read checkpoint (null = no shielded state yet for this token)
        const state = await getShieldedStateForCoa(coa, cachedPrivkey, tokenProxy).catch(() => null);
        if (cancelled) return;

        if (!state) {
          setShielded(null);
          setSendState({ status: "needs_wrap", error: null, txId: null });
        } else {
          setShielded({
            balanceWei: state.balance.toString(),
            blinding: state.blinding.toString(),
            lastConsumedNoteIndex: state.lastConsumedNoteIndex.toString(),
          });
          setSendState((prev) =>
            prev.status === "loading_balance" || prev.status === "needs_wrap"
              ? { status: "idle", error: null, txId: null }
              : prev
          );
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load balance";
          setSendState({ status: "needs_wrap", error: msg, txId: null });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [userAddress, selectedToken]);

  // Handle "Unlock" — derive memoPrivkey via wallet sign, then retry balance load
  const handleUnlock = useCallback(async () => {
    if (!userAddress) return;
    setSendState({ status: "loading_balance", error: null, txId: null });
    try {
      await getOrDeriveMemoPrivkey(userAddress);
      // Trigger balance reload: re-set selectedToken to force effect re-run
      // (useEffect dependency on selectedToken doesn't re-run without a change)
      // We can force it by calling the logic directly
      if (!senderCoaEvmAddr) return;
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const privkey = getCachedMemoPrivkey(userAddress);
      if (!privkey) return;
      const entry = TOKEN_REGISTRY[selectedToken];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenProxy = entry.variant === "cadence-ft"
        ? TOKEN_PROXIES[selectedToken as keyof typeof TOKEN_PROXIES]
        : (entry as any).proxy as string;
      const state = await getShieldedStateForCoa(senderCoaEvmAddr, privkey, tokenProxy).catch(() => null);
      if (!state) {
        setShielded(null);
        setSendState({ status: "needs_wrap", error: null, txId: null });
      } else {
        setShielded({
          balanceWei: state.balance.toString(),
          blinding: state.blinding.toString(),
          lastConsumedNoteIndex: state.lastConsumedNoteIndex.toString(),
        });
        setSendState({ status: "idle", error: null, txId: null });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unlock failed";
      setSendState({ status: "error", error: msg, txId: null });
    }
  }, [userAddress, senderCoaEvmAddr, selectedToken]);

  // Fetch pending inbox count for claim-first warning.
  // Fires once senderCoaEvmAddr is resolved and again on every token switch.
  useEffect(() => {
    if (!userAddress || !senderCoaEvmAddr) return;
    let cancelled = false;
    (async () => {
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const memoPrivkey = getCachedMemoPrivkey(userAddress);
      if (!memoPrivkey) { setPendingCount(0); return; }
      try {
        const entry = TOKEN_REGISTRY[selectedToken];
        const tokenList = [{
          id: selectedToken,
          address: TOKEN_PROXIES[selectedToken as keyof typeof TOKEN_PROXIES],
          janusTokenAddr: entry.variant !== "cadence-ft" ? (entry as any).proxy as string : undefined,
        }];
        const view = await getPortfolioView(senderCoaEvmAddr, {
          rpc: FLOW_EVM_RPC,
          checkpointAddr: SHIELDED_CHECKPOINT_ADDRESS,
          inboxAddr: SHIELDED_INBOX_ADDRESS,
          tokens: tokenList,
          memoPrivkey,
          cadenceAddress: userAddress,
          flowAccessNode: FLOW_CADENCE_ACCESS,
        });
        if (!cancelled) setPendingCount(view.tokens[selectedToken]?.pendingCount ?? 0);
      } catch {
        if (!cancelled) setPendingCount(0);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, senderCoaEvmAddr, selectedToken]);

  // Insufficient balance check
  const insufficientReason: string | null = (() => {
    if (!shielded || !amount || !isValidFlowAmount(amount)) return null;
    try {
      const amountWei = parseTokenAmount(amount, selectedToken);
      const balanceWei = BigInt(shielded.balanceWei);
      if (amountWei > balanceWei) {
        return `Insufficient shielded balance: have ${formatTokenAmount(balanceWei, selectedToken, 4)} ${tokenMeta.symbol}, need ${amount}.`;
      }
    } catch { /* invalid amount */ }
    return null;
  })();

  const handleSendTip = useCallback(async () => {
    if (!userAddress) {
      toast.error("Wallet not connected.");
      return;
    }

    setShowEncryptAnim(true);
    setSendState({ status: "validating", error: null, txId: null });

    // Validate recipient
    const recipientTrimmed = recipient.trim();
    if (!isFlowAddr(recipientTrimmed) && !isEvmAddr(recipientTrimmed)) {
      setSendState({
        status: "error",
        error: "Invalid recipient — expected Flow address (0x + 16 hex) or EVM address (0x + 40 hex).",
        txId: null,
      });
      setShowEncryptAnim(false);
      return;
    }

    if (!isValidFlowAmount(amount)) {
      setSendState({ status: "error", error: "Invalid amount.", txId: null });
      setShowEncryptAnim(false);
      return;
    }

    // Self-send check
    if (isFlowAddr(recipientTrimmed) && recipientTrimmed.toLowerCase() === userAddress.toLowerCase()) {
      setSendState({ status: "error", error: "Cannot send a shielded tip to yourself.", txId: null });
      setShowEncryptAnim(false);
      return;
    }

    const amountWei = parseTokenAmount(amount, selectedToken);

    // Token-aware type guard — reject mismatched address types before any network call.
    if (selectedToken === "mockusdc" && !isEvmAddr(recipientTrimmed)) {
      setSendState({
        status: "error",
        error: "mUSDC tips require an EVM address (0x + 40 hex chars). You entered a Cadence address.",
        txId: null,
      });
      setShowEncryptAnim(false);
      return;
    }
    if (selectedToken === "mockft" && !isFlowAddr(recipientTrimmed)) {
      setSendState({
        status: "error",
        error: "MockFT tips require a Cadence address (0x + 16 hex chars). You entered an EVM address.",
        txId: null,
      });
      setShowEncryptAnim(false);
      return;
    }

    // COA warning for Cadence addresses without COA (only relevant for FLOW/EVM tokens).
    // mockft uses Cadence address directly — COA presence is needed only for memokey lookup.
    if (isFlowAddr(recipientTrimmed) && selectedToken !== "mockft") {
      let coaOk = recipientCoaOk;
      if (coaOk === null) {
        coaOk = await recipientHasCoa(recipientTrimmed);
        setRecipientCoaOk(coaOk);
      }
      if (!coaOk && !coaWarningAcknowledged) {
        setSendState({
          status: "error",
          error: "Recipient has no COA at /public/evm. They cannot unwrap this tip until they set one up. Acknowledge the warning below to proceed anyway.",
          txId: null,
        });
        setShowEncryptAnim(false);
        return;
      }
    }

    setSendState({ status: "resolving_coa", error: null, txId: null });

    // Resolve final recipient address:
    //   mockft   → Cadence address (used directly by JanusFT.shieldedTransfer)
    //   flow     → EVM COA (Cadence input resolved; EVM input used as-is)
    //   mockusdc → EVM address (always)
    let finalRecipientAddr: string;
    if (selectedToken === "mockft") {
      // For mockft, the transaction recipient IS the Cadence address.
      finalRecipientAddr = recipientTrimmed;
    } else if (isEvmAddr(recipientTrimmed)) {
      finalRecipientAddr = recipientTrimmed;
    } else {
      // FLOW with Cadence address input → resolve EVM COA
      try {
        finalRecipientAddr = await getCoaEvmAddress(recipientTrimmed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "COA resolution failed";
        setSendState({ status: "error", error: msg, txId: null });
        setShowEncryptAnim(false);
        return;
      }
    }

    // For memokey lookup we always need the EVM COA, regardless of token type.
    // For mockft with Cadence input, resolve COA separately for the memokey query.
    let evmAddrForMemoKey: string = finalRecipientAddr;
    if (selectedToken === "mockft" && isFlowAddr(recipientTrimmed)) {
      try {
        evmAddrForMemoKey = recipientEvmAddr ?? await getCoaEvmAddress(recipientTrimmed);
      } catch {
        // If COA lookup fails for mockft, the memokey check below will catch it.
        evmAddrForMemoKey = finalRecipientAddr;
      }
    }

    // MemoKey check — use already-resolved key or re-fetch.
    let recipientMemoPubkey = resolvedMemoPubkey;
    if (!recipientMemoPubkey) {
      const memoTokenId = selectedToken === "mockft" ? "flow" : selectedToken;
      if (isEvmAddr(recipientTrimmed) || selectedToken === "mockft") {
        recipientMemoPubkey = await getMemoPubkeyByEvmAddr(evmAddrForMemoKey, memoTokenId);
      } else {
        recipientMemoPubkey = await getRecipientMemoPubkey(recipientTrimmed, memoTokenId);
      }
    }

    if (!recipientMemoPubkey) {
      setSendState({
        status: "error",
        error: "Recipient hasn't activated their MemoKey — they need to /status first OR publish via MemoKeyRegistry.",
        txId: null,
      });
      setShowEncryptAnim(false);
      return;
    }

    setSendState({ status: "building_proof", error: null, txId: null });

    try {
      setSendState({ status: "submitting", error: null, txId: null });

      // Derive memoPrivkey (wallet sign if not cached)
      const privkey = await getOrDeriveMemoPrivkey(userAddress);
      const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
      const pubkey = await pubkeyFromPrivkey(privkey);
      const memoKeypair = { privkey, pubkey };

      // Resolve sender COA (use cached state or re-resolve)
      const coaAddr = senderCoaEvmAddr ?? (await getCoaEvmAddress(userAddress));
      if (!senderCoaEvmAddr) setSenderCoaEvmAddr(coaAddr);

      // Read current shielded state from checkpoint (re-read to get fresh cursor)
      const entry = TOKEN_REGISTRY[selectedToken];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenProxy = entry.variant === "cadence-ft"
        ? TOKEN_PROXIES[selectedToken as keyof typeof TOKEN_PROXIES]
        : (entry as any).proxy as string;
      const freshState = await getShieldedStateForCoa(coaAddr, privkey, tokenProxy).catch(() => null);

      // Determine current balance and blinding: prefer fresh checkpoint, fall back to local state
      const currentBalance = freshState ? freshState.balance : (shielded ? BigInt(shielded.balanceWei) : 0n);
      const currentBlinding = freshState ? freshState.blinding : (shielded ? BigInt(shielded.blinding) : 0n);
      const inboxCursor = freshState ? freshState.lastConsumedNoteIndex
        : (shielded ? BigInt(shielded.lastConsumedNoteIndex) : 0n);

      if (amountWei > currentBalance) {
        setSendState({
          status: "error",
          error: `Insufficient shielded balance: have ${formatTokenAmount(currentBalance, selectedToken, 4)} ${tokenMeta.symbol}, need ${amount}.`,
          txId: null,
        });
        setShowEncryptAnim(false);
        return;
      }

      // VoidSigner for non-native paths (evmSigner needed by sendTip signature but only
      // used in cadence-ft shieldedTransfer; native + erc20 paths use FCL/COA internally).
      const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
      const evmSigner = new ethers.VoidSigner(coaAddr, provider) as unknown as import("ethers").Wallet;

      const result = await sendTip({
        tokenId: selectedToken,
        recipientAddr: finalRecipientAddr,
        amount: amountWei,
        memo: memo || undefined,
        coaEvmAddr: coaAddr,
        memoKeypair,
        userCadenceAddr: userAddress,
        currentBalance,
        currentBlinding,
        evmSigner,
        inboxCursor,
      });

      // Update local shielded state with new residual balance
      const newBalance = currentBalance - amountWei;
      setShielded({
        balanceWei: newBalance.toString(),
        blinding: "0", // blinding refreshed by sendTip on-chain; local value approximated
        lastConsumedNoteIndex: inboxCursor.toString(),
      });

      addSentTip({
        tipID: Date.now(),
        sender: userAddress,
        recipient: recipientTrimmed,
        timestamp: new Date().toISOString(),
        memo: memo || null,
        claimed: false,
      });

      setSendState({ status: "success", error: null, txId: result.txHash });
      toast.success("Shielded tip sent!", { description: `${tokenMeta.symbol} amount hidden on-chain.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      setShowEncryptAnim(false);
      setSendState({ status: "error", error: msg, txId: null });
      toast.error("Send failed", { description: msg });
    }
  }, [userAddress, shielded, senderCoaEvmAddr, recipient, amount, memo, addSentTip, recipientCoaOk, coaWarningAcknowledged, resolvedMemoPubkey, selectedToken, tokenMeta]);

  const isSubmitting =
    sendState.status === "loading_balance" ||
    sendState.status === "validating" ||
    sendState.status === "resolving_coa" ||
    sendState.status === "building_proof" ||
    sendState.status === "submitting";

  // Unauthenticated
  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#00EF8B]/12 border border-[#00EF8B]/25 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_12%,transparent)]">
            <Gift className="w-8 h-8 text-[#00EF8B]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">Connect your wallet to send shielded tips.</p>
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

  // Loading balance screen
  if (sendState.status === "loading_balance") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex items-center justify-center gap-3 py-16">
          <Loader2 className="w-5 h-5 animate-spin text-foreground/40" />
          <p className="text-sm text-foreground/50">Loading {tokenMeta.symbol} shielded balance…</p>
        </div>
      </div>
    );
  }

  // Needs unlock screen (memoPrivkey not in session)
  if (sendState.status === "needs_unlock") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-[#D4AF37]/12 border border-[#D4AF37]/30 flex items-center justify-center">
            <Shield className="w-5 h-5 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Unlock your private inbox</h1>
            <p className="text-sm text-foreground/50">One wallet signature re-derives your session key.</p>
          </div>
        </div>
        <div className="rounded-xl border border-[#D4AF37]/20 bg-[#D4AF37]/5 p-6 space-y-4">
          <p className="text-sm text-amber-200/80">
            Your shielded balance is encrypted to your wallet-derived MemoKey. Sign once to read it — the key stays in session memory and clears when you close the tab.
          </p>
          <motion.button
            onClick={handleUnlock}
            whileHover={{ scale: 1.01, y: -1 }}
            whileTap={{ scale: 0.99 }}
            className="janus-button-primary w-full py-3 rounded-xl text-sm"
          >
            Unlock (1 wallet signature)
          </motion.button>
        </div>
      </div>
    );
  }

  // Needs wrap screen
  if (sendState.status === "needs_wrap") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-[#B45309]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Wrap First</h1>
            <p className="text-sm text-foreground/50">PrivateTip requires a pre-funded shielded slot.</p>
          </div>
        </div>

        <div className="rounded-xl border border-[#B45309]/20 bg-[#B45309]/5 p-6 space-y-4">
          <p className="text-sm text-amber-200/80">
            <strong className="text-amber-200">Pre-condition:</strong> PrivateTip requires a pre-funded shielded slot for <strong className="text-amber-200">{tokenMeta.symbol}</strong>. Wrap some {tokenMeta.symbol} first.
          </p>
          <p className="text-xs text-amber-200/50">
            The wrap is a one-time visible deposit. Subsequent tips draw down your shielded balance with amounts hidden by Pedersen commitments.
          </p>
          <Link href={`/wrap?token=${selectedToken}`}>
            <motion.span
              whileHover={{ scale: 1.01, y: -1 }}
              whileTap={{ scale: 0.99 }}
              className="janus-button-primary w-full py-3 rounded-xl text-sm flex items-center justify-center cursor-pointer mt-2"
            >
              Wrap {tokenMeta.symbol}
            </motion.span>
          </Link>
          <div className="border-t border-white/8 pt-4">
            <p className="text-xs text-foreground/30 mb-2">MVP shortcut: paste your current shielded state</p>
            <PasteShieldedStateForm
              addr={userAddress!}
              tokenId={selectedToken}
              onSaved={(s) => {
                setShielded({ ...s, lastConsumedNoteIndex: "0" });
                setSendState({ status: "idle", error: null, txId: null });
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12 janus-page">
      <div className="mb-8">
        <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />Back
        </Link>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="flex items-center gap-3 mb-8"
      >
        <div className="w-10 h-10 rounded-lg bg-[#6B46C1]/12 border border-[#6B46C1]/25 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#6B46C1_10%,transparent)]">
          <Gift className="w-5 h-5 text-[#6B46C1]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Send a private tip</h1>
          <p className="text-sm text-foreground/50">The amount is hidden. People can see who sent it — not how much.</p>
        </div>
      </motion.div>

      {/* Shielded balance */}
      {shielded && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE, delay: 0.05 }}
          className="mb-6 rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/5 p-4"
        >
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-[#00EF8B] shrink-0 mt-0.5" />
            <div className="text-xs flex-1">
              <p className="font-medium text-foreground/70 mb-1">Your shielded {tokenMeta.symbol} balance (from on-chain checkpoint)</p>
              <p className="text-sm text-[#00EF8B] font-mono">
                {formatTokenAmount(BigInt(shielded.balanceWei), selectedToken, 4)} {tokenMeta.symbol}
              </p>
              <p className="text-[10px] text-foreground/30 mt-1">
                Decrypted from ShieldedCheckpoint — on-chain only a Pedersen commit point is visible.
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Pre-send encryption animation */}
      <ShieldedNoteEncrypt
        trigger={showEncryptAnim && sendState.status !== "success"}
        success={false}
        onDismiss={() => setShowEncryptAnim(false)}
      />

      {/* Claim-first warning — shown when pending inbox notes exist for selected token */}
      <ClaimFirstWarning pendingCount={pendingCount} tokenSymbol={tokenMeta.symbol} variant="send" />

      {/* Form */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.08 }}
        className="rounded-xl border border-[#6B46C1]/20 janus-purple-glow bg-[#0D1E38]/80 p-6 space-y-4"
      >
        {/* Token selector */}
        <TokenSelector
          value={selectedToken}
          onChange={(id) => {
            setSelectedToken(id);
          }}
          disabled={isSubmitting || sendState.status === "success"}
          label="Token to send"
        />

        {/* Recipient field */}
        <div>
          <label className="text-xs font-medium text-foreground/50 mb-1 block">{recipientFieldLabel}</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={recipientFieldPlaceholder}
            className="janus-input font-mono"
            disabled={isSubmitting || sendState.status === "success"}
          />
          {/* Token-specific address type hint */}
          {selectedToken === "mockft" && (
            <p className="text-[10px] text-foreground/30 mt-1">
              MockFT tips go directly to a Cadence FT vault. Enter a Cadence address (16 hex). EVM addresses are not supported for this token.
            </p>
          )}
          {selectedToken === "mockusdc" && (
            <p className="text-[10px] text-foreground/30 mt-1">
              mUSDC is an ERC20 token — enter a 40-char EVM address. Cadence addresses are not supported for this token.
            </p>
          )}
          {selectedToken === "flow" && (
            <p className="text-[10px] text-foreground/30 mt-1">
              Cadence wallets use Flow addresses (16 hex). MetaMask/EVM-only wallets use full 40-char EVM addresses. Both work if the recipient has activated MemoKey.
            </p>
          )}
          {/* Address type mismatch error */}
          {recipient && !recipientTypeOk && (
            <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-2 mt-1">
              <p className="text-[10px] text-red-400/80">
                {selectedToken === "mockusdc" && isFlowAddr(recipient)
                  ? "mUSDC tips require an EVM address. You entered a Cadence address."
                  : selectedToken === "mockft" && isEvmAddr(recipient)
                  ? "MockFT tips require a Cadence address. You entered an EVM address."
                  : "Invalid address format for this token."}
              </p>
            </div>
          )}

          {/* Address type + validation feedback */}
          {isValidRecipient(recipient) && (
            <div className="mt-2">
              {recipientCoaChecking && (
                <p className="text-[10px] text-foreground/40">Checking recipient…</p>
              )}

              {/* EVM-only recipient: no COA needed */}
              {!recipientCoaChecking && isEvmAddr(recipient) && recipientMemoOk === true && (
                <p className="text-[10px] text-[#00EF8B]">✓ EVM-only recipient — MemoKey found. Ready to receive.</p>
              )}
              {!recipientCoaChecking && isEvmAddr(recipient) && recipientMemoOk === false && (
                <div className="rounded-lg border border-[#B45309]/30 bg-[#B45309]/8 p-2 mt-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-[10px] text-amber-200/70">
                      This EVM address has no MemoKey published. They need to publish via MemoKeyRegistry first.
                    </p>
                  </div>
                </div>
              )}

              {/* Flow address recipient */}
              {!recipientCoaChecking && isFlowAddr(recipient) && recipientCoaOk === true && recipientMemoOk === true && (
                <p className="text-[10px] text-[#00EF8B]">✓ Recipient is ready to claim tips.</p>
              )}
              {!recipientCoaChecking && isFlowAddr(recipient) && recipientCoaOk === false && (
                <div className="rounded-lg border border-[#B45309]/30 bg-[#B45309]/8 p-2 mt-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-amber-200/70 space-y-1">
                      <p className="font-medium text-amber-200">Recipient hasn&apos;t opened the app yet.</p>
                      <p>They&apos;ll need to connect, click &quot;Enable&quot; and set up before they can claim. The {tokenMeta.symbol} waits privately for them.</p>
                      <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={coaWarningAcknowledged}
                          onChange={(e) => setCoaWarningAcknowledged(e.target.checked)}
                          className="h-3 w-3"
                        />
                        <span>Send anyway — I understand the risk.</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
              {!recipientCoaChecking && isFlowAddr(recipient) && recipientCoaOk === true && recipientMemoOk === false && (
                <InviteRecipientCard recipient={recipient} />
              )}
            </div>
          )}
        </div>

        {/* Amount input */}
        <div>
          <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount ({tokenMeta.symbol})</label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`e.g. 1.5 ${tokenMeta.symbol}`}
            className="janus-input"
            disabled={isSubmitting || sendState.status === "success"}
          />
          {insufficientReason ? (
            <p className="text-[10px] text-red-400/80 mt-1">{insufficientReason}</p>
          ) : (
            <p className="text-[10px] text-foreground/30 mt-1">
              Amount HIDDEN on-chain. Recipient sees only their aggregated balance — never per-sender amounts.
            </p>
          )}
        </div>

        {/* Memo */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-foreground/50 block">Memo (optional, max 280 chars)</label>
            <span className="text-[10px] font-mono text-foreground/40">{memo.length}/280</span>
          </div>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={recipientMemoOk === false ? "Disabled — recipient has no MemoKey" : "Thanks for the tip!"}
            maxLength={280}
            className="janus-input disabled:opacity-40"
            disabled={isSubmitting || sendState.status === "success" || recipientMemoOk === false}
          />
          {recipientMemoOk === true && (
            <p className="text-[10px] text-[#00EF8B] mt-1">✓ Your memo + amount get encrypted just for the recipient.</p>
          )}
          {recipientMemoOk === false && !isEvmAddr(recipient) && (
            <InviteRecipientCard recipient={recipient} />
          )}
          {recipientMemoOk === null && (
            <p className="text-[10px] text-foreground/30 mt-1">Every tip carries an encrypted note — recipient needs it to read the memo and claim the funds.</p>
          )}
        </div>

        <motion.button
          onClick={handleSendTip}
          disabled={isSubmitting || sendState.status === "success" || !shielded || recipientMemoOk === false || !!insufficientReason || !recipientTypeOk || pendingCount > 0}
          whileHover={!isSubmitting && !!shielded && recipientMemoOk !== false && !insufficientReason ? { scale: 1.01, y: -1 } : {}}
          whileTap={{ scale: 0.99 }}
          className="janus-button-primary w-full py-3 rounded-xl text-base disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: !isSubmitting ? undefined : "#00EF8B" }}
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {sendState.status === "validating" && "Validating…"}
              {sendState.status === "resolving_coa" && "Resolving recipient address…"}
              {sendState.status === "building_proof" && "Generating Groth16 proof…"}
              {sendState.status === "submitting" && "Submitting…"}
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Shield className="w-4 h-4" />
              Send Shielded {tokenMeta.symbol} Tip
            </span>
          )}
        </motion.button>
      </motion.div>

      {/* Success */}
      {sendState.status === "success" && sendState.txId && (
        <>
          <ShieldedNoteEncrypt trigger={true} success={true} onDismiss={() => {}} />
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="mt-6 rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/8 p-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_8%,transparent)]"
          >
            <div className="flex items-start gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
              <div>
                <h3 className="text-lg font-bold mb-1 text-foreground">Shielded {tokenMeta.symbol} tip sent!</h3>
                <p className="text-xs text-foreground/50">Amount HIDDEN on calldata, events, and storage. Pedersen commitment updated on-chain.</p>
              </div>
            </div>
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground/60 mb-1">Token sent:</p>
              <p className="font-mono text-xs text-[#00EF8B]">{tokenMeta.symbol}</p>
            </div>
            <div className="mb-3">
              <p className="text-xs font-medium text-foreground/60 mb-1">Transaction (Cadence tx ID / EVM hash):</p>
              <p className="font-mono text-[10px] break-all text-foreground/40">{sendState.txId}</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-foreground/40 mb-4">
              <EyeOff className="w-3 h-3" />
              Amount cryptographically hidden via Pedersen commitment
            </div>
            <div className="flex gap-3 justify-center">
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => router.push("/tips")}
                className="px-4 py-2 rounded-lg border border-white/12 bg-white/5 text-foreground/70 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                View My Tips
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setSendState({ status: "idle", error: null, txId: null });
                  setRecipient(""); setAmount(""); setMemo("");
                  setShowEncryptAnim(false);
                }}
                className="janus-button-primary px-4 py-2 rounded-lg text-sm"
              >
                Send Another
              </motion.button>
            </div>
          </motion.div>
        </>
      )}

      {/* Error */}
      {sendState.status === "error" && sendState.error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-lg border border-red-500/20 bg-red-950/20 p-4"
        >
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300 mb-1">Send failed</p>
              <p className="text-xs text-red-400/70">{sendState.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Footer */}
      <div className="mt-8 text-[10px] text-foreground/20 space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono break-all">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono break-all">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

// --- Paste-shielded-state form -----------------------------------------------

function PasteShieldedStateForm({
  addr,
  tokenId,
  onSaved,
}: {
  addr: string;
  tokenId: TokenId;
  onSaved: (s: ShieldedState) => void;
}) {
  const tokenMeta = getTokenMeta(tokenId);
  const [balanceAmount, setBalanceAmount] = useState("");
  const [blinding, setBlinding] = useState("");

  const handleSave = () => {
    try {
      const balanceWei = parseTokenAmount(balanceAmount, tokenId).toString();
      const blindingDec = BigInt(blinding.trim()).toString();
      // lastConsumedNoteIndex defaults to 0 when pasting state manually
      const s: ShieldedState = { balanceWei, blinding: blindingDec, lastConsumedNoteIndex: "0" };
      onSaved(s);
      toast.success("Shielded state saved (session only)");
    } catch (err) {
      toast.error("Invalid input", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder={`Cleartext balance (${tokenMeta.symbol})`}
        value={balanceAmount}
        onChange={(e) => setBalanceAmount(e.target.value)}
        className="janus-input font-mono text-xs"
      />
      <input
        type="text"
        placeholder="Blinding factor (decimal)"
        value={blinding}
        onChange={(e) => setBlinding(e.target.value)}
        className="janus-input font-mono text-xs"
      />
      <motion.button
        onClick={handleSave}
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        className="w-full px-3 py-2 text-sm rounded-lg border border-white/15 bg-white/5 text-foreground/60 hover:text-foreground/80 hover:bg-white/8 transition-colors"
      >
        Save (session only)
      </motion.button>
    </div>
  );
}

// ─── Invite-recipient share card (shown when recipient has no MemoKey) ────────

function InviteRecipientCard({ recipient }: { recipient: string }) {
  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://privatetip.condordev.xyz";
  const inviteUrl = `${baseUrl}/wrap`;
  const msg = `Hey — I want to send you a private tip on PrivateTip (consent-required privacy on Flow). Activate your private wallet in 1 tx: ${inviteUrl}`;

  const copyMsg = () => {
    navigator.clipboard.writeText(msg);
    toast.success("Invite message copied", {
      description: "Paste it to the recipient to unblock the tip.",
    });
  };

  const encodedMsg = encodeURIComponent(msg);
  const encodedUrl = encodeURIComponent(inviteUrl);

  const shareLinks = [
    {
      label: "Twitter",
      href: `https://twitter.com/intent/tweet?text=${encodedMsg}`,
    },
    {
      label: "Telegram",
      href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedMsg}`,
    },
    { label: "WhatsApp", href: `https://wa.me/?text=${encodedMsg}` },
    {
      label: "Email",
      href: `mailto:?subject=Private%20tip%20invitation&body=${encodedMsg}`,
    },
  ];

  return (
    <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/10 p-3 text-xs space-y-2">
      <p className="text-amber-300/90 leading-relaxed">
        <strong>Recipient hasn&apos;t activated their private inbox.</strong>{" "}
        This is{" "}
        <span className="text-amber-200">consent-required privacy</span> by
        design — invite them to set up first.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={copyMsg}
          type="button"
          className="px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 transition-colors text-[10px]"
        >
          Copy invite
        </button>
        {shareLinks.map((s) => (
          <a
            key={s.label}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-1 rounded border border-white/15 bg-white/5 text-foreground/70 hover:bg-white/10 transition-colors text-[10px]"
          >
            {s.label}
          </a>
        ))}
        {isFlowAddr(recipient) && (
          <Link
            href={`/status?addr=${encodeURIComponent(recipient)}`}
            className="px-2 py-1 rounded border border-[#D4AF37]/30 bg-[#D4AF37]/5 text-[#D4AF37] hover:bg-[#D4AF37]/15 transition-colors text-[10px]"
          >
            Recheck status →
          </Link>
        )}
      </div>
    </div>
  );
}
