/// Tip action helpers — v0.6.5 (multi-token SDK migration).
///
/// THIN APP LAYER over @claucondor/sdk@0.6.5.
///
/// Architecture change (v0.6.5):
///   - EVM tokens (flow, wflow, mockusdc): use ethers.Wallet (EVM-direct via SDK adapters)
///   - Cadence FT token (mockft): SDK JanusFTAdapter calls FCL internally
///   - FCL is still used for: COA setup, MemoKey setup, COA EVM addr resolution
///   - All proof orchestration delegated to SDK adapters (no manual proof building)
///
/// Key difference from v0.5.6:
///   - Old: buildWrapCalldata / buildShieldedTransferCalldata / buildUnwrapCalldata manually
///   - New: sdk.token(id).wrap / shieldedTransfer / unwrap handle everything internally
///   - Old: RecoveredShieldedState / Snapshot / recovery.scanJanusFlowSnapshots
///   - New: sdk.token(id).latestSnapshot(addr, memoPrivKey)

import {
  sdk,
  type BabyJubKeypair,
  type SnapshotContent,
  type NoteContent,
  type WrapResult,
  type SendResult,
  type UnwrapResult,
  type TxResult,
  computeNetWrap,
  computeWrapFee,
  generateBlinding,
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

export type { BabyJubKeypair, SnapshotContent, NoteContent, WrapResult, SendResult, UnwrapResult, TxResult };

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Re-export Point for callers that need it. */
export type Point = { x: bigint; y: bigint };

/** EVM signer type. */
export type EVMSigner = ethers.Wallet;

// ─── Constants ──────────────────────────────────────────────────────────────────

export const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
export const EVM_CHAIN_ID = 545;

// ─── Per-user per-token nonce tracking ──────────────────────────────────────────
// Anti-replay nonce for AmountDisclose proofs (wrapWithProof contract storage).
// Key: openjanus:wrap-nonce:<addr>:<tokenId>
// Start at 1, increment after each successful wrap.

function wrapNonceKey(addr: string, tokenId: TokenId): string {
  return `openjanus:wrap-nonce:${addr.toLowerCase()}:${tokenId}`;
}

export function getWrapNonce(addr: string, tokenId: TokenId): bigint {
  if (typeof window === "undefined") return 1n;
  const raw = localStorage.getItem(wrapNonceKey(addr, tokenId));
  return raw ? BigInt(raw) : 1n;
}

export function incrementWrapNonce(addr: string, tokenId: TokenId): void {
  if (typeof window === "undefined") return;
  const current = getWrapNonce(addr, tokenId);
  localStorage.setItem(wrapNonceKey(addr, tokenId), (current + 1n).toString());
}

// Legacy PrivateTip Cadence address (still used for tip recording scripts).
export const PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1";

// Per-token proxy addresses from SDK registry (canonical, no hardcoding).
// Note: wflow was removed in v0.7 TOKEN_REGISTRY (not supported in this deploy).
export const TOKEN_PROXIES = {
  flow:     TOKEN_REGISTRY.flow.proxy,
  mockusdc: TOKEN_REGISTRY.mockusdc.proxy,
  mockft:   TOKEN_REGISTRY.mockft.cadenceAddress,
} as const;

// ─── Unit helpers (kept inline to avoid SDK crypto bundle) ────────────────────

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

// ─── EVM signer management ────────────────────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  }
  return _provider;
}

/**
 * Create an ethers.Wallet from a hex private key for EVM-direct ops.
 * Used by wrap/shieldedTransfer/unwrap on EVM tokens.
 */
export async function createSigner(hexPrivkey: string): Promise<ethers.Wallet> {
  return createEvmWallet(hexPrivkey, "testnet");
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

// ─── MemoKey management (shared registry in v0.6.3+) ─────────────────────────

/**
 * Get the recipient's MemoKey pubkey for a given token.
 * In v0.6.3+, the MemoKeyRegistry is shared across all EVM tokens,
 * so one published key is readable from any token adapter.
 *
 * Returns null if no key published.
 */
export async function getRecipientMemoPubkey(
  flowAddr: string,
  tokenId: TokenId = "flow"
): Promise<Point | null> {
  try {
    const adapter = sdk.token(tokenId);
    // EVM adapters resolve COA first, then query the registry.
    // For cadence-ft (mockft), reads from Cadence JanusFlow MemoKey.
    const entry = TOKEN_REGISTRY[tokenId];
    if (entry.variant === "cadence-ft") {
      // JanusFTAdapter.getMemoKey takes Cadence address directly.
      return await adapter.getMemoKey(flowAddr);
    }
    // EVM adapters: need COA address.
    const coaAddr = await sdkGetCoaEvmAddress(flowAddr, "testnet");
    return await adapter.getMemoKey(coaAddr);
  } catch {
    return null;
  }
}

/**
 * Get the recipient's MemoKey pubkey by a raw EVM address.
 * Used for EVM-only recipients (MetaMask users) who published their key
 * to MemoKeyRegistry directly without owning a Flow Cadence account.
 * Returns null if no key published.
 */
export async function getMemoPubkeyByEvmAddr(
  evmAddr: string,
  tokenId: TokenId = "flow"
): Promise<Point | null> {
  try {
    const entry = TOKEN_REGISTRY[tokenId];
    if (entry.variant === "cadence-ft") {
      // cadence-ft doesn't use the EVM MemoKeyRegistry — not supported for EVM-only recipients.
      return null;
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

// ─── Smart setup (COA + MemoKey, v0.6 — FCL for Cadence side) ─────────────────

/**
 * Smart-setup transaction (v0.6 compatible).
 *
 * 1. Creates COA at /storage/evm if missing, publishes capability at /public/evm.
 * 2. Publishes MemoKey to Cadence storage (JanusFlow path) for mockft adapter.
 * 3. Calls MemoKeyRegistry.publishMemoKey(x, y) on EVM via COA cross-VM call.
 *    This is the critical step for v0.6: all 4 EVM Janus adapters resolve the
 *    recipient key from MemoKeyRegistry (not Cadence storage).
 *
 * MEMO_REGISTRY: 0x05D104962ff087441f26BA11A1E1C3b9E091D663 (Flow EVM testnet)
 */
export const TX_SMART_SETUP = `
import EVM from 0x8c5303eaa26202d6
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    memoPubkeyX: UInt256,
    memoPubkeyY: UInt256
) {
    prepare(signer: auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability, BorrowValue, EVM.Call) &Account) {
        // 1. COA — idempotent (only create if missing).
        if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) == nil {
            let coa <- EVM.createCadenceOwnedAccount()
            signer.storage.save(<-coa, to: /storage/evm)
            let coaCap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
            signer.capabilities.publish(coaCap, at: /public/evm)
        }

        // 2. MemoKey (JanusFlow.MemoKey) — replace any existing Cadence resource.
        //    Required for mockft adapter which reads from Cadence storage path.
        let memoStoragePath = JanusFlow.memoKeyStoragePath()
        let memoPublicPath  = JanusFlow.memoKeyPublicPath()

        if let anyOld <- signer.storage.load<@AnyResource>(from: memoStoragePath) {
            destroy anyOld
            signer.capabilities.unpublish(memoPublicPath)
        }

        let key <- JanusFlow.createMemoKey(pubkeyX: memoPubkeyX, pubkeyY: memoPubkeyY)
        signer.storage.save(<-key, to: memoStoragePath)
        let memoCap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(memoStoragePath)
        signer.capabilities.publish(memoCap, at: memoPublicPath)

        // 3. EVM MemoKeyRegistry — cross-VM publish via COA.
        //    msg.sender in EVM = user's COA address.
        //    All 4 EVM Janus adapters (flow/wflow/mockusdc/ft) resolve recipient
        //    keys from this registry. Without this step shielded transfers revert.
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm — COA creation above should have succeeded")

        let memoRegistryAddr = EVM.addressFromString("0x05D104962ff087441f26BA11A1E1C3b9E091D663")

        // ABI-encode publishMemoKey(uint256,uint256) — selector 0x6370796a
        let calldata = EVM.encodeABIWithSignature(
            "publishMemoKey(uint256,uint256)",
            [memoPubkeyX, memoPubkeyY]
        )

        let result = coa.call(
            to: memoRegistryAddr,
            data: calldata,
            gasLimit: 200000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "MemoKeyRegistry.publishMemoKey reverted — errorCode: "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
        )
    }
}
`;

export async function smartSetupAccount(opts: {
  flowAddr: string;
}): Promise<{ txId: string; pubkey: Point }> {
  const { flowAddr } = opts;
  const { deriveMemoKeyFromWallet } = await import("./memo-key-derive");
  const { cacheMemoPrivkey } = await import("./memo-key-session");
  const kp = await deriveMemoKeyFromWallet();
  cacheMemoPrivkey(flowAddr, kp.privkey);

  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_SMART_SETUP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(kp.pubkey.x.toString(), t.UInt256),
      arg(kp.pubkey.y.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return { txId, pubkey: kp.pubkey };
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

// ─── Wrap action (v0.6 SDK) ──────────────────────────────────────────────────

export interface WrapActionParams {
  tokenId: TokenId;
  grossAmountRaw: bigint;   // raw units (wei for 18-decimal, etc.)
  /** Caller's ethers wallet — required for EVM tokens (flow/wflow/mockusdc). */
  evmSigner?: ethers.Wallet;
  /** Caller's Cadence FCL signer — used by mockft adapter internally. */
  /** Caller's own keypair for snapshot encryption. */
  memoKeypair: BabyJubKeypair;
}

export interface WrapActionResult {
  txHash: string;
  netAmount: bigint;
  fee: bigint;
}

export async function wrapAction(params: WrapActionParams): Promise<WrapActionResult> {
  const { tokenId, grossAmountRaw, evmSigner, memoKeypair } = params;
  const adapter = sdk.token(tokenId);
  const entry = TOKEN_REGISTRY[tokenId];

  // For ERC20 tokens, pre-approve the underlying before wrapping.
  if (entry.variant === "erc20" && evmSigner) {
    const erc20Entry = entry as typeof TOKEN_REGISTRY["mockusdc"];
    const erc20 = new ethers.Contract(
      erc20Entry.underlying,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      evmSigner
    );
    const approveTx = await erc20.approve(erc20Entry.proxy, grossAmountRaw);
    await approveTx.wait();
  }

  // Determine which signer to pass. JanusFTAdapter ignores signer (uses FCL internally).
  const signer = evmSigner ?? (null as unknown as ethers.Wallet);

  const result = await adapter.wrap({ grossAmount: grossAmountRaw }, signer);
  return {
    txHash: result.txHash,
    netAmount: result.netAmount,
    fee: result.fee,
  };
}

// ─── Shielded transfer action (v0.6 SDK) ─────────────────────────────────────

export interface SendActionParams {
  tokenId: TokenId;
  /** EVM hex address (for EVM tokens) or Cadence address (for mockft). */
  recipientAddr: string;
  amount: bigint;
  currentBalance: bigint;
  currentBlinding: bigint;
  memo?: string;
  evmSigner?: ethers.Wallet;
  memoKeypair: BabyJubKeypair;
  /**
   * Sender's COA EVM hex address — required for all variants
   * so shieldedTransferViaCoa can look up the sender's registered MemoKey.
   */
  coaEvmAddr?: string;
  /**
   * For cadence-ft variant: the sender's Flow wallet (Cadence) address.
   * Required for shieldedTransferViaCoa — passed as the FCL signer address arg.
   */
  userCadenceAddr?: string;
}

export interface SendActionResult {
  txHash: string;
}

export async function sendShieldedAction(params: SendActionParams): Promise<SendActionResult> {
  const { tokenId, recipientAddr, amount, currentBalance, currentBlinding, memo, evmSigner, coaEvmAddr, userCadenceAddr } = params;

  if (amount > currentBalance) {
    throw new Error(
      `Insufficient shielded balance: have ${currentBalance}, need ${amount}`
    );
  }

  const entry = TOKEN_REGISTRY[tokenId];
  const adapter = sdk.token(tokenId);

  if (entry.variant === "native" || entry.variant === "erc20") {
    // FCL/COA path: user signs Cadence tx in Flow Wallet.
    if (!coaEvmAddr) {
      throw new Error(
        `sendShieldedAction: coaEvmAddr is required for ${tokenId} (variant=${entry.variant}).`
      );
    }

    // Generate fresh blindings client-side.
    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    // Build proof server-side.
    const proofResponse = await fetch("/api/proof/shielded-transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldBalance: currentBalance.toString(),
        oldBlinding: currentBlinding.toString(),
        transferAmount: amount.toString(),
        transferBlinding: transferBlinding.toString(),
        newBlinding: newBlinding.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`sendShieldedAction: proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).shieldedTransferViaCoa({
      recipient: recipientAddr,
      amount,
      currentBalance,
      currentBlinding,
      memo,
      coaEvmAddr,
      prebuiltProof: {
        proof: proofData.proof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        publicInputs: proofData.publicInputs.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint],
        transferBlinding,
        newBlinding,
      },
    });
    return { txHash: result.txHash };
  }

  // cadence-ft (MockFT): use shieldedTransferViaCoa with server-side proof (browser-safe).
  if (entry.variant === "cadence-ft") {
    if (!coaEvmAddr) {
      throw new Error(
        `sendShieldedAction: coaEvmAddr is required for ${tokenId} (variant=cadence-ft). Pass the sender's COA EVM address.`
      );
    }
    if (!userCadenceAddr) {
      throw new Error(
        `sendShieldedAction: userCadenceAddr is required for ${tokenId} (variant=cadence-ft). Pass the sender's Flow wallet address.`
      );
    }

    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    const proofResponse = await fetch("/api/proof/shielded-transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldBalance: currentBalance.toString(),
        oldBlinding: currentBlinding.toString(),
        transferAmount: amount.toString(),
        transferBlinding: transferBlinding.toString(),
        newBlinding: newBlinding.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`sendShieldedAction (cadence-ft): proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).shieldedTransferViaCoa({
      recipient: recipientAddr,
      amount,
      currentBalance,
      currentBlinding,
      memo,
      coaEvmAddr,
      userCadenceAddr,
      prebuiltProof: {
        proof: proofData.proof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        publicInputs: proofData.publicInputs.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint],
        transferBlinding,
        newBlinding,
      },
    });
    return { txHash: result.txHash };
  }

  // Fallback (Node.js / non-browser callers): adapter calls FCL internally.
  const signer = evmSigner ?? (null as unknown as ethers.Wallet);
  const result = await adapter.shieldedTransfer(
    {
      recipient: recipientAddr,
      amount,
      currentBalance,
      currentBlinding,
      memo,
    },
    signer
  );
  return { txHash: result.txHash };
}

// ─── Unwrap action (v0.6 SDK) ────────────────────────────────────────────────

export interface UnwrapActionParams {
  tokenId: TokenId;
  claimedAmount: bigint;
  /** EVM hex recipient address (EVM tokens) or Cadence address (mockft). */
  recipient: string;
  currentBalance: bigint;
  currentBlinding: bigint;
  evmSigner?: ethers.Wallet;
  memoKeypair: BabyJubKeypair;
  /**
   * User's COA EVM hex address — required for all variants.
   * Used to look up the registered MemoKey.
   */
  coaEvmAddr?: string;
  /**
   * For cadence-ft variant: the user's Flow wallet (Cadence) address.
   * Required for unwrapViaCoa — passed as the FCL signer address arg.
   */
  userCadenceAddr?: string;
}

export interface UnwrapActionResult {
  txHash: string;
  netToRecipient: bigint;
}

export async function unwrapAction(params: UnwrapActionParams): Promise<UnwrapActionResult> {
  const { tokenId, claimedAmount, recipient, currentBalance, currentBlinding, evmSigner, coaEvmAddr, userCadenceAddr } = params;

  if (claimedAmount > currentBalance) {
    throw new Error(
      `Insufficient shielded balance: have ${currentBalance}, claimed ${claimedAmount}`
    );
  }

  const entry = TOKEN_REGISTRY[tokenId];
  const adapter = sdk.token(tokenId);

  if (entry.variant === "native" || entry.variant === "erc20") {
    // FCL/COA path.
    if (!coaEvmAddr) {
      throw new Error(
        `unwrapAction: coaEvmAddr is required for ${tokenId} (variant=${entry.variant}).`
      );
    }

    // Generate fresh blindings client-side.
    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    // Build both proofs server-side.
    const proofResponse = await fetch("/api/proof/unwrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claimedAmount: claimedAmount.toString(),
        currentBalance: currentBalance.toString(),
        currentBlinding: currentBlinding.toString(),
        transferBlinding: transferBlinding.toString(),
        newBlinding: newBlinding.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`unwrapAction: proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).unwrapViaCoa({
      claimedAmount,
      recipient,
      currentBalance,
      currentBlinding,
      coaEvmAddr,
      prebuiltProofs: {
        amountProof: proofData.amountProof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        txCommit: [BigInt(proofData.txCommit[0]), BigInt(proofData.txCommit[1])] as [bigint,bigint],
        amountPublicInputs: proofData.amountPublicInputs.map(BigInt) as [bigint,bigint,bigint,bigint],
        transferProof: proofData.transferProof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        transferPublicInputs: proofData.transferPublicInputs.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint],
        newBlinding,
        // v0.7: SDK defaults nonce=0n for unwrap (anti-replay, Phase B.5 fix).
        nonce: 0n,
      },
    });
    return { txHash: result.txHash, netToRecipient: result.netToRecipient };
  }

  // cadence-ft (MockFT): use unwrapViaCoa with server-side proof (browser-safe).
  if (entry.variant === "cadence-ft") {
    if (!coaEvmAddr) {
      throw new Error(
        `unwrapAction: coaEvmAddr is required for ${tokenId} (variant=cadence-ft). Pass the user's COA EVM address.`
      );
    }
    if (!userCadenceAddr) {
      throw new Error(
        `unwrapAction: userCadenceAddr is required for ${tokenId} (variant=cadence-ft). Pass the user's Flow wallet address.`
      );
    }

    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    const proofResponse = await fetch("/api/proof/unwrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claimedAmount: claimedAmount.toString(),
        currentBalance: currentBalance.toString(),
        currentBlinding: currentBlinding.toString(),
        transferBlinding: transferBlinding.toString(),
        newBlinding: newBlinding.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`unwrapAction (cadence-ft): proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).unwrapViaCoa({
      claimedAmount,
      recipient,
      currentBalance,
      currentBlinding,
      coaEvmAddr,
      userCadenceAddr,
      prebuiltProofs: {
        amountProof: proofData.amountProof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        txCommit: [BigInt(proofData.txCommit[0]), BigInt(proofData.txCommit[1])] as [bigint,bigint],
        amountPublicInputs: proofData.amountPublicInputs.map(BigInt) as [bigint,bigint,bigint,bigint],
        transferProof: proofData.transferProof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        transferPublicInputs: proofData.transferPublicInputs.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint],
        newBlinding,
        nonce: 0n,
      },
    });
    return { txHash: result.txHash, netToRecipient: result.netToRecipient };
  }

  // Fallback (Node.js / non-browser callers): adapter calls FCL internally.
  const signer = evmSigner ?? (null as unknown as ethers.Wallet);
  const result = await adapter.unwrap(
    {
      claimedAmount,
      recipient,
      currentBalance,
      currentBlinding,
    },
    signer
  );
  return { txHash: result.txHash, netToRecipient: result.netToRecipient };
}

// ─── PrivateTip Cadence script builders ───────────────────────────────────────

export function buildGetShieldedTipsByRecipientWithMemoScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(recipient: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsByRecipientWithMemo(recipient: recipient)
    }
  `;
}

export function buildGetShieldedTipsBySenderScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(sender: Address): [PrivateTip.TipMetadata] {
      return PrivateTip.getShieldedTipsBySender(sender: sender)
    }
  `;
}

export function buildGetTipCountScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(recipient: Address): UInt64 {
      return PrivateTip.getTipCount(recipient: recipient)
    }
  `;
}

// ─── Note encryption/decryption (server-side API routes) ─────────────────────

type MemoCiphertext = {
  ciphertext: Uint8Array;
  ephemeralPubkey: { x: bigint; y: bigint };
};

export interface ShieldedNote {
  amount: bigint;
  blinding: bigint;
  data?: string;
}

export async function encryptNote(
  note: ShieldedNote,
  recipientPubkey: { x: bigint; y: bigint }
): Promise<MemoCiphertext> {
  const res = await fetch("/api/note/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: note.amount.toString(),
      blinding: note.blinding.toString(),
      data: note.data,
      recipientPubkey: {
        x: recipientPubkey.x.toString(),
        y: recipientPubkey.y.toString(),
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`encryptNote: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return {
    ciphertext: new Uint8Array(data.ciphertext),
    ephemeralPubkey: {
      x: BigInt(data.ephemeralPubkey.x),
      y: BigInt(data.ephemeralPubkey.y),
    },
  };
}

export async function decryptNote(
  ciphertext: Uint8Array,
  ephemeralPubkey: { x: bigint; y: bigint },
  privkey: bigint
): Promise<ShieldedNote> {
  const res = await fetch("/api/note/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertext: Array.from(ciphertext),
      ephemeralPubkey: {
        x: ephemeralPubkey.x.toString(),
        y: ephemeralPubkey.y.toString(),
      },
      privkey: privkey.toString(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`decryptNote: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return {
    amount: BigInt(data.amount),
    blinding: BigInt(data.blinding),
    data: data.data,
  };
}

export async function encryptMemo(
  plaintext: string,
  recipientPubkey: { x: bigint; y: bigint }
): Promise<MemoCiphertext> {
  const res = await fetch("/api/memo/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plaintext,
      recipientPubkey: {
        x: recipientPubkey.x.toString(),
        y: recipientPubkey.y.toString(),
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`encryptMemo: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return {
    ciphertext: new Uint8Array(data.ciphertext),
    ephemeralPubkey: {
      x: BigInt(data.ephemeralPubkey.x),
      y: BigInt(data.ephemeralPubkey.y),
    },
  };
}
export const encryptText = encryptMemo;

export async function decryptText(
  ciphertext: Uint8Array,
  ephemeralPubkey: { x: bigint; y: bigint },
  privkey: bigint
): Promise<string> {
  const res = await fetch("/api/memo/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertext: Array.from(ciphertext),
      ephemeralPubkey: {
        x: ephemeralPubkey.x.toString(),
        y: ephemeralPubkey.y.toString(),
      },
      privkey: privkey.toString(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`decryptText: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return data.plaintext;
}

export async function generateBabyJubKeypair(): Promise<BabyJubKeypair> {
  const res = await fetch("/api/keypair/generate", { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`generateBabyJubKeypair: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return {
    privkey: BigInt(data.privkey),
    pubkey: { x: BigInt(data.pubkey.x), y: BigInt(data.pubkey.y) },
  };
}

// ─── Legacy compatibility — kept so existing pages don't break immediately ────
// These are thin wrappers over the new SDK-based functions.

/**
 * @deprecated Use sdk.token('flow').wrap() via wrapAction() instead.
 * Kept for page compatibility during migration.
 */
export const JANUS_FLOW_EVM = TOKEN_REGISTRY.flow.proxy;
export const JANUS_FLOW_CADENCE = "0x5dcbeb41055ec57e";

export function computeNetWrapAmount(grossWei: bigint, feeBps: number): bigint {
  return computeNetWrap(grossWei, feeBps);
}
export function computeWrapFeeAmount(grossWei: bigint, feeBps: number): bigint {
  return computeWrapFee(grossWei, feeBps);
}

/**
 * Read the fee rate from a token contract.
 */
export async function fetchFeeBps(tokenId: TokenId = "flow"): Promise<number> {
  const adapter = sdk.token(tokenId);
  return adapter.feeBps();
}

// ─── Legacy sendShieldedTipAction shim (FLOW only, for /send page) ────────────

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
  /**
   * Sender's own COA EVM hex address — required for all variants
   * so the shieldedTransferViaCoa path can find the sender's MemoKey.
   */
  senderCoaEvmAddr?: string;
  /**
   * For cadence-ft variant: the sender's Flow wallet (Cadence) address.
   * Required for shieldedTransferViaCoa — passed as FCL signer address arg.
   */
  userCadenceAddr?: string;
}

export interface SendShieldedTipResult {
  txId: string;
  newBlinding: bigint;
  transferBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

/**
 * Send a shielded tip via SDK v0.6.
 * For EVM tokens: uses evmSigner (ethers.Wallet).
 * For mockft: JanusFTAdapter calls FCL internally.
 */
export async function sendShieldedTipAction(
  params: SendShieldedTipParams
): Promise<SendShieldedTipResult> {
  const {
    recipientFlowAddr,
    recipientCoaHex,
    transferAmountWei,
    oldBalanceWei,
    oldBlinding,
    memo,
    recipientMemoPubkey,
    evmSigner,
    memoKeypair,
    tokenId = "flow",
  } = params;

  if (transferAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, need ${transferAmountWei} wei`
    );
  }
  if (!recipientMemoPubkey) {
    throw new Error(
      "sendShieldedTipAction: recipient has no published MemoKey — they cannot unwrap."
    );
  }

  const entry = TOKEN_REGISTRY[tokenId];
  // Determine recipient address format.
  // EVM tokens (native/erc20): use COA EVM hex.
  // Cadence FT (mockft): use Cadence Flow address.
  const recipientAddr = entry.variant === "cadence-ft" ? recipientFlowAddr : recipientCoaHex;

  // Resolve sender's COA address for the ViaCoa path (all variants).
  const senderCoaEvmAddr = params.senderCoaEvmAddr;
  const userCadenceAddrForSend = params.userCadenceAddr;

  const result = await sendShieldedAction({
    tokenId,
    recipientAddr,
    amount: transferAmountWei,
    currentBalance: oldBalanceWei,
    currentBlinding: oldBlinding,
    memo,
    evmSigner,
    memoKeypair: memoKeypair ?? { privkey: 0n, pubkey: { x: 0n, y: 1n } },
    coaEvmAddr: senderCoaEvmAddr,
    userCadenceAddr: userCadenceAddrForSend,
  });

  // v0.6: SDK doesn't return newBlinding directly. We can reconstruct it
  // from latestSnapshot after the tx, but for UI purposes we return the
  // tx hash and signal that the user should re-scan for latest state.
  // Return a provisional result that pages can use for optimistic UI.
  return {
    txId: result.txHash,
    newBlinding: 0n,           // caller should re-scan via latestSnapshot
    transferBlinding: 0n,      // not exposed by v0.6 API surface
    newCommit: { x: 0n, y: 1n }, // identity — will be updated on scan
    newBalanceWei: oldBalanceWei - transferAmountWei,
  };
}

// ─── Legacy wrapAction shim (FLOW only, for /wrap page) ──────────────────────

export interface LegacyWrapParams {
  amountUFix64: string;
  amountWei: bigint;
  source?: "vault" | "coa";
  netAmountForProofWei?: bigint;
  memoKeypair?: BabyJubKeypair;
  evmSigner?: ethers.Wallet;
  tokenId?: TokenId;
  /**
   * For all variants: the user's COA EVM address.
   * Required for the wrapViaCoa FCL path — used to look up the registered MemoKey.
   */
  coaEvmAddr?: string;
  /**
   * For cadence-ft variant: the user's Flow wallet (Cadence) address.
   * Required for wrapViaCoa — passed as the FCL signer address arg.
   */
  userCadenceAddr?: string;
}

export interface LegacyWrapResult {
  txId: string;
  blinding: bigint;
  commitment: Point;
}

/**
 * Wrap via SDK v0.6. Returns a minimal result for backward compat with wrap page.
 *
 * For native (FLOW) and erc20 (mUSDC) variants:
 *   Uses adapter.wrapViaCoa() — dispatches a Cadence tx via FCL so the user's
 *   COA (not a derived EOA) is msg.sender in JanusFlow/JanusERC20. The COA is
 *   the identity that has the MemoKey registered, so wrap() won't revert.
 *
 * For cadence-ft (MockFT) variant:
 *   Uses adapter.wrap() as before — JanusFTAdapter already calls FCL internally.
 *
 * The EVMSigner-based wrapAction() path is preserved for non-FCL consumers.
 *
 * Pages should call latestSnapshot after wrap to get fresh state.
 */
export async function wrapActionLegacy(params: LegacyWrapParams): Promise<LegacyWrapResult> {
  const { amountWei, memoKeypair, evmSigner, tokenId = "flow", coaEvmAddr, userCadenceAddr } = params;

  if (!memoKeypair) {
    throw new Error("wrapAction: memoKeypair required for v0.6 SDK");
  }

  const entry = TOKEN_REGISTRY[tokenId];

  if (entry.variant === "native" || entry.variant === "erc20") {
    // FCL/COA path: user signs one Cadence tx in Flow Wallet.
    // The COA EVM address must be supplied so we can look up the MemoKey.
    if (!coaEvmAddr) {
      throw new Error(
        `wrapActionLegacy: coaEvmAddr is required for ${tokenId} (variant=${entry.variant}). Pass the user's COA hex address.`
      );
    }

    // Compute netAmount for proof: feeBps from adapter, then net = gross - fee.
    const adapter = sdk.token(tokenId);
    const bps = await adapter.feeBps();
    const fee = bps === 0 ? 0n : (amountWei * BigInt(bps)) / 10000n;
    const netAmount = amountWei - fee;

    // Generate blinding client-side (crypto.getRandomValues, browser-safe).
    const blinding = generateBlinding();

    // Read per-user per-token nonce (anti-replay for wrapWithProof).
    const nonce = getWrapNonce(coaEvmAddr, tokenId);

    // Build proof server-side (wasm/zkey file I/O requires Node.js).
    const proofResponse = await fetch("/api/proof/wrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: netAmount.toString(),
        blinding: blinding.toString(),
        nonce: nonce.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`wrapActionLegacy: proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // Type assertion: both JanusFlowAdapter and JanusERC20Adapter have wrapViaCoa.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).wrapViaCoa({
      grossAmount: amountWei,
      coaEvmAddr,
      prebuiltProof: {
        proof: proofData.proof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        txCommit: [BigInt(proofData.txCommit[0]), BigInt(proofData.txCommit[1])] as [bigint,bigint],
        blinding,
        nonce,
        publicInputs: proofData.publicInputs.map(BigInt) as [bigint,bigint,bigint,bigint],
      },
    });
    // Increment nonce after successful wrap.
    incrementWrapNonce(coaEvmAddr, tokenId);
    return {
      txId: result.txHash,
      blinding: 0n,  // caller should re-scan to get fresh blinding
      commitment: { x: 0n, y: 1n },
    };
  }

  // cadence-ft (MockFT): use wrapViaCoa with server-side proof (browser-safe).
  if (entry.variant === "cadence-ft") {
    if (!coaEvmAddr) {
      throw new Error(
        `wrapActionLegacy: coaEvmAddr is required for ${tokenId} (variant=cadence-ft). Pass the user's COA EVM hex address.`
      );
    }
    if (!userCadenceAddr) {
      throw new Error(
        `wrapActionLegacy: userCadenceAddr is required for ${tokenId} (variant=cadence-ft). Pass the user's Flow wallet address.`
      );
    }

    const adapter = sdk.token(tokenId);
    const bps = await adapter.feeBps();
    const fee = bps === 0 ? 0n : (amountWei * BigInt(bps)) / 10000n;
    const netAmount = amountWei - fee;

    const blinding = generateBlinding();
    const nonce = getWrapNonce(coaEvmAddr, tokenId);

    const proofResponse = await fetch("/api/proof/wrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: netAmount.toString(),
        blinding: blinding.toString(),
        nonce: nonce.toString(),
      }),
    });
    if (!proofResponse.ok) {
      const errBody = await proofResponse.json().catch(() => ({ error: proofResponse.statusText }));
      throw new Error(`wrapActionLegacy (cadence-ft): proof generation failed: ${errBody.error}`);
    }
    const proofData = await proofResponse.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adapter as any).wrapViaCoa({
      grossAmount: amountWei,
      coaEvmAddr,
      userCadenceAddr,
      prebuiltProof: {
        proof: proofData.proof.map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint],
        txCommit: [BigInt(proofData.txCommit[0]), BigInt(proofData.txCommit[1])] as [bigint,bigint],
        blinding,
        nonce,
        publicInputs: proofData.publicInputs.map(BigInt) as [bigint,bigint,bigint,bigint],
      },
    });
    incrementWrapNonce(coaEvmAddr, tokenId);
    return {
      txId: result.txHash,
      blinding: 0n,
      commitment: { x: 0n, y: 1n },
    };
  }

  // Fallback (Node.js / non-browser callers): adapter.wrap calls FCL internally.
  const result = await wrapAction({
    tokenId,
    grossAmountRaw: amountWei,
    evmSigner,
    memoKeypair,
  });

  return {
    txId: result.txHash,
    blinding: 0n,
    commitment: { x: 0n, y: 1n },
  };
}

// ─── Legacy unwrapAction shim (for /claim page) ──────────────────────────────

export interface LegacyUnwrapParams {
  claimedAmountWei: bigint;
  recipientEvmHex: string;
  oldBalanceWei: bigint;
  oldBlinding: bigint;
  memoKeypair?: BabyJubKeypair;
  evmSigner?: ethers.Wallet;
  tokenId?: TokenId;
  /**
   * Caller's COA EVM hex address — required for all variants.
   * The claim page already has this as coaHex. Pass it here.
   */
  coaEvmAddr?: string;
  /**
   * For cadence-ft variant: the user's Flow wallet (Cadence) address.
   * Required for unwrapViaCoa. Pass userAddress from the claim page.
   */
  userCadenceAddr?: string;
}

export interface LegacyUnwrapResult {
  txId: string;
  newBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

export async function unwrapActionLegacy(params: LegacyUnwrapParams): Promise<LegacyUnwrapResult> {
  const { claimedAmountWei, recipientEvmHex, oldBalanceWei, oldBlinding, evmSigner, memoKeypair, tokenId = "flow", coaEvmAddr, userCadenceAddr } = params;

  if (!memoKeypair) {
    throw new Error("unwrapAction: memoKeypair required for v0.6 SDK");
  }

  const entry = TOKEN_REGISTRY[tokenId];
  // For cadence-ft, recipient is a Cadence address (caller should pass userAddress, not coaHex).
  const recipient = entry.variant === "cadence-ft" ? (userCadenceAddr ?? recipientEvmHex) : recipientEvmHex;

  const result = await unwrapAction({
    tokenId,
    claimedAmount: claimedAmountWei,
    recipient,
    currentBalance: oldBalanceWei,
    currentBlinding: oldBlinding,
    evmSigner,
    memoKeypair,
    coaEvmAddr,
    userCadenceAddr,
  });

  return {
    txId: result.txHash,
    newBlinding: 0n,
    newCommit: { x: 0n, y: 1n },
    newBalanceWei: oldBalanceWei - claimedAmountWei,
  };
}
