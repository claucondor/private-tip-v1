/// Tip action helpers — v0.8 (Checkpoint + Inbox + COA-via-FCL signer pattern).
///
/// Architecture (v0.8):
///   - All shielded state is sourced from ShieldedCheckpointClient.readAndDecrypt()
///     (on-chain, per-user encrypted store). No localStorage for balance/blinding.
///   - Incoming notes arrive via ShieldedInbox; drain with drainAndDecrypt().
///   - EVM write ops that need msg.sender (checkpoint updates, inbox drain) require
///     an ethers.Wallet. Pages construct this via createEvmWallet (COA-key-derived).
///   - Cadence-only ops AND account activation go through FCL + COA; no window.ethereum.
///   - activateAccount() uses a single FCL cross-VM tx (TX_PUBLISH_MEMOKEY_XVM) —
///     no MetaMask, no Rainbow, no ethers.BrowserProvider for the activation path.
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
  encryptSnapshot,
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

// ─── Derived EVM read-only signer (VoidSigner keyed by COA address) ──────────

/**
 * Create a read-only VoidSigner for the given EVM address.
 * Used for ShieldedCheckpointClient.readAndDecrypt() which uses staticCall
 * (msg.sender simulation — no real signature required).
 *
 * Do NOT use for write operations; those go through FCL COA Cadence txs.
 */
export function getReadOnlySigner(evmAddr: string): ethers.VoidSigner {
  return new ethers.VoidSigner(evmAddr, getProvider());
}

// ─── Checkpoint helpers (COA / FCL path) ─────────────────────────────────────

/**
 * Read the caller's shielded state from their on-chain ShieldedCheckpoint.
 * Uses a VoidSigner (the COA address) for the owner-gated staticCall — no
 * private key needed, the EVM node simulates msg.sender = coaAddr.
 *
 * v0.8.2: checkpoint is now per-token — callers must supply the token's EVM proxy address.
 * Returns null if no checkpoint exists yet (account not activated / first wrap pending).
 */
export async function getShieldedStateForCoa(
  coaAddr: string,
  memoPrivkey: bigint,
  tokenAddress: string,
): Promise<{ balance: bigint; blinding: bigint; version: bigint; lastConsumedNoteIndex: bigint } | null> {
  const cpClient = new ShieldedCheckpointClient();
  const exists = await cpClient.exists(coaAddr, tokenAddress);
  if (!exists) return null;
  const voidSigner = getReadOnlySigner(coaAddr);
  const snap = await cpClient.readAndDecrypt(tokenAddress, voidSigner as unknown as ethers.Wallet, memoPrivkey);
  if (!snap) return null;
  const meta = await cpClient.metadata(coaAddr, tokenAddress);
  return {
    balance: snap.balance,
    blinding: snap.blinding,
    version: meta.version,
    lastConsumedNoteIndex: meta.lastConsumedNoteIndex,
  };
}

/**
 * Encrypt a snapshot and update the ShieldedCheckpoint via COA Cadence tx (FCL).
 * This is the browser-safe path — no raw EVM private key needed.
 * The COA is msg.sender for the EVM ShieldedCheckpoint.update() call.
 *
 * v0.8.2: checkpoint is now per-token. Pass the token's EVM proxy address as
 * `tokenAddress`. For cadence-ft (MockFT), pass the cadenceAddress as the token
 * identifier (per-token Cadence ShieldedCheckpoint is live at 0xd1a02aa46d9151bb).
 *
 * @param snapshot    { balance, blinding } to persist.
 * @param cursor      lastConsumedNoteIndex (inbox drain cursor).
 * @param memoKeypair Caller's BabyJub keypair (pubkey used for ECIES encryption).
 * @param tokenAddress EVM proxy or cadence address of the token.
 * @returns Cadence tx ID (not an EVM hash).
 */
export async function encryptAndUpdateCheckpointViaCoa(
  snapshot: { balance: bigint; blinding: bigint },
  cursor: bigint,
  memoKeypair: BabyJubKeypair,
  tokenAddress: string,
): Promise<string> {
  const enc = await encryptSnapshot(snapshot, memoKeypair.pubkey);
  const fcl = await getFcl();
  const txId: string = await fcl.mutate({
    cadence: cadenceTx.updateCheckpointViaCoa(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; UInt256: unknown; UInt64: unknown }) => [
      arg(tokenAddress, t.String),
      arg(ethers.hexlify(enc.ciphertext).slice(2), t.String),
      arg(enc.ephemeralPubkey.x.toString(), t.UInt256),
      arg(enc.ephemeralPubkey.y.toString(), t.UInt256),
      arg(cursor.toString(), t.UInt64),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
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

// ─── ABI fragments for client-side EVM calldata encoding (atomic tx pattern) ──

const JANUS_FLOW_IFACE = new ethers.Interface([
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
]);

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// UFix64 helper — converts attoflow (wei) bigint to Flow UFix64 string (8 dec places)
function toUFix64(attoflow: bigint): string {
  const FLOW_SCALE_F = 10n ** 18n;
  const UFIX64_FRAC  = 10n ** 10n;
  const whole        = attoflow / FLOW_SCALE_F;
  const fracAttoflow = attoflow % FLOW_SCALE_F;
  const fracUfix64   = fracAttoflow / UFIX64_FRAC;
  return `${whole}.${fracUfix64.toString().padStart(8, "0")}`;
}

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
   * Transaction ID of the Cross-VM Cadence tx that published the BabyJub pubkey
   * to both Cadence storage and the EVM MemoKeyRegistry via the user's COA.
   * null if skipped (key already published — idempotent check).
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
 * Account activation (v0.8, all idempotent). Single Flow Wallet path — NO window.ethereum.
 *
 * 1. Publish BabyJub pubkey to Cadence storage + EVM MemoKeyRegistry via a single
 *    FCL cross-VM Cadence transaction (TX_PUBLISH_MEMOKEY_XVM). The user's COA is
 *    msg.sender for the EVM call — no MetaMask, no Rainbow, no ethers.BrowserProvider.
 * 2. Install ShieldedInbox + ShieldedCheckpoint Cadence resources via FCL (idempotent).
 *
 * @param flowAddr Caller's Cadence address.
 * @param keypair  BabyJub keypair (privkey + pubkey). Derive via getOrDeriveMemoPrivkey
 *                 + pubkeyFromPrivkey before calling this.
 */
export async function activateAccount(
  flowAddr: string,
  keypair: { privkey: bigint; pubkey: Point },
): Promise<ActivateAccountResult> {
  const fcl = await getFcl();

  // Idempotent check: skip entirely only if BOTH memoKey AND resources are present.
  const coaAddr = await sdkGetCoaEvmAddress(flowAddr, "testnet").catch(() => null);
  const adapter = sdk.token("flow");
  const [existingKey, cpExists, ibCountOk] = await Promise.all([
    coaAddr ? adapter.getMemoKey(coaAddr).catch(() => null) : Promise.resolve(null),
    coaAddr ? new ShieldedCheckpointClient().exists(coaAddr, TOKEN_REGISTRY.flow.proxy) : Promise.resolve(false),
    coaAddr
      ? new ShieldedInboxClient().count(coaAddr).then(() => true).catch(() => false)
      : Promise.resolve(false),
  ]);

  const memoKeyPublished = existingKey && !(existingKey.x === 0n && existingKey.y === 0n);
  if (memoKeyPublished && cpExists && ibCountOk) {
    // Fully configured — skip wallet popup.
    return { memoKeyTxHash: null, installTxId: null, pubkey: keypair.pubkey };
  }

  // Submit a single atomic FCL tx: memoKey publish + inbox + checkpoint install.
  // TX_ACTIVATE_ACCOUNT_ATOMIC is a local template (no SDK equivalent) — inlined here.
  const TX_ACTIVATE_ACCOUNT_ATOMIC = `
import JanusFT from 0x4b6bc58bc8bf5dcc
import JanusFlow from 0x5dcbeb41055ec57e
import ShieldedInbox from 0x4b6bc58bc8bf5dcc
import ShieldedCheckpoint from 0xd1a02aa46d9151bb
import EVM from 0x8c5303eaa26202d6

transaction(memoPubX: UInt256, memoPubY: UInt256) {
  prepare(signer: auth(BorrowValue, Storage, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

    // ── 1. Publish MemoKey to Cadence storage ──────────────────────────────────
    JanusFT.publishMemoKey(
      account: signer,
      pubkeyX: memoPubX,
      pubkeyY: memoPubY
    )

    // ── 2. Publish MemoKey to EVM MemoKeyRegistry via COA ─────────────────────
    let coa = signer.storage
      .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("activate_account_atomic: no COA at /storage/evm")

    let memoRegistryAddr = EVM.addressFromString("0x361bD4d037838A3a9c5408AE465d36077800ee6c")

    let memoCalldata = EVM.encodeABIWithSignature(
      "publishMemoKey(uint256,uint256)",
      [memoPubX, memoPubY]
    )

    let memoResult = coa.call(
      to: memoRegistryAddr,
      data: memoCalldata,
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )

    assert(
      memoResult.status == EVM.Status.successful,
      message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
        .concat(memoResult.errorCode.toString())
        .concat(" ")
        .concat(memoResult.errorMessage)
    )

    // ── NoteInbox ──────────────────────────────────────────────────────────────
    let inboxStoragePath = /storage/shieldedInbox
    let inboxPublicPath  = /public/shieldedInbox

    let inboxType = signer.storage.type(at: inboxStoragePath)
    if inboxType != Type<@ShieldedInbox.NoteInbox>() {
      if inboxType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: inboxStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale inbox resource vanished")
        destroy stale
      }
      let inbox <- ShieldedInbox.createInbox(owner: signer.address)
      signer.storage.save(<- inbox, to: inboxStoragePath)
    }
    signer.capabilities.unpublish(inboxPublicPath)
    let inboxCap = signer.capabilities.storage.issue<&{ShieldedInbox.Receiver}>(inboxStoragePath)
    signer.capabilities.publish(inboxCap, at: inboxPublicPath)

    // ── Checkpoint ──────────────────────────────────────────────────────────────
    let cpStoragePath = /storage/shieldedCheckpoint
    let cpPublicPath  = /public/shieldedCheckpoint

    let cpType = signer.storage.type(at: cpStoragePath)
    if cpType != Type<@ShieldedCheckpoint.Checkpoint>() {
      if cpType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: cpStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale checkpoint resource vanished")
        destroy stale
      }
      let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
      signer.storage.save(<- cp, to: cpStoragePath)
    }
    signer.capabilities.unpublish(cpPublicPath)
    let cpCap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(cpStoragePath)
    signer.capabilities.publish(cpCap, at: cpPublicPath)
  }
}
`;
  const atomicTxId: string = await fcl.mutate({
    cadence: TX_ACTIVATE_ACCOUNT_ATOMIC,
    args: (arg: (v: string, t: unknown) => unknown, t: { UInt256: unknown }) => [
      arg(keypair.pubkey.x.toString(), t.UInt256),
      arg(keypair.pubkey.y.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(atomicTxId).onceSealed();

  return { memoKeyTxHash: atomicTxId, installTxId: atomicTxId, pubkey: keypair.pubkey };
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
  memoPrivkey: bigint,
  tokenAddress: string = TOKEN_REGISTRY.flow.proxy,
): Promise<ShieldedTokenState | null> {
  const cpClient = new ShieldedCheckpointClient();
  const snapshot = await cpClient.readAndDecrypt(tokenAddress, evmSigner, memoPrivkey);
  if (!snapshot) return null;

  const meta = await cpClient.metadata(evmSigner.address, tokenAddress);
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
  /** Ethers wallet — UNUSED in v0.8 (checkpoint writes via FCL COA). Kept for backward compat. */
  evmSigner?: ethers.Wallet | null;
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
 * Browser-safe path: proof is generated server-side via /api/proof/wrap.
 * EVM writes go through FCL COA Cadence txs (no raw EVM private key needed).
 *
 * For ERC20 (mUSDC): wrapViaCoa handles approve+wrap atomically in one Cadence tx.
 * For MockFT (cadence-ft): wrapViaCoa uses user's Cadence address and COA address.
 */
export async function wrapToken(params: WrapTokenParams): Promise<WrapTokenResult> {
  const { tokenId, grossAmount, coaEvmAddr, memoKeypair,
    prevBalance, prevBlinding, prevCursor, userCadenceAddr } = params;

  const adapter = sdk.token(tokenId);
  const entry = TOKEN_REGISTRY[tokenId];

  // Step 1: Compute net amount and generate marginal blinding locally.
  const feeBps = await adapter.feeBps();
  const netAmount = computeNetWrap(grossAmount, feeBps);
  const marginalBlinding = generateBlinding();

  // Step 2: Generate AmountDisclose Groth16 proof server-side (Node.js required).
  // POST to /api/proof/wrap with netAmount + marginalBlinding → get proof + txCommit.
  const proofResp = await fetch("/api/proof/wrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: netAmount.toString(),
      blinding: marginalBlinding.toString(),
    }),
  });
  if (!proofResp.ok) {
    const errText = await proofResp.text().catch(() => proofResp.statusText);
    throw new Error(`wrapToken: proof generation failed (${proofResp.status}): ${errText}`);
  }
  const proofData = await proofResp.json() as {
    proof: string[];
    publicInputs: string[];
    nonce: string;
    txCommit: string[];
    blinding: string;
  };
  const prebuiltProof = {
    proof:        proofData.proof.map(BigInt),
    txCommit:     proofData.txCommit.map(BigInt) as [bigint, bigint],
    blinding:     marginalBlinding,        // use the locally generated value (server echoes it)
    nonce:        BigInt(proofData.nonce),
    publicInputs: proofData.publicInputs.map(BigInt),
  };

  // Detect "fresh slot" — if the on-chain commitment is the identity point
  // (admin reset / first-ever wrap), any local checkpoint state is stale and
  // must be ignored. Otherwise accumulation produces a C_new that does not
  // match what the on-chain proof verifier expects.
  //
  // Address type depends on the token variant:
  //   - native / erc20: EVM contracts → COA EVM address (20 bytes)
  //   - cadence-ft:     Cadence contract → user's Cadence address (8 bytes)
  const stateAddrForCommit =
    entry.variant === "cadence-ft" && userCadenceAddr
      ? userCadenceAddr
      : coaEvmAddr;
  const onChainCommit = await adapter
    .getCommitment(stateAddrForCommit)
    .catch(() => ({ x: 0n, y: 1n }));
  const isFreshSlot = onChainCommit.x === 0n && onChainCommit.y === 1n;
  const effectivePrevBalance = isFreshSlot ? 0n : prevBalance;
  const effectivePrevBlinding = isFreshSlot ? 0n : prevBlinding;
  const effectivePrevCursor = isFreshSlot ? 0n : prevCursor;

  // Accumulate marginal state into cumulative checkpoint state (needed for all paths).
  const newBalance = effectivePrevBalance + netAmount;
  const newBlinding = (effectivePrevBlinding + marginalBlinding) % BABYJUB_SUBORDER;

  if (entry.variant === "native") {
    // ── Atomic path: wrap + checkpoint in a single FCL tx ──────────────────────
    // 1. Encrypt the marginal snapshot (embedded in wrapWithProof calldata for the
    //    on-chain WrapWithSnapshot event — uses marginal balance/blinding only).
    const margSnap = await encryptSnapshot(
      { balance: netAmount, blinding: marginalBlinding },
      memoKeypair.pubkey,
    );

    // 2. Encrypt the cumulative checkpoint snapshot (persisted to ShieldedCheckpoint).
    const cpSnap = await encryptSnapshot(
      { balance: newBalance, blinding: newBlinding },
      memoKeypair.pubkey,
    );

    // 3. Build wrapWithProof calldata (client-side ABI encoding).
    const proof = prebuiltProof.proof;
    const wrapCalldata = JANUS_FLOW_IFACE.encodeFunctionData("wrapWithProof", [
      prebuiltProof.nonce,
      [prebuiltProof.txCommit[0], prebuiltProof.txCommit[1]],
      [proof[0], proof[1]],                                          // pA
      [[proof[2], proof[3]], [proof[4], proof[5]]],                  // pB
      [proof[6], proof[7]],                                          // pC
      ethers.hexlify(margSnap.ciphertext),
      margSnap.ephemeralPubkey.x,
      margSnap.ephemeralPubkey.y,
    ]);
    const wrapCalldataHex = wrapCalldata.slice(2);

    // 4. Submit one FCL tx: wrap + checkpoint atomically.
    // cadenceTx.wrapFlowAtomic(tokenAddrHex) from SDK — uses new per-token ShieldedCheckpoint.
    const fcl = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicTxId: string = await fcl.mutate({
      cadence: cadenceTx.wrapFlowAtomic(TOKEN_REGISTRY.flow.proxy),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { UFix64: unknown; UInt: unknown; String: unknown; Array: (t: unknown) => unknown; UInt8: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(toUFix64(grossAmount), t.UFix64),
        arg(grossAmount.toString(), t.UInt),
        arg(wrapCalldataHex, t.String),
        arg(ethers.hexlify(cpSnap.ciphertext).slice(2), t.String),
        arg(cpSnap.ephemeralPubkey.x.toString(), t.UInt256),
        arg(cpSnap.ephemeralPubkey.y.toString(), t.UInt256),
        arg(effectivePrevCursor.toString(), t.UInt64),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(atomicTxId).onceSealed();

    return {
      txHash: atomicTxId,
      checkpointTxHash: atomicTxId,
      newBalance,
      newBlinding,
    };
  }

  if (entry.variant === "erc20") {
    // ── Atomic path: ERC20 approve + wrap + checkpoint in one FCL tx ─────────
    const margSnapErc20 = await encryptSnapshot(
      { balance: netAmount, blinding: marginalBlinding },
      memoKeypair.pubkey,
    );
    const cpSnapErc20 = await encryptSnapshot(
      { balance: newBalance, blinding: newBlinding },
      memoKeypair.pubkey,
    );
    const proof = prebuiltProof.proof;
    const wrapCalldataErc20 = JANUS_FLOW_IFACE.encodeFunctionData("wrapWithProof", [
      prebuiltProof.nonce,
      [prebuiltProof.txCommit[0], prebuiltProof.txCommit[1]],
      [proof[0], proof[1]],
      [[proof[2], proof[3]], [proof[4], proof[5]]],
      [proof[6], proof[7]],
      ethers.hexlify(margSnapErc20.ciphertext),
      margSnapErc20.ephemeralPubkey.x,
      margSnapErc20.ephemeralPubkey.y,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const erc20ProxyHex = (entry as any).proxy as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const erc20UnderlyingHex = (entry as any).underlying as string;
    const approveCalldata = ERC20_IFACE.encodeFunctionData("approve", [erc20ProxyHex, grossAmount]);
    const fclErc20 = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicErc20WrapId: string = await fclErc20.mutate({
      cadence: cadenceTx.wrapErc20Atomic(erc20ProxyHex),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(approveCalldata.slice(2), t.String),
        arg(wrapCalldataErc20.slice(2), t.String),
        arg(erc20UnderlyingHex, t.String),
        arg(erc20ProxyHex, t.String),
        arg(ethers.hexlify(cpSnapErc20.ciphertext).slice(2), t.String),
        arg(cpSnapErc20.ephemeralPubkey.x.toString(), t.UInt256),
        arg(cpSnapErc20.ephemeralPubkey.y.toString(), t.UInt256),
        arg(effectivePrevCursor.toString(), t.UInt64),
      ],
      proposer: fclErc20.authz,
      payer: fclErc20.authz,
      authorizations: [fclErc20.authz],
      limit: 9999,
    });
    await fclErc20.tx(atomicErc20WrapId).onceSealed();
    return { txHash: atomicErc20WrapId, checkpointTxHash: atomicErc20WrapId, newBalance, newBlinding };
  }

  // ── Atomic path: cadence-ft (MockFT) wrap + checkpoint in one FCL tx ────────
  if (!userCadenceAddr) {
    throw new Error("wrapToken: userCadenceAddr required for cadence-ft");
  }
  const margSnapFt = await encryptSnapshot(
    { balance: netAmount, blinding: marginalBlinding },
    memoKeypair.pubkey,
  );
  const cpSnapFt = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding },
    memoKeypair.pubkey,
  );
  const proofFt = prebuiltProof.proof;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftTokenAddrHex = (entry as any).cadenceAddress as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftContractNameVal = (entry as any).ftContractName as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftAddressVal = (entry as any).ftAddress as string;
  const fclFt = await getFcl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atomicFtWrapId: string = await fclFt.mutate({
    cadence: cadenceTx.wrapFtAtomic(ftTokenAddrHex, ftTokenAddrHex, ftContractNameVal, ftAddressVal),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (arg: (v: unknown, t: unknown) => unknown, t: { Address: unknown; UFix64: unknown; UInt256: unknown; Array: (t: unknown) => unknown; UInt8: unknown; String: unknown; UInt64: unknown }) => [
      arg(userCadenceAddr, t.Address),
      arg(toUFix64(grossAmount), t.UFix64),
      arg(prebuiltProof.nonce.toString(), t.UInt256),
      arg(prebuiltProof.txCommit[0].toString(), t.UInt256),
      arg(prebuiltProof.txCommit[1].toString(), t.UInt256),
      arg([proofFt[0].toString(), proofFt[1].toString()], t.Array(t.UInt256)),
      arg([[proofFt[2].toString(), proofFt[3].toString()], [proofFt[4].toString(), proofFt[5].toString()]], t.Array(t.Array(t.UInt256))),
      arg([proofFt[6].toString(), proofFt[7].toString()], t.Array(t.UInt256)),
      arg(Array.from(margSnapFt.ciphertext).map(String), t.Array(t.UInt8)),
      arg(margSnapFt.ephemeralPubkey.x.toString(), t.UInt256),
      arg(margSnapFt.ephemeralPubkey.y.toString(), t.UInt256),
      arg(ethers.hexlify(cpSnapFt.ciphertext).slice(2), t.String),
      arg(cpSnapFt.ephemeralPubkey.x.toString(), t.UInt256),
      arg(cpSnapFt.ephemeralPubkey.y.toString(), t.UInt256),
      arg(effectivePrevCursor.toString(), t.UInt64),
    ],
    proposer: fclFt.authz,
    payer: fclFt.authz,
    authorizations: [fclFt.authz],
    limit: 9999,
  });
  await fclFt.tx(atomicFtWrapId).onceSealed();
  return { txHash: atomicFtWrapId, checkpointTxHash: atomicFtWrapId, newBalance, newBlinding };
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
    userCadenceAddr, currentBalance, currentBlinding, inboxCursor } = params;

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

  if (entry.variant === "native") {
    // ── Atomic path: shieldedTransfer + checkpoint in a single FCL tx ──────────
    // 1. Generate blindings for transfer note and sender's residual commitment.
    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    // 2. Generate shielded-transfer proof server-side (Node.js WASM circuit).
    const stResp = await fetch("/api/proof/shielded-transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldBalance:       currentBalance.toString(),
        oldBlinding:      currentBlinding.toString(),
        transferAmount:   amount.toString(),
        transferBlinding: transferBlinding.toString(),
        newBlinding:      newBlinding.toString(),
      }),
    });
    if (!stResp.ok) {
      const errText = await stResp.text().catch(() => stResp.statusText);
      throw new Error(`sendTip: proof generation failed (${stResp.status}): ${errText}`);
    }
    const stProof = await stResp.json() as { proof: string[]; publicInputs: string[] };
    const publicInputsBigint = stProof.publicInputs.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint];
    const proofBigint        = stProof.proof.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

    // 3. Encrypt note for recipient (ECIES — uses their MemoKey pubkey).
    const noteEnc = await encryptNote(
      { amount, blinding: transferBlinding, memo },
      recipientMemoKey,
    );

    // 4. Compute sender's new balance and encrypt sender's residual snapshot.
    const newBalance = currentBalance - amount;
    const snapEnc = await encryptSnapshot(
      { balance: newBalance, blinding: newBlinding },
      memoKeypair.pubkey,
    );

    // 5. Build shieldedTransfer calldata (complex ABI — pre-encode client-side).
    const transferCalldata = JANUS_FLOW_IFACE.encodeFunctionData("shieldedTransfer", [
      recipientAddr,
      publicInputsBigint,
      proofBigint,
      ethers.hexlify(noteEnc.ciphertext),
      noteEnc.ephemeralPubkey.x,
      noteEnc.ephemeralPubkey.y,
    ]);
    const transferCalldataHex = transferCalldata.slice(2);

    // 6. Submit one FCL tx: shieldedTransfer + checkpoint atomically.
    // cadenceTx.sendTipAtomic(tokenAddrHex) from SDK — uses new per-token ShieldedCheckpoint.
    // Route by tokenId (C.2): derive proxy from entry, not hardcoded to FLOW.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendAtomicProxy = (entry as any).proxy as string;
    const fcl = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicTxId: string = await fcl.mutate({
      cadence: cadenceTx.sendTipAtomic(sendAtomicProxy),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; Array: (t: unknown) => unknown; UInt8: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(transferCalldataHex, t.String),
        arg(sendAtomicProxy, t.String),
        arg(ethers.hexlify(snapEnc.ciphertext).slice(2), t.String),
        arg(snapEnc.ephemeralPubkey.x.toString(), t.UInt256),
        arg(snapEnc.ephemeralPubkey.y.toString(), t.UInt256),
        arg(inboxCursor.toString(), t.UInt64),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(atomicTxId).onceSealed();

    // Persist memo for sender-side /tips view
    if (memo && userCadenceAddr) {
      saveSentMemo({ sender: userCadenceAddr, recipient: recipientAddr, memo });
    }

    return { txHash: atomicTxId, checkpointTxHash: atomicTxId, netToRecipient: amount };
  }

  // ── Atomic path: ERC20 / cadence-ft sendTip + checkpoint in one FCL tx ──────
  // Common: generate blindings + proof (circuit is token-agnostic).
  const stTransferBlinding = generateBlinding();
  const stNewBlinding = generateBlinding();

  const stResp = await fetch("/api/proof/shielded-transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oldBalance:       currentBalance.toString(),
      oldBlinding:      currentBlinding.toString(),
      transferAmount:   amount.toString(),
      transferBlinding: stTransferBlinding.toString(),
      newBlinding:      stNewBlinding.toString(),
    }),
  });
  if (!stResp.ok) {
    const errText = await stResp.text().catch(() => stResp.statusText);
    throw new Error(`sendTip: proof generation failed (${stResp.status}): ${errText}`);
  }
  const stProofData = await stResp.json() as { proof: string[]; publicInputs: string[] };
  const stPublicInputsBn = stProofData.publicInputs.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint];
  const stProofBn        = stProofData.proof.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  const stNoteEnc = await encryptNote(
    { amount, blinding: stTransferBlinding, memo },
    recipientMemoKey,
  );
  const stNewBalance = currentBalance - amount;
  const stSnapEnc = await encryptSnapshot(
    { balance: stNewBalance, blinding: stNewBlinding },
    memoKeypair.pubkey,
  );

  if (entry.variant === "erc20") {
    // ERC20: sendTipErc20Atomic — shieldedTransfer + checkpoint in one FCL tx
    const stCalldata = JANUS_FLOW_IFACE.encodeFunctionData("shieldedTransfer", [
      recipientAddr,
      stPublicInputsBn,
      stProofBn,
      ethers.hexlify(stNoteEnc.ciphertext),
      stNoteEnc.ephemeralPubkey.x,
      stNoteEnc.ephemeralPubkey.y,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const erc20SendProxy = (entry as any).proxy as string;
    const fclSendErc20 = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicErc20SendId: string = await fclSendErc20.mutate({
      cadence: cadenceTx.sendTipErc20Atomic(erc20SendProxy),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(stCalldata.slice(2), t.String),
        arg(ethers.hexlify(stSnapEnc.ciphertext).slice(2), t.String),
        arg(stSnapEnc.ephemeralPubkey.x.toString(), t.UInt256),
        arg(stSnapEnc.ephemeralPubkey.y.toString(), t.UInt256),
        arg(inboxCursor.toString(), t.UInt64),
      ],
      proposer: fclSendErc20.authz,
      payer: fclSendErc20.authz,
      authorizations: [fclSendErc20.authz],
      limit: 9999,
    });
    await fclSendErc20.tx(atomicErc20SendId).onceSealed();
    if (memo && userCadenceAddr) saveSentMemo({ sender: userCadenceAddr, recipient: recipientAddr, memo });
    return { txHash: atomicErc20SendId, checkpointTxHash: atomicErc20SendId, netToRecipient: amount };
  }

  // cadence-ft: sendTipFtAtomic — JanusFT.shieldedTransfer + checkpoint in one FCL tx
  if (!userCadenceAddr) throw new Error("sendTip: userCadenceAddr required for cadence-ft");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftSendTokenAddr = (entry as any).cadenceAddress as string;
  const fclSendFt = await getFcl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atomicFtSendId: string = await fclSendFt.mutate({
    cadence: cadenceTx.sendTipFtAtomic(ftSendTokenAddr, ftSendTokenAddr),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (arg: (v: unknown, t: unknown) => unknown, t: { Address: unknown; Array: (t: unknown) => unknown; UInt256: unknown; UInt8: unknown; String: unknown; UInt64: unknown }) => [
      arg(userCadenceAddr, t.Address),
      arg(recipientAddr, t.Address),
      arg(stProofBn.map(String), t.Array(t.UInt256)),
      arg(stPublicInputsBn.map(String), t.Array(t.UInt256)),
      arg(Array.from(stNoteEnc.ciphertext).map(String), t.Array(t.UInt8)),
      arg(stNoteEnc.ephemeralPubkey.x.toString(), t.UInt256),
      arg(stNoteEnc.ephemeralPubkey.y.toString(), t.UInt256),
      arg(ethers.hexlify(stSnapEnc.ciphertext).slice(2), t.String),
      arg(stSnapEnc.ephemeralPubkey.x.toString(), t.UInt256),
      arg(stSnapEnc.ephemeralPubkey.y.toString(), t.UInt256),
      arg(inboxCursor.toString(), t.UInt64),
    ],
    proposer: fclSendFt.authz,
    payer: fclSendFt.authz,
    authorizations: [fclSendFt.authz],
    limit: 9999,
  });
  await fclSendFt.tx(atomicFtSendId).onceSealed();
  if (memo && userCadenceAddr) saveSentMemo({ sender: userCadenceAddr, recipient: recipientAddr, memo });
  return { txHash: atomicFtSendId, checkpointTxHash: atomicFtSendId, netToRecipient: amount };
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
  const { tokenId, claimedAmount, recipient, coaEvmAddr: _coaEvmAddr, memoKeypair,
    memoPrivkey: _memoPrivkey, currentBalance, currentBlinding, inboxCursor, userCadenceAddr } = params;

  if (claimedAmount > currentBalance) {
    throw new Error(`unwrapToken: insufficient shielded balance: have ${currentBalance}, claimed ${claimedAmount}`);
  }

  const entry = TOKEN_REGISTRY[tokenId];

  if (entry.variant === "native") {
    // ── Atomic path: unwrap + checkpoint in a single FCL tx ────────────────────
    // 1. Generate blindings: claimed portion + residual commitment.
    const claimedBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    // 2. Generate unwrap proof server-side (amountDisclose + shieldedTransfer proofs).
    const uwResp = await fetch("/api/proof/unwrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldBalance:     currentBalance.toString(),
        oldBlinding:    currentBlinding.toString(),
        claimedAmount:  claimedAmount.toString(),
        claimedBlinding: claimedBlinding.toString(),
        newBlinding:    newBlinding.toString(),
      }),
    });
    if (!uwResp.ok) {
      const errText = await uwResp.text().catch(() => uwResp.statusText);
      throw new Error(`unwrapToken: proof generation failed (${uwResp.status}): ${errText}`);
    }
    const uwProof = await uwResp.json() as {
      amountDisclose: { proof: string[]; publicInputs: string[] };
      transfer:       { proof: string[]; publicInputs: string[] };
    };

    // txCommit comes from amountDisclose publicInputs: [amount, commitX, commitY, nonce]
    const txCommit: [bigint, bigint] = [
      BigInt(uwProof.amountDisclose.publicInputs[1]),
      BigInt(uwProof.amountDisclose.publicInputs[2]),
    ];

    // 3. Compute residual balance and encrypt residual snapshot (embedded in unwrap calldata).
    const residualBalance = currentBalance - claimedAmount;
    const residualSnap = await encryptSnapshot(
      { balance: residualBalance, blinding: newBlinding },
      memoKeypair.pubkey,
    );

    // 4. Build unwrap calldata (complex ABI — pre-encode client-side).
    const unwrapCalldata = JANUS_FLOW_IFACE.encodeFunctionData("unwrap", [
      claimedAmount,
      recipient,
      txCommit,
      uwProof.amountDisclose.proof.map(BigInt),
      uwProof.transfer.publicInputs.map(BigInt),
      uwProof.transfer.proof.map(BigInt),
      ethers.hexlify(residualSnap.ciphertext),
      residualSnap.ephemeralPubkey.x,
      residualSnap.ephemeralPubkey.y,
    ]);
    const unwrapCalldataHex = unwrapCalldata.slice(2);

    // 5. Encrypt checkpoint snapshot with fresh ephemeral keys (different from residualSnap).
    const cpSnap = await encryptSnapshot(
      { balance: residualBalance, blinding: newBlinding },
      memoKeypair.pubkey,
    );

    // 6. Submit one FCL tx: unwrap + checkpoint atomically.
    // cadenceTx.unwrapFlowAtomic(tokenAddrHex) from SDK — uses new per-token ShieldedCheckpoint.
    // Route by tokenId (C.2): derive proxy from entry, not hardcoded to FLOW.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unwrapAtomicProxy = (entry as any).proxy as string;
    const fcl = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicTxId: string = await fcl.mutate({
      cadence: cadenceTx.unwrapFlowAtomic(unwrapAtomicProxy),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; Array: (t: unknown) => unknown; UInt8: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(unwrapCalldataHex, t.String),
        arg(ethers.hexlify(cpSnap.ciphertext).slice(2), t.String),
        arg(cpSnap.ephemeralPubkey.x.toString(), t.UInt256),
        arg(cpSnap.ephemeralPubkey.y.toString(), t.UInt256),
        arg(inboxCursor.toString(), t.UInt64),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(atomicTxId).onceSealed();

    return {
      txHash: atomicTxId,
      checkpointTxHash: atomicTxId,
      netReceived: claimedAmount,
      newBalance: residualBalance,
      newBlinding,
    };
  }

  // ── Atomic path: ERC20 / cadence-ft unwrap + checkpoint in one FCL tx ───────
  // Generate blindings BEFORE proof call so they match the proof circuit inputs.
  const uwClaimedBlinding = generateBlinding();
  const uwNewBlinding = generateBlinding(); // residual blinding — NOT re-generated after proof

  const uwResp2 = await fetch("/api/proof/unwrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oldBalance:      currentBalance.toString(),
      oldBlinding:     currentBlinding.toString(),
      claimedAmount:   claimedAmount.toString(),
      claimedBlinding: uwClaimedBlinding.toString(),
      newBlinding:     uwNewBlinding.toString(),
    }),
  });
  if (!uwResp2.ok) {
    const errText = await uwResp2.text().catch(() => uwResp2.statusText);
    throw new Error(`unwrapToken: proof generation failed (${uwResp2.status}): ${errText}`);
  }
  const uwProof2 = await uwResp2.json() as {
    amountDisclose: { proof: string[]; publicInputs: string[] };
    transfer:       { proof: string[]; publicInputs: string[] };
  };

  const uwResidualBalance = currentBalance - claimedAmount;
  // Blinding fix (was generateBlinding()): use locally-tracked uwNewBlinding that
  // was fed to the proof circuit — ensures the residual commitment is provably correct.
  const uwResidualBlinding = uwNewBlinding;

  if (entry.variant === "erc20") {
    // ERC20: unwrapErc20Atomic — unwrap + checkpoint in one FCL tx
    const uwTxCommitErc20: [bigint, bigint] = [
      BigInt(uwProof2.amountDisclose.publicInputs[1]),
      BigInt(uwProof2.amountDisclose.publicInputs[2]),
    ];
    const uwResidualSnap = await encryptSnapshot(
      { balance: uwResidualBalance, blinding: uwResidualBlinding },
      memoKeypair.pubkey,
    );
    const uwCpSnap = await encryptSnapshot(
      { balance: uwResidualBalance, blinding: uwResidualBlinding },
      memoKeypair.pubkey,
    );
    const uwCalldata = JANUS_FLOW_IFACE.encodeFunctionData("unwrap", [
      claimedAmount,
      recipient,
      uwTxCommitErc20,
      uwProof2.amountDisclose.proof.map(BigInt),
      uwProof2.transfer.publicInputs.map(BigInt),
      uwProof2.transfer.proof.map(BigInt),
      ethers.hexlify(uwResidualSnap.ciphertext),
      uwResidualSnap.ephemeralPubkey.x,
      uwResidualSnap.ephemeralPubkey.y,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const erc20UnwrapProxy = (entry as any).proxy as string;
    const fclUnwrapErc20 = await getFcl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atomicErc20UnwrapId: string = await fclUnwrapErc20.mutate({
      cadence: cadenceTx.unwrapErc20Atomic(erc20UnwrapProxy),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; UInt256: unknown; UInt64: unknown }) => [
        arg(uwCalldata.slice(2), t.String),
        arg(ethers.hexlify(uwCpSnap.ciphertext).slice(2), t.String),
        arg(uwCpSnap.ephemeralPubkey.x.toString(), t.UInt256),
        arg(uwCpSnap.ephemeralPubkey.y.toString(), t.UInt256),
        arg(inboxCursor.toString(), t.UInt64),
      ],
      proposer: fclUnwrapErc20.authz,
      payer: fclUnwrapErc20.authz,
      authorizations: [fclUnwrapErc20.authz],
      limit: 9999,
    });
    await fclUnwrapErc20.tx(atomicErc20UnwrapId).onceSealed();
    return {
      txHash: atomicErc20UnwrapId,
      checkpointTxHash: atomicErc20UnwrapId,
      netReceived: claimedAmount,
      newBalance: uwResidualBalance,
      newBlinding: uwResidualBlinding,
    };
  }

  // cadence-ft: unwrapFtAtomic — JanusFT.unwrap + checkpoint in one FCL tx
  if (!userCadenceAddr) throw new Error("unwrapToken: userCadenceAddr required for cadence-ft");
  const uwTxCommitFt: [bigint, bigint] = [
    BigInt(uwProof2.amountDisclose.publicInputs[1]),
    BigInt(uwProof2.amountDisclose.publicInputs[2]),
  ];
  const uwFtResidualSnap = await encryptSnapshot(
    { balance: uwResidualBalance, blinding: uwResidualBlinding },
    memoKeypair.pubkey,
  );
  const uwFtCpSnap = await encryptSnapshot(
    { balance: uwResidualBalance, blinding: uwResidualBlinding },
    memoKeypair.pubkey,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftUnwrapTokenAddr = (entry as any).cadenceAddress as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftUnwrapContractName = (entry as any).ftContractName as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ftUnwrapFtAddress = (entry as any).ftAddress as string;
  const fclUnwrapFt = await getFcl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atomicFtUnwrapId: string = await fclUnwrapFt.mutate({
    cadence: cadenceTx.unwrapFtAtomic(ftUnwrapTokenAddr, ftUnwrapTokenAddr, ftUnwrapContractName, ftUnwrapFtAddress),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (arg: (v: unknown, t: unknown) => unknown, t: { Address: unknown; UFix64: unknown; UInt256: unknown; Array: (t: unknown) => unknown; UInt8: unknown; String: unknown; UInt64: unknown }) => [
      arg(userCadenceAddr, t.Address),
      arg(toUFix64(claimedAmount), t.UFix64),
      arg(recipient, t.Address),
      arg(uwTxCommitFt[0].toString(), t.UInt256),
      arg(uwTxCommitFt[1].toString(), t.UInt256),
      arg(uwProof2.amountDisclose.proof.map(String), t.Array(t.UInt256)),
      arg(uwProof2.amountDisclose.publicInputs.map(String), t.Array(t.UInt256)),
      arg(uwProof2.transfer.proof.map(String), t.Array(t.UInt256)),
      arg(uwProof2.transfer.publicInputs.map(String), t.Array(t.UInt256)),
      arg(Array.from(uwFtResidualSnap.ciphertext).map(String), t.Array(t.UInt8)),
      arg(uwFtResidualSnap.ephemeralPubkey.x.toString(), t.UInt256),
      arg(uwFtResidualSnap.ephemeralPubkey.y.toString(), t.UInt256),
      arg(ethers.hexlify(uwFtCpSnap.ciphertext).slice(2), t.String),
      arg(uwFtCpSnap.ephemeralPubkey.x.toString(), t.UInt256),
      arg(uwFtCpSnap.ephemeralPubkey.y.toString(), t.UInt256),
      arg(inboxCursor.toString(), t.UInt64),
    ],
    proposer: fclUnwrapFt.authz,
    payer: fclUnwrapFt.authz,
    authorizations: [fclUnwrapFt.authz],
    limit: 9999,
  });
  await fclUnwrapFt.tx(atomicFtUnwrapId).onceSealed();
  return {
    txHash: atomicFtUnwrapId,
    checkpointTxHash: atomicFtUnwrapId,
    netReceived: claimedAmount,
    newBalance: uwResidualBalance,
    newBlinding: uwResidualBlinding,
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
