/// Tip action helpers — v0.8 (Checkpoint + Inbox + COA-via-FCL signer pattern).
///
/// Architecture (v0.8):
///   - All shielded state is sourced from ShieldedCheckpointClient.readAndDecrypt()
///     (on-chain, per-user encrypted store). No localStorage for balance/blinding.
///   - Incoming notes arrive via ShieldedInbox; drain with drainAndDecrypt().
///   - EVM write ops that need msg.sender (checkpoint updates, inbox drain) require
///     an ethers.Wallet. Pages construct this via window.ethereum BrowserProvider
///     (wired in Phase 4-6).
///   - Cadence-only ops (wrap, send, unwrap, inbox install, checkpoint install)
///     go through FCL + COA; no ethers.Wallet needed.
///
/// Deprecated v0.7 patterns removed:
///   - TX_SMART_SETUP / smartSetupAccount — replaced by cadenceTx.installInboxAndCheckpoint()
///     called from activateAccount().
///   - wrapActionLegacy / sendShieldedTipAction / unwrapActionLegacy — replaced by
///     wrapToken / sendTip / unwrapToken.
///   - orchestrateShieldedTransferWithPrebuiltProof (legacy combined tx) — removed.
///   - PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1" — frozen v0.7 address. v0.8 uses 0x4b6bc58bc8bf5dcc.
///   - latestSnapshot / scanIncomingNotes / scanDeposits — removed from SDK.

import {
  sdk,
  type BabyJubKeypair,
  type SnapshotContent,
  type NoteContent,
  type WrapResult,
  type SendResult,
  type UnwrapResult,
  type TxResult,
  type CheckpointPayload,
  ShieldedCheckpointClient,
  ShieldedInboxClient,
  cadenceTx,
  computeNetWrap,
  computeWrapFee,
  generateBlinding,
  decryptSnapshot,
  encryptNote,
  decryptNote,
  installInboxAndCheckpoint,
} from "@claucondor/sdk";
import {
  getCoaEvmAddress as sdkGetCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei as sdkGetCoaBalanceWei,
  getFlowVaultBalanceWei as sdkGetFlowVaultBalanceWei,
  TX_SETUP_COA,
  createEvmWallet,
  createEvmProvider,
  TOKEN_REGISTRY,
} from "@claucondor/sdk/network";
import { ethers } from "ethers";
import type { TokenId } from "./tokens";
import type { ShieldedTokenState } from "./store";
import { saveSentMemo } from "./memo-mirror";

export type {
  BabyJubKeypair,
  SnapshotContent,
  NoteContent,
  WrapResult,
  SendResult,
  UnwrapResult,
  TxResult,
  CheckpointPayload,
};

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Re-export Point for callers that need it. */
export type Point = { x: bigint; y: bigint };

/** EVM signer type — ethers.Wallet for EVM-direct ops (checkpoint read/write, inbox drain). */
export type EVMSigner = ethers.Wallet;

// ─── Constants ──────────────────────────────────────────────────────────────────

export const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
export const EVM_CHAIN_ID = 545;

/**
 * PrivateTip Cadence contract address (v0.8).
 * v0.7 frozen address (0xb9ac529c14a4c5a1) is retired — never write to it.
 */
export const PRIVATE_TIP_CADENCE = "0x4b6bc58bc8bf5dcc";

/** Per-token proxy addresses from SDK registry (canonical, no hardcoding). */
export const TOKEN_PROXIES = {
  flow:     TOKEN_REGISTRY.flow.proxy,
  mockusdc: TOKEN_REGISTRY.mockusdc.proxy,
  mockft:   TOKEN_REGISTRY.mockft.cadenceAddress,
} as const;

// ─── BabyJub suborder (for blinding accumulation) ────────────────────────────

const BABYJUB_SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// ─── Unit helpers ────────────────────────────────────────────────────────────

export const FLOW_SCALE: bigint = 10n ** 18n;

export function parseFlowToWei(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * FLOW_SCALE + BigInt(fracPadded || "0");
}
export function formatWeiToFlow(wei: bigint, decimals = 4): string {
  const whole = wei / FLOW_SCALE;
  const frac = wei % FLOW_SCALE;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  return `${whole}.${fracStr}`;
}
export function formatWeiToFlowUFix64(wei: bigint): string {
  const whole = wei / FLOW_SCALE;
  const frac = wei % FLOW_SCALE;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 8);
  return `${whole}.${fracStr}`;
}
export function formatPoint(p: Point): string {
  return `(${p.x.toString(16).slice(0, 8)}…, ${p.y.toString(16).slice(0, 8)}…)`;
}
export function isIdentityPoint(p: Point): boolean {
  return p.x === 0n && p.y === 1n;
}
export function isValidFlowAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(addr.trim());
}
export function isValidFlowAmount(amount: string): boolean {
  return /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;
}

// ─── EVM provider (view-only, no signer required for public reads) ───────────

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  }
  return _provider;
}

// ─── FCL lazy-load ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fcl = any;
let _fcl: Fcl | null = null;
async function getFcl(): Promise<Fcl> {
  if (!_fcl) _fcl = await import("@onflow/fcl");
  return _fcl!;
}

// ─── SDK adapter access ──────────────────────────────────────────────────────

export function getAdapter(tokenId: TokenId) {
  return sdk.token(tokenId);
}

// ─── WrapWithSnapshot event parser ───────────────────────────────────────────

const WRAP_EVENT_SIG =
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const _wrapIface = new ethers.Interface([WRAP_EVENT_SIG]);

/**
 * Parse the WrapWithSnapshot event from a tx receipt and decrypt the marginal snapshot.
 * The marginal snapshot contains (balance: netAmount, blinding) for this single wrap only.
 * Callers MUST accumulate: newBalance = prevBalance + marginal.balance.
 */
export async function parseWrapSnapshot(
  txHash: string,
  memoPrivkey: bigint
): Promise<{ balance: bigint; blinding: bigint } | null> {
  const provider = getProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = _wrapIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WrapWithSnapshot") {
        const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
        const ephX = BigInt(parsed.args.ephPubkeyX);
        const ephY = BigInt(parsed.args.ephPubkeyY);
        const snap = await decryptSnapshot(encBytes, { x: ephX, y: ephY }, memoPrivkey);
        if (!snap) continue;
        return { balance: snap.balance, blinding: snap.blinding };
      }
    } catch {
      /* not this event — continue */
    }
  }
  return null;
}

// ─── MemoKey management ─────────────────────────────────────────────────────

/**
 * Get the recipient's MemoKey pubkey for a given token.
 * For EVM tokens (flow, mockusdc): resolves COA from Cadence address first.
 * For cadence-ft (mockft): reads from Cadence JanusFlow MemoKey path.
 *
 * Returns null if no key published.
 */
export async function getRecipientMemoPubkey(
  flowAddr: string,
  tokenId: TokenId = "flow"
): Promise<Point | null> {
  try {
    const adapter = sdk.token(tokenId);
    const entry = TOKEN_REGISTRY[tokenId];
    if (entry.variant === "cadence-ft") {
      return await adapter.getMemoKey(flowAddr);
    }
    const coaAddr = await sdkGetCoaEvmAddress(flowAddr, "testnet");
    return await adapter.getMemoKey(coaAddr);
  } catch {
    return null;
  }
}

/**
 * Get the recipient's MemoKey pubkey by a raw EVM address.
 * Used for EVM-only recipients who published their key to MemoKeyRegistry directly.
 */
export async function getMemoPubkeyByEvmAddr(
  evmAddr: string,
  tokenId: TokenId = "flow"
): Promise<Point | null> {
  try {
    const entry = TOKEN_REGISTRY[tokenId];
    if (entry.variant === "cadence-ft") {
      return null; // cadence-ft doesn't use the EVM MemoKeyRegistry for EVM-only recipients
    }
    const adapter = sdk.token(tokenId);
    return await adapter.getMemoKey(evmAddr);
  } catch {
    return null;
  }
}

/**
 * Check whether an account has BOTH a COA and a published MemoKey.
 */
export async function recipientFullyConfigured(flowAddr: string): Promise<{
  hasCoa: boolean;
  hasMemoKey: boolean;
}> {
  const [coaOk, pk] = await Promise.all([
    hasCOA(flowAddr, "testnet"),
    getRecipientMemoPubkey(flowAddr, "flow"),
  ]);
  return { hasCoa: coaOk, hasMemoKey: pk !== null };
}

// ─── COA / FCL helpers ──────────────────────────────────────────────────────

export async function getCoaEvmAddress(flowAddress: string): Promise<string> {
  return sdkGetCoaEvmAddress(flowAddress, "testnet");
}

export async function recipientHasCoa(flowAddress: string): Promise<boolean> {
  return hasCOA(flowAddress, "testnet");
}

export async function getCoaBalanceWei(flowAddress: string): Promise<bigint> {
  return sdkGetCoaBalanceWei(flowAddress, "testnet");
}

export async function getFlowVaultBalanceWei(flowAddress: string): Promise<bigint> {
  return sdkGetFlowVaultBalanceWei(flowAddress, "testnet");
}

export { TX_SETUP_COA };

// ─── On-chain reads ──────────────────────────────────────────────────────────

/**
 * Get the current commitment for an address and token.
 * For EVM tokens: addr should be the COA EVM hex address.
 * For mockft: addr should be the Cadence address.
 */
export async function getCommitment(addr: string, tokenId: TokenId = "flow"): Promise<Point> {
  const adapter = sdk.token(tokenId);
  return adapter.getCommitment(addr);
}

/**
 * Get the token balance (underlying, NOT shielded) for an address.
 */
export async function getTokenBalance(addr: string, tokenId: TokenId): Promise<bigint> {
  const adapter = sdk.token(tokenId);
  return adapter.getBalance(addr);
}

// ─── MemoKey session cache + sign-derive helpers ──────────────────────────────

export {
  getCachedMemoPrivkey,
  cacheMemoPrivkey,
  clearMemoPrivkeyCache,
} from "./memo-key-session";

export { deriveMemoKeyFromWallet } from "./memo-key-derive";

import { getCachedMemoPrivkey, cacheMemoPrivkey } from "./memo-key-session";
import { deriveMemoKeyFromWallet } from "./memo-key-derive";

export async function getOrDeriveMemoPrivkey(flowAddr: string): Promise<bigint> {
  const cached = getCachedMemoPrivkey(flowAddr);
  if (cached !== null) return cached;
  const kp = await deriveMemoKeyFromWallet();
  cacheMemoPrivkey(flowAddr, kp.privkey);
  return kp.privkey;
}

export function loadMemoPrivkey(flowAddr: string): bigint | null {
  return getCachedMemoPrivkey(flowAddr);
}

// ─── v0.8 Core: activateAccount ─────────────────────────────────────────────

export interface ActivateAccountResult {
  /**
   * Transaction hash of the MemoKey publish EVM tx.
   * null if skipped (key already published).
   */
  memoKeyTxHash: string | null;
  /**
   * Transaction ID of the Cadence installInboxAndCheckpoint tx.
   * null if skipped (resources already installed).
   */
  installTxId: string | null;
  pubkey: Point;
}

/**
 * 3-step account activation (v0.8, all idempotent):
 * 1. Derive BabyJub keypair from wallet signature.
 * 2. Publish MemoKey to MemoKeyRegistry via EVM (evmSigner).
 * 3. Install ShieldedInbox + ShieldedCheckpoint Cadence resources via FCL.
 *
 * Steps 2 and 3 are skipped if already done (idempotent).
 *
 * @param flowAddr  Caller's Cadence address.
 * @param evmSigner Ethers wallet (COA-derived) for EVM MemoKey publish.
 */
export async function activateAccount(
  flowAddr: string,
  evmSigner: ethers.Wallet
): Promise<ActivateAccountResult> {
  // Step 1: Derive + cache keypair
  let kp = await (async () => {
    const cached = getCachedMemoPrivkey(flowAddr);
    if (cached !== null) {
      const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
      const pubkey = await pubkeyFromPrivkey(cached);
      return { privkey: cached, pubkey };
    }
    const derived = await deriveMemoKeyFromWallet();
    cacheMemoPrivkey(flowAddr, derived.privkey);
    return derived;
  })();

  // Step 2: Publish MemoKey to EVM MemoKeyRegistry (idempotent — check first)
  let memoKeyTxHash: string | null = null;
  const adapter = sdk.token("flow");
  const existing = await adapter.getMemoKey(evmSigner.address);
  if (!existing || (existing.x === 0n && existing.y === 0n)) {
    const result = await adapter.publishMemoKey(kp, evmSigner);
    memoKeyTxHash = result.txHash;
  }

  // Step 3: Install ShieldedInbox + ShieldedCheckpoint via FCL Cadence tx
  let installTxId: string | null = null;
  const cpClient = new ShieldedCheckpointClient();
  const ibClient = new ShieldedInboxClient();
  const [cpExists, ibCount] = await Promise.all([
    cpClient.exists(evmSigner.address),
    ibClient.count(evmSigner.address).then(() => true).catch(() => false),
  ]);
  if (!cpExists || !ibCount) {
    const fcl = await getFcl();
    installTxId = await fcl.mutate({
      cadence: cadenceTx.installInboxAndCheckpoint(),
      args: () => [],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(installTxId).onceSealed();
  }

  return { memoKeyTxHash, installTxId, pubkey: kp.pubkey };
}

// ─── v0.8 Core: getShieldedState ─────────────────────────────────────────────

/**
 * Read the caller's current shielded state from their on-chain ShieldedCheckpoint.
 * Returns null if no checkpoint exists yet (account not activated).
 *
 * @param evmSigner   Ethers wallet (checkpoint is owner-only read via msg.sender).
 * @param memoPrivkey Caller's BabyJub private key for ECIES decryption.
 */
export async function getShieldedState(
  evmSigner: ethers.Wallet,
  memoPrivkey: bigint
): Promise<ShieldedTokenState | null> {
  const cpClient = new ShieldedCheckpointClient();
  const snapshot = await cpClient.readAndDecrypt(evmSigner, memoPrivkey);
  if (!snapshot) return null;

  const meta = await cpClient.metadata(evmSigner.address);
  const ibClient = new ShieldedInboxClient();
  const pendingCount = await ibClient.count(evmSigner.address);

  return {
    balanceRaw: snapshot.balance.toString(),
    blinding: snapshot.blinding.toString(),
    checkpointVersion: meta.version.toString(),
    lastUpdatedBlock: meta.lastUpdatedBlock.toString(),
    inboxPendingCount: Number(pendingCount),
  };
}

// ─── v0.8 Core: wrapToken ────────────────────────────────────────────────────

export interface WrapTokenParams {
  tokenId: TokenId;
  grossAmount: bigint;
  /** Caller's COA EVM hex address (for ViaCoa FCL path). */
  coaEvmAddr: string;
  /** Caller's BabyJub keypair (for checkpoint encryption). */
  memoKeypair: BabyJubKeypair;
  /** Caller's BabyJub privkey (for snapshot decryption from WrapWithSnapshot event). */
  memoPrivkey: bigint;
  /** Previous balance (to accumulate on top of). Pass 0n if first wrap. */
  prevBalance: bigint;
  /** Previous blinding (to accumulate on top of). Pass 0n if first wrap. */
  prevBlinding: bigint;
  /** Previous inbox cursor (from checkpoint metadata). Pass 0n if no drain done. */
  prevCursor: bigint;
  /** Ethers wallet — needed to update ShieldedCheckpoint after wrap. */
  evmSigner: ethers.Wallet;
  /** For cadence-ft (mockft): the user's Cadence address. */
  userCadenceAddr?: string;
}

export interface WrapTokenResult {
  /** JanusFlow wrap tx hash (EVM via COA Cadence tx). */
  txHash: string;
  /** ShieldedCheckpoint update tx hash. */
  checkpointTxHash: string;
  /** New CUMULATIVE balance after this wrap. */
  newBalance: bigint;
  /** New CUMULATIVE blinding after this wrap. */
  newBlinding: bigint;
}

/**
 * Wrap underlying → shielded and update ShieldedCheckpoint with accumulated state.
 *
 * Accumulation rule (critical for correctness, v0.7 had a bug here):
 *   newBalance = prevBalance + marginalBalance
 *   newBlinding = (prevBlinding + marginalBlinding) % BABYJUB_SUBORDER
 *
 * The WrapWithSnapshot event from the EVM contract carries only the MARGINAL
 * (balance, blinding) for this wrap, not the cumulative total.
 */
export async function wrapToken(params: WrapTokenParams): Promise<WrapTokenResult> {
  const { tokenId, grossAmount, coaEvmAddr, memoKeypair, memoPrivkey,
    prevBalance, prevBlinding, prevCursor, evmSigner, userCadenceAddr } = params;

  const adapter = sdk.token(tokenId);
  const entry = TOKEN_REGISTRY[tokenId];

  // For ERC20 tokens, pre-approve the JanusERC20 proxy
  if (entry.variant === "erc20") {
    const erc20Entry = entry as typeof TOKEN_REGISTRY["mockusdc"];
    const erc20 = new ethers.Contract(
      erc20Entry.underlying,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      evmSigner
    );
    const approveTx = await erc20.approve(erc20Entry.proxy, grossAmount);
    await approveTx.wait();
  }

  let wrapResult: WrapResult;
  if (entry.variant === "native" || entry.variant === "erc20") {
    // FCL/COA path — user signs one Cadence tx in Flow Wallet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapResult = await (adapter as any).wrapViaCoa({ grossAmount, coaEvmAddr });
  } else {
    // cadence-ft (MockFT): JanusFTAdapter wraps via FCL internally
    wrapResult = await adapter.wrap({ grossAmount }, evmSigner);
  }

  // Parse WrapWithSnapshot event to get the marginal (balance, blinding)
  const marginal = await parseWrapSnapshot(wrapResult.txHash, memoPrivkey);

  // Accumulate: new state = prev + marginal (field arithmetic mod suborder for blinding)
  const marginalBalance = marginal?.balance ?? wrapResult.netAmount;
  const marginalBlinding = marginal?.blinding ?? generateBlinding();
  const newBalance = prevBalance + marginalBalance;
  const newBlinding = (prevBlinding + marginalBlinding) % BABYJUB_SUBORDER;

  // Update ShieldedCheckpoint with cumulative state
  const cpClient = new ShieldedCheckpointClient();
  const cpResult = await cpClient.encryptAndUpdate(
    { balance: newBalance, blinding: newBlinding },
    prevCursor,
    memoKeypair,
    evmSigner
  );

  return {
    txHash: wrapResult.txHash,
    checkpointTxHash: cpResult.txHash,
    newBalance,
    newBlinding,
  };
}

// ─── v0.8 Core: sendTip ──────────────────────────────────────────────────────

export interface SendTipParams {
  tokenId: TokenId;
  /** Recipient's EVM hex address (EVM tokens) or Cadence address (mockft). */
  recipientAddr: string;
  amount: bigint;
  /** Optional plaintext memo — encrypted to recipient via SDK ECIES. */
  memo?: string;
  /** Caller's COA EVM hex address (for ViaCoa FCL path). */
  coaEvmAddr: string;
  /** Caller's BabyJub keypair (for checkpoint payload). */
  memoKeypair: BabyJubKeypair;
  /** Caller's Cadence address (for memo-mirror and mockft path). */
  userCadenceAddr?: string;
  /** Current balance from checkpoint (for proof). */
  currentBalance: bigint;
  /** Current blinding from checkpoint (for proof). */
  currentBlinding: bigint;
  /** Ethers wallet — needed to update ShieldedCheckpoint after send. */
  evmSigner: ethers.Wallet;
  /** Inbox cursor from checkpoint metadata (for checkpoint update). */
  inboxCursor: bigint;
}

export interface SendTipResult {
  /** Cadence tx ID (via COA) or EVM tx hash. */
  txHash: string;
  /** ShieldedCheckpoint update tx hash. */
  checkpointTxHash: string;
  /** Net amount received by recipient (after fee). */
  netToRecipient: bigint;
}

/**
 * Send a shielded tip to a recipient and update the sender's ShieldedCheckpoint.
 *
 * Uses the ViaCoa FCL path for EVM tokens (COA is msg.sender, no raw ethers.Wallet
 * needed for the transfer itself). ShieldedCheckpoint update requires evmSigner.
 */
export async function sendTip(params: SendTipParams): Promise<SendTipResult> {
  const { tokenId, recipientAddr, amount, memo, coaEvmAddr, memoKeypair,
    userCadenceAddr, currentBalance, currentBlinding, evmSigner, inboxCursor } = params;

  if (amount > currentBalance) {
    throw new Error(`sendTip: insufficient shielded balance: have ${currentBalance}, need ${amount}`);
  }

  const adapter = sdk.token(tokenId);
  const entry = TOKEN_REGISTRY[tokenId];

  // Verify recipient has a registered MemoKey
  const recipientMemoKey = await adapter.getMemoKey(recipientAddr);
  if (!recipientMemoKey || (recipientMemoKey.x === 0n && recipientMemoKey.y === 0n)) {
    throw new Error(`sendTip: recipient ${recipientAddr} has no registered MemoKey`);
  }

  let sendResult: SendResult;
  if (entry.variant === "native" || entry.variant === "erc20") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendResult = await (adapter as any).shieldedTransferViaCoa({
      recipient: recipientAddr,
      amount,
      currentBalance,
      currentBlinding,
      memo,
      coaEvmAddr,
    });
  } else {
    // cadence-ft (MockFT): uses FCL internally
    sendResult = await adapter.shieldedTransfer(
      { recipient: recipientAddr, amount, currentBalance, currentBlinding, memo },
      evmSigner
    );
  }

  // Update ShieldedCheckpoint with the sender's new state
  let checkpointTxHash: string;
  if (sendResult.checkpointPayload) {
    const cpClient = new ShieldedCheckpointClient();
    const cpResult = await cpClient.update(sendResult.checkpointPayload, inboxCursor, evmSigner);
    checkpointTxHash = cpResult.txHash;
  } else {
    // Fallback: recompute from local blinding if checkpointPayload is missing
    const newBalance = currentBalance - amount;
    const newBlinding = sendResult.newBlinding ?? generateBlinding();
    const cpClient = new ShieldedCheckpointClient();
    const cpResult = await cpClient.encryptAndUpdate(
      { balance: newBalance, blinding: newBlinding },
      inboxCursor,
      memoKeypair,
      evmSigner
    );
    checkpointTxHash = cpResult.txHash;
  }

  // Persist memo for sender-side /tips view
  if (memo && userCadenceAddr) {
    saveSentMemo({
      sender: userCadenceAddr,
      recipient: recipientAddr,
      memo,
    });
  }

  return {
    txHash: sendResult.txHash,
    checkpointTxHash,
    netToRecipient: amount,
  };
}

// ─── v0.8 Core: unwrapToken ──────────────────────────────────────────────────

export interface UnwrapTokenParams {
  tokenId: TokenId;
  claimedAmount: bigint;
  /** EVM hex recipient address (EVM tokens) or Cadence address (mockft). */
  recipient: string;
  /** Caller's COA EVM hex address (for ViaCoa FCL path). */
  coaEvmAddr: string;
  /** Caller's BabyJub keypair (for checkpoint). */
  memoKeypair: BabyJubKeypair;
  /** Caller's BabyJub privkey (for residual snapshot event). */
  memoPrivkey: bigint;
  /** Current balance from checkpoint (for proof). */
  currentBalance: bigint;
  /** Current blinding from checkpoint (for proof). */
  currentBlinding: bigint;
  /** Inbox cursor from checkpoint metadata. */
  inboxCursor: bigint;
  /** Ethers wallet — needed to update ShieldedCheckpoint after unwrap. */
  evmSigner: ethers.Wallet;
  /** For cadence-ft: the user's Cadence address. */
  userCadenceAddr?: string;
}

export interface UnwrapTokenResult {
  txHash: string;
  checkpointTxHash: string;
  netReceived: bigint;
  /** New CUMULATIVE balance after unwrap (residual). */
  newBalance: bigint;
  newBlinding: bigint;
}

/**
 * Unwrap (claim) from the shielded slot back to the underlying token.
 * Parses the residual state from on-chain event and updates ShieldedCheckpoint.
 */
export async function unwrapToken(params: UnwrapTokenParams): Promise<UnwrapTokenResult> {
  const { tokenId, claimedAmount, recipient, coaEvmAddr, memoKeypair,
    memoPrivkey, currentBalance, currentBlinding, inboxCursor, evmSigner, userCadenceAddr } = params;

  if (claimedAmount > currentBalance) {
    throw new Error(`unwrapToken: insufficient shielded balance: have ${currentBalance}, claimed ${claimedAmount}`);
  }

  const adapter = sdk.token(tokenId);
  const entry = TOKEN_REGISTRY[tokenId];

  let unwrapResult: UnwrapResult;
  if (entry.variant === "native" || entry.variant === "erc20") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unwrapResult = await (adapter as any).unwrapViaCoa({
      claimedAmount,
      recipient,
      currentBalance,
      currentBlinding,
      coaEvmAddr,
    });
  } else if (entry.variant === "cadence-ft" && userCadenceAddr) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unwrapResult = await (adapter as any).unwrapViaCoa({
      claimedAmount,
      recipient,
      currentBalance,
      currentBlinding,
      coaEvmAddr,
      userCadenceAddr,
    });
  } else {
    unwrapResult = await adapter.unwrap(
      { claimedAmount, recipient, currentBalance, currentBlinding },
      evmSigner
    );
  }

  // Residual state: claimedAmount reduces balance, new blinding from on-chain event
  const residualBalance = currentBalance - claimedAmount;
  // Try to get residual blinding from the WrapWithSnapshot-style event (same format for unwrap residual)
  const residualSnap = await parseWrapSnapshot(unwrapResult.txHash, memoPrivkey).catch(() => null);
  const residualBlinding = residualSnap?.blinding ?? generateBlinding();

  // Update ShieldedCheckpoint with residual state
  const cpClient = new ShieldedCheckpointClient();
  const cpResult = await cpClient.encryptAndUpdate(
    { balance: residualBalance, blinding: residualBlinding },
    inboxCursor,
    memoKeypair,
    evmSigner
  );

  return {
    txHash: unwrapResult.txHash,
    checkpointTxHash: cpResult.txHash,
    netReceived: unwrapResult.netToRecipient,
    newBalance: residualBalance,
    newBlinding: residualBlinding,
  };
}

// ─── v0.8 Core: drainInbox ───────────────────────────────────────────────────

export interface DrainInboxResult {
  txHash: string;
  drainedCount: number;
  totalAmount: bigint;
  /** Decrypted notes — includes amount, blinding, optional memo. */
  notes: NoteContent[];
}

/**
 * Drain all pending notes from the caller's ShieldedInbox.
 * Returns decrypted note contents for display in /tips Received.
 *
 * After draining, callers should update ShieldedCheckpoint by accumulating
 * drained note amounts into the current checkpoint balance.
 *
 * @param evmSigner   Ethers wallet (msg.sender = inbox owner for drainAll).
 * @param memoPrivkey Caller's BabyJub private key for ECIES decryption.
 */
export async function drainInbox(
  evmSigner: ethers.Wallet,
  memoPrivkey: bigint
): Promise<DrainInboxResult> {
  const ibClient = new ShieldedInboxClient();
  const result = await ibClient.drainAndDecrypt(evmSigner, memoPrivkey);

  const notes = result.decrypted.map((d) => d.content);
  const totalAmount = notes.reduce((sum, n) => sum + n.amount, 0n);

  return {
    txHash: result.txHash,
    drainedCount: result.notes.length,
    totalAmount,
    notes,
  };
}

// ─── Note helpers (v0.8 SDK passthrough) ─────────────────────────────────────

export { encryptNote, decryptNote };

/**
 * ShieldedNote — legacy shape kept for backward compat with /tips page.
 * Phase 5 will migrate /tips to use NoteContent directly.
 */
export interface ShieldedNote {
  amount: bigint;
  blinding: bigint;
  /** v0.8 memo field (was `data` in v0.7). */
  data?: string;
}

// ─── Fee helpers ─────────────────────────────────────────────────────────────

export function computeNetWrapAmount(grossWei: bigint, feeBps: number): bigint {
  return computeNetWrap(grossWei, feeBps);
}
export function computeWrapFeeAmount(grossWei: bigint, feeBps: number): bigint {
  return computeWrapFee(grossWei, feeBps);
}

export async function fetchFeeBps(tokenId: TokenId = "flow"): Promise<number> {
  const adapter = sdk.token(tokenId);
  return adapter.feeBps();
}

// ─── Legacy address constants ─────────────────────────────────────────────────

/** @deprecated Use TOKEN_REGISTRY.flow.proxy directly. */
export const JANUS_FLOW_EVM = TOKEN_REGISTRY.flow.proxy;
/** @deprecated Use flow.json aliases (JanusFlow → 0x4b6bc58bc8bf5dcc). */
export const JANUS_FLOW_CADENCE = "0x4b6bc58bc8bf5dcc";

// ─── Stub exports (pages rewritten in Phase 3-6; stubs keep build green) ─────
//
// Phase 1 leaves legacy page imports intact. Commit 9 will fix import sites
// in pages — these stubs prevent TypeScript from failing the build now.
//
// NOTE: these throw at RUNTIME (not compile-time) so pages compile fine but
// will surface an error if any legacy code path is actually invoked.

/** @deprecated Use activateAccount(). Replaced in Phase 3 (/status rewrite). */
export async function smartSetupAccount(_opts: { flowAddr: string }): Promise<{ txId: string; pubkey: Point }> {
  // Phase 3 will rewrite /status to use activateAccount() — Phase 1 left this here intentionally.
  throw new Error("smartSetupAccount: not implemented in Phase 1 — wait for Phase 3 (/status rewrite)");
}

// Legacy wrap/send/unwrap shim types — kept so TypeScript doesn't error on page imports.

export interface LegacyWrapParams {
  amountUFix64: string;
  amountWei: bigint;
  source?: "vault" | "coa";
  netAmountForProofWei?: bigint;
  memoKeypair?: BabyJubKeypair;
  evmSigner?: ethers.Wallet;
  tokenId?: TokenId;
  coaEvmAddr?: string;
  userCadenceAddr?: string;
}

export interface LegacyWrapResult {
  txId: string;
  blinding: bigint;
  commitment: Point;
}

/** @deprecated Use wrapToken(). Replaced in Phase 4 (/wrap rewrite). */
export async function wrapActionLegacy(_params: LegacyWrapParams): Promise<LegacyWrapResult> {
  // Phase 4 will rewrite /wrap to use wrapToken() — Phase 1 left this here intentionally.
  throw new Error("wrapActionLegacy: not implemented in Phase 1 — wait for Phase 4 (/wrap rewrite)");
}

export interface SendShieldedTipParams {
  recipientFlowAddr: string;
  recipientCoaHex: string;
  transferAmountWei: bigint;
  oldBalanceWei: bigint;
  oldBlinding: bigint;
  memo?: string;
  recipientMemoPubkey?: Point;
  selfMemoPubkey?: Point;
  tokenId?: TokenId;
  evmSigner?: ethers.Wallet;
  memoKeypair?: BabyJubKeypair;
  senderCoaEvmAddr?: string;
  userCadenceAddr?: string;
}

export interface SendShieldedTipResult {
  txId: string;
  newBlinding: bigint;
  transferBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

/** @deprecated Use sendTip(). Replaced in Phase 5 (/send rewrite). */
export async function sendShieldedTipAction(_params: SendShieldedTipParams): Promise<SendShieldedTipResult> {
  // Phase 5 will rewrite /send to use sendTip() — Phase 1 left this here intentionally.
  throw new Error("sendShieldedTipAction: not implemented in Phase 1 — wait for Phase 5 (/send rewrite)");
}

export interface LegacyUnwrapParams {
  claimedAmountWei: bigint;
  recipientEvmHex: string;
  oldBalanceWei: bigint;
  oldBlinding: bigint;
  memoKeypair?: BabyJubKeypair;
  evmSigner?: ethers.Wallet;
  tokenId?: TokenId;
  coaEvmAddr?: string;
  userCadenceAddr?: string;
}

export interface LegacyUnwrapResult {
  txId: string;
  newBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

/** @deprecated Use unwrapToken(). Replaced in Phase 6 (/claim rewrite). */
export async function unwrapActionLegacy(_params: LegacyUnwrapParams): Promise<LegacyUnwrapResult> {
  // Phase 6 will rewrite /claim to use unwrapToken() — Phase 1 left this here intentionally.
  throw new Error("unwrapActionLegacy: not implemented in Phase 1 — wait for Phase 6 (/claim rewrite)");
}

// ─── Cadence script builders ─────────────────────────────────────────────────
//
// These still reference 0x4b6bc58bc8bf5dcc (v0.8 PrivateTip deployer).

export function buildGetShieldedTipsByRecipientWithMemoScript(): string {
  return `
    import PrivateTip from 0x4b6bc58bc8bf5dcc
    access(all) fun main(recipient: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsByRecipientWithMemo(recipient: recipient)
    }
  `;
}

export function buildGetShieldedTipsBySenderScript(): string {
  return `
    import PrivateTip from 0x4b6bc58bc8bf5dcc
    access(all) fun main(sender: Address): [PrivateTip.TipMetadata] {
      return PrivateTip.getShieldedTipsBySender(sender: sender)
    }
  `;
}

export function buildGetShieldedTipsBySenderWithSnapshotScript(): string {
  return `
    import PrivateTip from 0x4b6bc58bc8bf5dcc
    access(all) fun main(sender: Address): [PrivateTip.TipMetadataWithSenderSnapshot] {
      return PrivateTip.getShieldedTipsBySenderWithSnapshot(sender: sender)
    }
  `;
}

export function buildGetTipCountScript(): string {
  return `
    import PrivateTip from 0x4b6bc58bc8bf5dcc
    access(all) fun main(recipient: Address): UInt64 {
      return PrivateTip.getTipCount(recipient: recipient)
    }
  `;
}

// generateBabyJubKeypair remains available via /api/keypair/generate
export async function generateBabyJubKeypair(): Promise<BabyJubKeypair> {
  const res = await fetch("/api/keypair/generate", { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`generateBabyJubKeypair: ${(err as { error: string }).error ?? res.statusText}`);
  }
  const data = await res.json() as { privkey: string; pubkey: { x: string; y: string } };
  return {
    privkey: BigInt(data.privkey),
    pubkey: { x: BigInt(data.pubkey.x), y: BigInt(data.pubkey.y) },
  };
}
