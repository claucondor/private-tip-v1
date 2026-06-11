/// Wrap page — v0.6.5 multi-token.
///
/// The token selector drives the ENTIRE UI:
///   - FLOW (native):     Vault/COA source picker shown; decimals=18
///   - mUSDC (erc20):     Source picker hidden; COA-only; decimals=6
///   - MockFT (cadence-ft): Source picker hidden; vault-only; decimals=8
///
/// Boundary semantics:
///   - wrap()              : msg.value VISIBLE | commitment opaque   (boundary in)
///   - shieldedTransfer()  : amount HIDDEN on calldata/events/storage (full shielded)
///   - unwrap()            : claimedAmount + recipient VISIBLE        (boundary out)

"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Loader2,
  CheckCircle,
  XCircle,
  Shield,
  Coins,
  EyeOff,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import {
  getCoaEvmAddress,
  getCommitment,
  getCoaBalanceWei,
  getFlowVaultBalanceWei,
  wrapToken,
  getShieldedStateForCoa,
  isValidFlowAmount,
  formatPoint,
  isIdentityPoint,
  getRecipientMemoPubkey,
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  fetchFeeBps,
  computeNetWrapAmount as computeNetWrap,
  computeWrapFeeAmount as computeWrapFee,
  getOrDeriveMemoPrivkey,
  type Point,
} from "@/lib/tip-actions";
import { FLOWSCAN_CADENCE_TX } from "@/lib/explorer";
// loadShieldedState and saveShieldedState removed from @/lib/store in v0.8.
// Phase 4/5/6 will rewrite — Phase 1 left this here intentionally because it
// consumes lib functions whose rewrite happens later.
import { TokenSelector } from "@/components/TokenSelector";
import type { TokenId } from "@/lib/tokens";
import { parseTokenAmount, formatTokenAmount, getTokenMeta } from "@/lib/tokens";
import { TOKEN_REGISTRY } from "@claucondor/sdk/network";

// WrapSource type shim for v0.6 (EVM-direct, no vault/coa split needed).
type WrapSource = "vault" | "coa";
import { PedersenCommitFormation } from "@/components/animations/PedersenCommitFormation";

const EASE = [0.22, 1, 0.36, 1] as const;

// --- Local-storage helpers (Phase 1 stubs) ------------------------------------
// Phase 4/5/6 will rewrite these using ShieldedCheckpointClient.readAndDecrypt()
// and cadenceTx.updateCheckpointViaCoa(). localStorage-backed state removed in v0.8.

interface ShieldedState {
  balanceWei: string;
  blinding: string;
}

function loadShieldedState(_addr: string, _tokenId: TokenId = "flow"): ShieldedState | null {
  return null;
}

function saveShieldedState(_addr: string, _state: ShieldedState, _tokenId: TokenId = "flow"): void {
  // no-op in Phase 1
}

// --- Status types ------------------------------------------------------------

type WrapStatus =
  | "loading"
  | "idle"
  | "validating"
  | "building_proof"
  | "submitting"
  | "success"
  | "error";

interface WrapState {
  status: WrapStatus;
  error: string | null;
  txId: string | null;
  checkpointTxId: string | null;
  wrappedAmount: string | null;
  newCommit: Point | null;
}

// --- Component ---------------------------------------------------------------

function WrapPageInner() {
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  // v0.6: token selector (reads ?token= URL param on mount).
  const searchParams = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "flow") as TokenId;
  const [selectedToken, setSelectedToken] = useState<TokenId>(initialToken);

  const [shielded, setShielded] = useState<ShieldedState | null>(null);
  const [coaHex, setCoaHex] = useState<string | null>(null);
  const [chainCommit, setChainCommit] = useState<Point | null>(null);
  // FLOW: both vault and COA balances
  const [vaultBalanceWei, setVaultBalanceWei] = useState<bigint>(BigInt(0));
  const [coaBalanceWei, setCoaBalanceWei] = useState<bigint>(BigInt(0));
  // mUSDC: COA ERC20 balance (6 decimals)
  const [coaERC20BalanceWei, setCoaERC20BalanceWei] = useState<bigint>(BigInt(0));
  // MockFT: Cadence vault balance (8 decimals)
  const [ftVaultBalanceWei, setFTVaultBalanceWei] = useState<bigint>(BigInt(0));

  const [source, setSource] = useState<"auto" | WrapSource>("auto");
  const [amount, setAmount] = useState("1");
  const [wrapState, setWrapState] = useState<WrapState>({
    status: "loading",
    error: null,
    txId: null,
    checkpointTxId: null,
    wrappedAmount: null,
    newCommit: null,
  });

  const [feeBps, setFeeBps] = useState<number>(10); // default 10 bps = 0.1%
  const [needsCoaSetup, setNeedsCoaSetup] = useState(false);
  const [needsMemoKey, setNeedsMemoKey] = useState(false);
  const [settingUpCoa, setSettingUpCoa] = useState(false);
  const [showPreAnimation, setShowPreAnimation] = useState(false);
  const [showPostAnimation, setShowPostAnimation] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const tokenMeta = getTokenMeta(selectedToken);
  const tokenVariant = TOKEN_REGISTRY[selectedToken].variant;

  // -- Balance loader per token -----------------------------------------------

  const loadBalances = useCallback(async (tokenId: TokenId, addr: string, coa: string) => {
    setBalanceLoading(true);
    try {
      const entry = TOKEN_REGISTRY[tokenId];
      if (entry.variant === "native") {
        // FLOW: vault (Cadence) + COA EVM native balance
        const [vaultWei, coaWei] = await Promise.all([
          getFlowVaultBalanceWei(addr),
          getCoaBalanceWei(addr),
        ]);
        setVaultBalanceWei(vaultWei);
        setCoaBalanceWei(coaWei);
      } else if (entry.variant === "erc20") {
        // mUSDC: ERC20 balance of the COA address
        const { sdk } = await import("@claucondor/sdk");
        const bal = await sdk.token(tokenId).getBalance(coa);
        setCoaERC20BalanceWei(bal);
      } else if (entry.variant === "cadence-ft") {
        // MockFT: Cadence vault balance (UFix64 → 10^8 scale)
        const { sdk } = await import("@claucondor/sdk");
        const bal = await sdk.token(tokenId).getBalance(addr);
        setFTVaultBalanceWei(bal);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to load balance", { description: msg });
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  // -- Initial load -----------------------------------------------------------

  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;

    (async () => {
      try {
        const coa = await getCoaEvmAddress(userAddress);
        if (cancelled) return;
        setCoaHex(coa);
        setNeedsCoaSetup(false);

        // Cadence-ft tracks commitments by Cadence wallet address (16-char),
        // not by COA EVM address (40-char) — JanusFT's CommitmentRegistry lives on the user's Cadence account.
        const commitAddr = selectedToken === "mockft" ? userAddress : coa;
        const c = await getCommitment(commitAddr, selectedToken === "mockft" ? "mockft" : "flow");
        if (cancelled) return;
        setChainCommit(c);

        // Load balances for selected token
        await loadBalances(selectedToken, userAddress, coa);

        const memoPub = await getRecipientMemoPubkey(userAddress);
        const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
        const hasSessionPrivkey = getCachedMemoPrivkey(userAddress) !== null;
        if (cancelled) return;
        setNeedsMemoKey(memoPub === null || !hasSessionPrivkey);

        const s = loadShieldedState(userAddress, selectedToken);
        if (s) setShielded(s);

        // Read fee rate from chain (non-fatal)
        const bps = await fetchFeeBps(selectedToken);
        if (!cancelled) setFeeBps(bps);

        setWrapState({ status: "idle", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("No COA at /public/evm") || msg.includes("No COA")) {
          if (!cancelled) {
            setNeedsCoaSetup(true);
            setWrapState({ status: "idle", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
          }
          return;
        }
        if (!cancelled) {
          setWrapState({ status: "error", error: msg, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
          toast.error("Failed to initialize", { description: msg });
        }
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress]);

  // -- Re-load when token changes (after initial load) ----------------------

  useEffect(() => {
    if (!userAddress || !coaHex) return;
    if (wrapState.status === "loading") return; // still in initial load

    // Reset shielded balance for new token
    const s = loadShieldedState(userAddress, selectedToken);
    setShielded(s);

    // Fetch fee for new token
    fetchFeeBps(selectedToken)
      .then((bps) => setFeeBps(bps))
      .catch(() => {}); // non-fatal

    // Fetch on-chain commitment for new token.
    // Cadence-ft variant tracks commitments by Cadence wallet address.
    const commitAddr = selectedToken === "mockft" ? userAddress : coaHex;
    getCommitment(commitAddr, selectedToken)
      .then((c) => setChainCommit(c))
      .catch(() => {}); // non-fatal

    // Load balances for new token
    loadBalances(selectedToken, userAddress, coaHex);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedToken]);

  // -- Smart setup handler ----------------------------------------------------

  const handleSetupCoa = useCallback(async () => {
    if (!userAddress) return;
    setSettingUpCoa(true);
    try {
      const { smartSetupAccount, getRecipientMemoPubkey } = await import("@/lib/tip-actions");
      toast.info("Creating COA + MemoKey (one-time setup)...");
      const { txId } = await smartSetupAccount({ flowAddr: userAddress });
      toast.success(`Setup complete! Tx: ${txId.slice(0, 10)}...`);
      setNeedsCoaSetup(false);
      const coa = await getCoaEvmAddress(userAddress);
      setCoaHex(coa);
      const c = await getCommitment(coa);
      setChainCommit(c);
      const memoPub = await getRecipientMemoPubkey(userAddress);
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const hasSessionPrivkey = getCachedMemoPrivkey(userAddress) !== null;
      setNeedsMemoKey(memoPub === null || !hasSessionPrivkey);
    } catch (err) {
      toast.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSettingUpCoa(false);
    }
  }, [userAddress]);

  // -- Pre-flight check -------------------------------------------------------

  const getInsufficientReason = useCallback((): string | null => {
    if (!amount || !isValidFlowAmount(amount)) return null;
    try {
      const amountWei = parseTokenAmount(amount, selectedToken);
      if (amountWei <= 0n) return null;

      if (tokenVariant === "native") {
        if (source === "auto") {
          if (vaultBalanceWei < amountWei && coaBalanceWei < amountWei) {
            return `Insufficient FLOW: vault ${formatTokenAmount(vaultBalanceWei, "flow", 4)} / COA ${formatTokenAmount(coaBalanceWei, "flow", 4)}`;
          }
        } else if (source === "vault") {
          if (vaultBalanceWei < amountWei) return `Insufficient FLOW in vault (have ${formatTokenAmount(vaultBalanceWei, "flow", 4)})`;
        } else if (source === "coa") {
          if (coaBalanceWei < amountWei) return `Insufficient FLOW in COA (have ${formatTokenAmount(coaBalanceWei, "flow", 4)})`;
        }
      } else if (tokenVariant === "erc20") {
        if (coaERC20BalanceWei < amountWei) return `Insufficient ${tokenMeta.symbol} in COA (have ${formatTokenAmount(coaERC20BalanceWei, selectedToken, 4)})`;
      } else if (tokenVariant === "cadence-ft") {
        if (ftVaultBalanceWei < amountWei) return `Insufficient ${tokenMeta.symbol} in vault (have ${formatTokenAmount(ftVaultBalanceWei, selectedToken, 4)})`;
      }
    } catch { /* invalid amount */ }
    return null;
  }, [amount, selectedToken, tokenVariant, source, vaultBalanceWei, coaBalanceWei, coaERC20BalanceWei, ftVaultBalanceWei, tokenMeta.symbol]);

  // -- Wrap handler -----------------------------------------------------------

  const handleWrap = useCallback(async () => {
    if (!userAddress) { toast.error("Wallet not connected."); return; }

    // Show pre-animation at the moment the user clicks wrap
    setShowPreAnimation(true);

    setWrapState({ status: "validating", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });

    if (!isValidFlowAmount(amount)) {
      setWrapState({ status: "error", error: "Invalid amount.", txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
      setShowPreAnimation(false);
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseTokenAmount(amount, selectedToken);
      if (amountWei <= BigInt(0)) throw new Error("Amount must be > 0");
    } catch (err) {
      setWrapState({ status: "error", error: err instanceof Error ? err.message : "Invalid amount", txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
      setShowPreAnimation(false);
      return;
    }

    // Pre-flight balance check per variant
    if (tokenVariant === "native") {
      let resolvedSource: WrapSource;
      if (source === "auto") {
        if (vaultBalanceWei >= amountWei) {
          resolvedSource = "vault";
        } else if (coaBalanceWei >= amountWei) {
          resolvedSource = "coa";
        } else {
          setWrapState({
            status: "error",
            error: `Insufficient FLOW: vault has ${formatTokenAmount(vaultBalanceWei, "flow", 4)}, COA has ${formatTokenAmount(coaBalanceWei, "flow", 4)}, need ${amount}.`,
            txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null,
          });
          setShowPreAnimation(false);
          return;
        }
      } else {
        resolvedSource = source;
        const available = resolvedSource === "vault" ? vaultBalanceWei : coaBalanceWei;
        if (available < amountWei) {
          setWrapState({
            status: "error",
            error: `Selected source (${resolvedSource}) has only ${formatTokenAmount(available, "flow", 4)} FLOW, need ${amount}.`,
            txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null,
          });
          setShowPreAnimation(false);
          return;
        }
      }
    } else if (tokenVariant === "erc20") {
      if (coaERC20BalanceWei < amountWei) {
        setWrapState({
          status: "error",
          error: `Insufficient ${tokenMeta.symbol}: COA has ${formatTokenAmount(coaERC20BalanceWei, selectedToken, 4)}, need ${amount}.`,
          txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null,
        });
        setShowPreAnimation(false);
        return;
      }
    } else if (tokenVariant === "cadence-ft") {
      if (ftVaultBalanceWei < amountWei) {
        setWrapState({
          status: "error",
          error: `Insufficient ${tokenMeta.symbol}: vault has ${formatTokenAmount(ftVaultBalanceWei, selectedToken, 4)}, need ${amount}.`,
          txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null,
        });
        setShowPreAnimation(false);
        return;
      }
    }

    setWrapState({ status: "building_proof", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });

    try {
      // Step 1: Derive memoKeypair (sign-once, cached in session).
      let memoPrivkey: bigint;
      let memoKeypair: { privkey: bigint; pubkey: { x: bigint; y: bigint } };
      try {
        memoPrivkey = await getOrDeriveMemoPrivkey(userAddress);
        const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
        const pubkey = await pubkeyFromPrivkey(memoPrivkey);
        memoKeypair = { privkey: memoPrivkey, pubkey };
      } catch (err) {
        throw new Error(`Failed to derive memo key: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Step 2: Read previous shielded state from on-chain checkpoint (VoidSigner staticCall).
      // v0.8.2: per-token read. cadence-ft (MockFT) has no EVM proxy — treat as fresh start.
      const coaAddr = coaHex!;
      const wrapTokenEntry = TOKEN_REGISTRY[selectedToken];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapTokenProxy = wrapTokenEntry.variant !== "cadence-ft" ? (wrapTokenEntry as any).proxy as string : null;
      // cadence-ft (MockFT): no EVM proxy — checkpoint lives on the Cadence side,
      // handled inside the combined Cadence tx. EVM-side prevState read does not apply.
      const prevState = wrapTokenProxy
        ? await getShieldedStateForCoa(coaAddr, memoPrivkey, wrapTokenProxy).catch(() => null)
        : null;
      const prevBalance = prevState?.balance ?? 0n;
      const prevBlinding = prevState?.blinding ?? 0n;
      const prevCursor = prevState?.lastConsumedNoteIndex ?? 0n;

      setWrapState({ status: "submitting", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });

      // Step 3: Call wrapToken — generates proof server-side, submits via COA Cadence tx,
      // then updates ShieldedCheckpoint via COA Cadence tx. All browser-safe (no raw EVM key).
      const netAmountWei = computeNetWrap(amountWei, feeBps);
      const result = await wrapToken({
        tokenId: selectedToken,
        grossAmount: amountWei,
        coaEvmAddr: coaAddr,
        memoKeypair,
        memoPrivkey,
        prevBalance,
        prevBlinding,
        prevCursor,
        userCadenceAddr: tokenVariant === "cadence-ft" ? userAddress : undefined,
      });

      // Step 4: Update local shielded balance display (optimistic from result).
      setShielded({
        balanceWei: result.newBalance.toString(),
        blinding: result.newBlinding.toString(),
      });

      // Step 5: Refresh on-chain commitment display.
      if (coaHex) {
        try {
          const commitAddr = tokenVariant === "cadence-ft" ? userAddress : coaHex;
          const c = await getCommitment(commitAddr, selectedToken);
          setChainCommit(c);
        } catch { /* non-fatal */ }
      }

      // Step 6: Refresh underlying balances.
      if (coaHex) {
        loadBalances(selectedToken, userAddress, coaHex).catch(() => {});
      }

      setShowPreAnimation(false);
      setShowPostAnimation(true);

      setWrapState({
        status: "success",
        error: null,
        txId: result.txHash,
        checkpointTxId: result.checkpointTxHash,
        wrappedAmount: formatTokenAmount(netAmountWei, selectedToken, 4),
        newCommit: null, // commitment point no longer returned by wrapToken (checkpoint-based)
      });
      toast.success("Wrap successful!", {
        description: `${formatTokenAmount(netAmountWei, selectedToken, 4)} ${tokenMeta.symbol} now in your shielded slot.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wrap failed";
      setShowPreAnimation(false);
      setWrapState({ status: "error", error: msg, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
      toast.error("Wrap failed", { description: msg });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, amount, coaHex, source, vaultBalanceWei, coaBalanceWei, coaERC20BalanceWei, ftVaultBalanceWei, selectedToken, tokenVariant, tokenMeta, feeBps]);

  const isSubmitting =
    wrapState.status === "validating" ||
    wrapState.status === "building_proof" ||
    wrapState.status === "submitting";

  const insufficientReason = getInsufficientReason();
  const wrapDisabled = isSubmitting || !amount || !!insufficientReason;

  // -- Unauthenticated -------------------------------------------------------

  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#B45309_15%,transparent)]">
            <Coins className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">Connect your wallet to wrap tokens into your shielded slot.</p>
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

  // -- COA setup required ----------------------------------------------------

  if (needsCoaSetup) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 janus-page">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center text-sm text-foreground/40 hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" />Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#B45309_15%,transparent)]">
            <Coins className="w-8 h-8 text-[#B45309]" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>One-time wallet setup</h2>
          <p className="text-sm text-foreground/50 mb-2 max-w-sm">
            Your Flow account doesn&apos;t have a COA or a published MemoKey yet — both are required for shielded transfers.
          </p>
          <p className="text-sm text-foreground/50 mb-2 max-w-sm">
            <strong className="text-foreground/80">Setting up: COA + sign-derived MemoKey.</strong> The wallet will prompt for{" "}
            <strong className="text-foreground/80">one signature</strong> to derive your memo key, then a second popup to submit the on-chain setup transaction.
          </p>
          <p className="text-sm text-foreground/50 mb-6 max-w-sm">This is a one-time, gas-only setup.</p>
          <motion.button
            onClick={handleSetupCoa}
            disabled={settingUpCoa}
            whileHover={settingUpCoa ? {} : { scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
            className="janus-button-primary px-6 py-3 rounded-xl text-base disabled:opacity-50"
          >
            {settingUpCoa ? "Setting up..." : "Setup Wallet for Shielded Transfers"}
          </motion.button>
          <Link
            href="/status"
            className="mt-3 text-xs text-foreground/40 hover:text-foreground/70 transition-colors"
          >
            Or activate without wrapping →
          </Link>
        </div>
      </div>
    );
  }

  // -- Main UI ---------------------------------------------------------------

  const onChainEmpty = chainCommit ? isIdentityPoint(chainCommit) : true;

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
        <div className="w-10 h-10 rounded-lg bg-[#B45309]/12 border border-[#B45309]/30 flex items-center justify-center shadow-[0_0_16px_color-mix(in_oklch,#B45309_12%,transparent)]">
          <Coins className="w-5 h-5 text-[#B45309]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Add private {tokenMeta.symbol}</h1>
          <p className="text-sm text-foreground/50">Cross the entry boundary — your {tokenMeta.symbol} moves into the private zone.</p>
        </div>
      </motion.div>

      {/* MemoKey setup banner */}
      {needsMemoKey && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-lg border border-[#B45309]/40 bg-[#B45309]/8 px-3 py-2 mb-4 flex items-center justify-between gap-3 text-xs"
        >
          <span className="text-amber-200/90">
            Your private inbox isn&apos;t active yet. Click Enable — your wallet will sign one message + confirm one transaction.
          </span>
          <motion.button
            onClick={handleSetupCoa}
            disabled={settingUpCoa}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="shrink-0 px-3 py-1 rounded border border-[#B45309]/50 bg-[#B45309]/12 text-amber-200 font-medium hover:bg-[#B45309]/20 transition-colors disabled:opacity-50 text-xs"
          >
            {settingUpCoa ? "Signing + setting up…" : "Enable"}
          </motion.button>
        </motion.div>
      )}

      {/* Current shielded balance card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE, delay: 0.05 }}
        className="rounded-xl border border-[#00EF8B]/20 bg-[#00EF8B]/5 p-6 mb-6 shadow-[0_0_24px_color-mix(in_oklch,#00EF8B_6%,transparent)]"
      >
        <div className="flex items-start gap-3">
          <Shield className="w-6 h-6 text-[#00EF8B] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground/70 mb-1">Your private balance ({tokenMeta.symbol})</p>
            {shielded ? (
              <p className="text-2xl font-bold text-[#00EF8B]" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>
                {formatTokenAmount(BigInt(shielded.balanceWei), selectedToken, 4)} {tokenMeta.symbol}
              </p>
            ) : (
              <p className="text-sm text-foreground/40">Nothing here yet — your first wrap starts it.</p>
            )}
            {chainCommit && (
              <div className="mt-2 text-[10px] text-foreground/30">
                <p>On-chain proof of balance {onChainEmpty ? "(empty)" : "(active)"}:</p>
                <p className="font-mono break-all">{formatPoint(chainCommit).slice(0, 80)}…</p>
              </div>
            )}
            <p className="text-[10px] text-foreground/30 mt-2">
              Only you see the actual amount — others see an opaque crypto point. Math (Pedersen commitments) handles the privacy.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Pre-wrap educational animation */}
      {wrapState.status !== "success" && (
        <PedersenCommitFormation
          direction="in"
          trigger={showPreAnimation || wrapState.status === "idle"}
          onDismiss={() => setShowPreAnimation(false)}
        />
      )}

      {/* Wrap form */}
      {wrapState.status !== "success" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: 0.1 }}
          className="rounded-xl border border-[#B45309]/25 janus-copper-glow bg-[#0D1E38]/80 p-6 space-y-4 mb-6"
        >
          {/* Token selector */}
          <TokenSelector
            value={selectedToken}
            onChange={(id) => {
              setSelectedToken(id);
              setShielded(loadShieldedState(userAddress ?? "", id));
            }}
            disabled={isSubmitting}
            label="Token to wrap"
          />

          {/* Source picker — FLOW only */}
          {tokenVariant === "native" && (
            <div>
              <label className="text-xs font-medium text-foreground/50 mb-1 block">Source of FLOW</label>
              <div className="grid grid-cols-3 gap-2 mb-1">
                {(["auto", "vault", "coa"] as const).map((s) => (
                  <motion.button
                    key={s}
                    type="button"
                    onClick={() => setSource(s)}
                    disabled={isSubmitting}
                    whileHover={!isSubmitting && source !== s ? { scale: 1.02 } : {}}
                    whileTap={{ scale: 0.98 }}
                    className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                      source === s
                        ? "bg-[#00EF8B]/15 text-[#00EF8B] border-[#00EF8B]/30"
                        : "bg-white/3 border-white/10 text-foreground/50 hover:border-white/20 hover:text-foreground/70"
                    }`}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </motion.button>
                ))}
              </div>
              <div className="text-[10px] text-foreground/30 space-y-0.5">
                <p>
                  {balanceLoading ? (
                    <span className="text-foreground/30">Loading balances…</span>
                  ) : (
                    <>
                      Vault: <span className="font-mono text-foreground/50">{formatTokenAmount(vaultBalanceWei, "flow", 4)}</span> FLOW
                      {" · "}
                      COA: <span className="font-mono text-foreground/50">{formatTokenAmount(coaBalanceWei, "flow", 4)}</span> FLOW
                    </>
                  )}
                </p>
                <p>
                  {source === "auto" && "Auto picks your main FLOW balance first; uses EVM balance if main is low."}
                  {source === "vault" && "Pulls from your main Flow wallet balance."}
                  {source === "coa" && "Pulls from your Flow-EVM balance in one transaction."}
                  {" "}Privacy is the same either way.
                </p>
              </div>
            </div>
          )}

          {/* Read-only source info for non-FLOW tokens */}
          {tokenVariant === "erc20" && (
            <div className="text-[10px] text-foreground/30 space-y-0.5">
              <p>
                Source: <span className="text-foreground/50">COA (EVM)</span>
                {" · "}
                {balanceLoading ? (
                  <span className="text-foreground/30">Loading…</span>
                ) : (
                  <>COA: <span className="font-mono text-foreground/50">{formatTokenAmount(coaERC20BalanceWei, selectedToken, 4)}</span> {tokenMeta.symbol}</>
                )}
              </p>
              <p>{tokenMeta.symbol} lives in your COA (EVM address). The SDK handles the approve+wrap in one flow.</p>
            </div>
          )}

          {tokenVariant === "cadence-ft" && (
            <div className="text-[10px] text-foreground/30 space-y-0.5">
              <p>
                Source: <span className="text-foreground/50">Cadence vault</span>
                {" · "}
                {balanceLoading ? (
                  <span className="text-foreground/30">Loading…</span>
                ) : (
                  <>Vault: <span className="font-mono text-foreground/50">{formatTokenAmount(ftVaultBalanceWei, selectedToken, 4)}</span> {tokenMeta.symbol}</>
                )}
              </p>
              <p>{tokenMeta.symbol} is a Cadence FungibleToken. The SDK bridges it into the shielded EVM slot automatically.</p>
            </div>
          )}

          {/* Amount input */}
          <div>
            <label className="text-xs font-medium text-foreground/50 mb-1 block">Amount to wrap ({tokenMeta.symbol})</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1"
              className="janus-input font-mono"
              disabled={isSubmitting}
            />
            {/* Fee disclosure */}
            {(() => {
              try {
                const grossWei = parseTokenAmount(amount, selectedToken);
                if (grossWei > 0n) {
                  const netWei  = computeNetWrap(grossWei, feeBps);
                  const feeWei  = computeWrapFee(grossWei, feeBps);
                  const feePct  = feeBps / 100;
                  return (
                    <p className="text-[10px] text-foreground/40 mt-1">
                      Wrapping {amount} {tokenMeta.symbol} → <span className="text-[#00EF8B]/70">{formatTokenAmount(netWei, selectedToken, 4)} {tokenMeta.symbol}</span> credited
                      {" "}(<span className="text-foreground/50">{formatTokenAmount(feeWei, selectedToken, 4)} {tokenMeta.symbol} fee, {feePct}%</span>)
                    </p>
                  );
                }
              } catch { /* invalid amount */ }
              return (
                <p className="text-[10px] text-foreground/30 mt-1">
                  This amount is visible at the entry point. A {feeBps / 100}% fee applies. Once inside, every tip you send hides the amount.
                </p>
              );
            })()}
          </div>

          {/* Insufficient balance warning */}
          {insufficientReason && (
            <p className="text-[10px] text-red-400/80">{insufficientReason}</p>
          )}

          <motion.button
            onClick={handleWrap}
            disabled={wrapDisabled}
            whileHover={!wrapDisabled ? { scale: 1.01, y: -1 } : {}}
            whileTap={{ scale: 0.99 }}
            className="janus-button-primary w-full py-3 rounded-xl text-base disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {wrapState.status === "validating" && "Validating…"}
                {wrapState.status === "building_proof" && "Generating Groth16 proof…"}
                {wrapState.status === "submitting" && "Submitting…"}
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Coins className="w-4 h-4" />
                Wrap {tokenMeta.symbol}
              </span>
            )}
          </motion.button>
        </motion.div>
      )}

      {/* Post-wrap success animation + result */}
      {wrapState.status === "success" && (
        <>
          <PedersenCommitFormation
            direction="in"
            trigger={showPostAnimation}
            onDismiss={() => setShowPostAnimation(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="rounded-xl border border-[#00EF8B]/25 bg-[#00EF8B]/8 p-6 mb-6 shadow-[0_0_32px_color-mix(in_oklch,#00EF8B_10%,transparent)]"
          >
            <div className="flex items-start gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-[#00EF8B] shrink-0" />
              <div>
                <h3 className="text-lg font-bold mb-1 text-foreground">Wrap successful!</h3>
                <p className="text-xs text-foreground/50">{wrapState.wrappedAmount} {tokenMeta.symbol} now in your shielded slot.</p>
              </div>
            </div>
            {wrapState.txId && (
              <div className="mb-2">
                <p className="text-xs font-medium text-foreground/70 mb-1">Wrap transaction:</p>
                <a
                  href={FLOWSCAN_CADENCE_TX(wrapState.txId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[10px] break-all text-[#00EF8B]/70 hover:text-[#00EF8B] transition-colors"
                >
                  {wrapState.txId.slice(0, 20)}… ↗
                </a>
              </div>
            )}
            {wrapState.checkpointTxId && (
              <div className="mb-3">
                <p className="text-xs font-medium text-foreground/70 mb-1">Checkpoint update:</p>
                <a
                  href={FLOWSCAN_CADENCE_TX(wrapState.checkpointTxId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[10px] break-all text-foreground/50 hover:text-foreground/80 transition-colors"
                >
                  {wrapState.checkpointTxId.slice(0, 20)}… ↗
                </a>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-foreground/40 mb-4">
              <EyeOff className="w-3 h-3" />
              Your shielded balance is encrypted on-chain — only you can read it.
            </div>
            <div className="flex gap-3 justify-center">
              <Link href="/send">
                <motion.span
                  whileHover={{ scale: 1.02, y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  className="janus-button-primary px-4 py-2 rounded-lg text-sm cursor-pointer"
                >
                  Send a Tip
                </motion.span>
              </Link>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setWrapState({ status: "idle", error: null, txId: null, checkpointTxId: null, wrappedAmount: null, newCommit: null });
                  setShowPostAnimation(false);
                }}
                className="px-4 py-2 rounded-lg border border-white/15 bg-white/5 text-foreground/70 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                Wrap More
              </motion.button>
            </div>
          </motion.div>
        </>
      )}

      {/* Error */}
      {wrapState.status === "error" && wrapState.error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border border-red-500/20 bg-red-950/20 p-4 mb-6"
        >
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300 mb-1">Wrap failed</p>
              <p className="text-xs text-red-400/70">{wrapState.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Footer: addresses */}
      <div className="mt-8 text-[10px] text-foreground/20 space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono break-all">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono break-all">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

export default function WrapPage() {
  return (
    <Suspense fallback={<div className="max-w-lg mx-auto px-4 py-12" />}>
      <WrapPageInner />
    </Suspense>
  );
}
