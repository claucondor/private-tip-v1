/// Tip action helpers — v0.4.1.
///
/// THIN APP LAYER over @openjanus/sdk@0.4.1. Anything generic now lives in
/// the SDK; this module only contains:
///   - PrivateTip-specific Cadence templates
///   - sendShieldedTipAction (orchestrates JanusFlow.shieldedTransfer +
///     PrivateTip.recordTip + memo encryption — app-specific bundling)
///   - PrivateTip script builders
///   - Memo encryption helpers wired to the recipient's published MemoKey
///   - Shielded-state persistence (sessionStorage)
///
/// v0.4.1 contracts:
///   JanusFlow EVM proxy:           0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
///   JanusFlow Cadence router:      0x5dcbeb41055ec57e
///   PrivateTip Cadence router:     0xb9ac529c14a4c5a1

import { JsonRpcProvider } from "ethers";
import {
  // Token addresses
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_VERSION,
  // Cadence TX templates moved into SDK (from /tokens subpath since
  // not all are re-exported from root in 0.4.1)
  TX_WRAP,
  TX_WRAP_FROM_COA,
  TX_UNWRAP,
  TX_UNWRAP_TO_VAULT,
  // Calldata builders
  buildWrapCalldata,
  buildShieldedTransferCalldata,
  buildUnwrapCalldata,
  // EVM reads
  readCommitment as sdkReadCommitment,
  readTotalLocked as sdkReadTotalLocked,
  // Source resolver
  resolveWrapSource,
} from "@openjanus/sdk/tokens";
import {
  // COA helpers
  getCoaEvmAddress as sdkGetCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei as sdkGetCoaBalanceWei,
  getFlowVaultBalanceWei as sdkGetFlowVaultBalanceWei,
  TX_SETUP_COA,
} from "@openjanus/sdk/network";
import {
  // Memo encryption primitives
  encryptText,
  decryptText,
  generateBabyJubKeypair,
  type MemoCiphertext,
  type BabyJubKeypair,
  // Unit conversions
  parseFlowToWei as sdkParseFlowToWei,
  formatWeiToFlow as sdkFormatWeiToFlow,
  weiToFlowUFix64 as sdkWeiToFlowUFix64,
  FLOW_SCALE as SDK_FLOW_SCALE,
} from "@openjanus/sdk/crypto";
import {
  // Formatters / validators
  formatPoint as sdkFormatPoint,
  isValidFlowAddress as sdkIsValidFlowAddress,
  isValidFlowAmount as sdkIsValidFlowAmount,
} from "@openjanus/sdk/utils";
import {
  // Types
  isIdentityPoint as sdkIsIdentityPoint,
  type Point,
  type WrapSource,
} from "@openjanus/sdk";

// FCL has no type declarations bundled.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fcl = any;
let _fcl: Fcl | null = null;
async function getFcl(): Promise<Fcl> {
  if (!_fcl) {
    _fcl = await import("@onflow/fcl");
  }
  return _fcl!;
}

// ─── Re-exports (so app code can keep importing from this module) ──────────────

export const JANUS_FLOW_EVM = JANUS_FLOW_EVM_ADDRESS;
export const JANUS_FLOW_CADENCE = JANUS_FLOW_CADENCE_ADDRESS;
export const PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1";
export const SDK_VERSION = JANUS_FLOW_VERSION;

export const FLOW_SCALE = SDK_FLOW_SCALE;

export type { Point, WrapSource, MemoCiphertext, BabyJubKeypair };

export const isIdentityPoint = sdkIsIdentityPoint;
export const parseFlowToWei = sdkParseFlowToWei;
export const formatWeiToFlow = sdkFormatWeiToFlow;
export const formatWeiToFlowUFix64 = sdkWeiToFlowUFix64;
export const formatPoint = sdkFormatPoint;
export const isValidFlowAddress = sdkIsValidFlowAddress;
export const isValidFlowAmount = sdkIsValidFlowAmount;

// Memo encryption — direct re-exports for /send and /tips pages.
export { encryptText, decryptText, generateBabyJubKeypair };

// ─── Smart-setup Cadence template (COA + MemoKey in one atomic tx) ────────────

/** Smart-setup: creates COA AND MemoKey in one tx if either is missing. */
export const TX_SMART_SETUP = `
import "EVM"
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    memoPrivkey: UInt256,
    memoPubkeyX: UInt256,
    memoPubkeyY: UInt256
) {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability, BorrowValue) &Account) {
        // 1. COA
        if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) == nil {
            let coa <- EVM.createCadenceOwnedAccount()
            signer.storage.save(<-coa, to: /storage/evm)
            let coaCap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
            signer.capabilities.publish(coaCap, at: /public/evm)
        }
        // 2. MemoKey
        let memoStoragePath = PrivateTip.memoKeyStoragePath()
        let memoPublicPath = PrivateTip.memoKeyPublicPath()
        if signer.storage.borrow<&PrivateTip.MemoKey>(from: memoStoragePath) == nil {
            let key <- PrivateTip.createMemoKey(
                privkey: memoPrivkey,
                pubkeyX: memoPubkeyX,
                pubkeyY: memoPubkeyY
            )
            signer.storage.save(<-key, to: memoStoragePath)
            let memoCap = signer.capabilities.storage.issue<&{PrivateTip.MemoKeyPublic}>(memoStoragePath)
            signer.capabilities.publish(memoCap, at: memoPublicPath)
        }
    }
}
`;

/**
 * Smart-setup action: generates a fresh MemoKey client-side, persists the
 * privkey to localStorage, and submits the COA+MemoKey setup tx.
 *
 * Storage layout in localStorage:
 *   key:    openjanus:memo-privkey:<addr-lowercase>
 *   value:  privkey as decimal string (BabyJub scalar)
 */
export async function smartSetupAccount(opts: {
  flowAddr: string;
}): Promise<{ txId: string; pubkey: Point }> {
  const { flowAddr } = opts;
  // 1. Generate keypair client-side. Privkey is cached in localStorage so the
  //    recipient can decrypt incoming memos later without re-keying.
  const kp = await generateBabyJubKeypair();
  const lsKey = `openjanus:memo-privkey:${flowAddr.toLowerCase()}`;
  if (typeof window !== "undefined") {
    localStorage.setItem(lsKey, kp.privkey.toString());
  }

  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_SMART_SETUP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(kp.privkey.toString(), t.UInt256),
      arg(kp.pubkey.x.toString(), t.UInt256),
      arg(kp.pubkey.y.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 200,
  });
  await fcl.tx(txId).onceSealed();
  return { txId, pubkey: kp.pubkey };
}

/** Read the user's cached MemoKey privkey from localStorage (or null). */
export function loadMemoPrivkey(flowAddr: string): bigint | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(
    `openjanus:memo-privkey:${flowAddr.toLowerCase()}`
  );
  return raw ? BigInt(raw) : null;
}

// SDK COA setup tx — fixes the inline SETUP_COA_CDC divergence.
export { TX_SETUP_COA };

// SDK resolveWrapSource — pure decision helper.
export { resolveWrapSource };

// SDK Cadence tx templates (re-exports for any code still importing locally).
export { TX_WRAP, TX_WRAP_FROM_COA, TX_UNWRAP, TX_UNWRAP_TO_VAULT };

// SDK calldata builders.
export { buildWrapCalldata, buildShieldedTransferCalldata, buildUnwrapCalldata };

// ─── EVM reads — wrap SDK helpers with a default provider ──────────────────────

const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;

let _provider: JsonRpcProvider | null = null;
function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  }
  return _provider;
}

export async function getCommitment(coaEvmHex: string): Promise<Point> {
  return sdkReadCommitment(getProvider(), coaEvmHex, JANUS_FLOW_EVM);
}

export async function getTotalLocked(): Promise<bigint> {
  return sdkReadTotalLocked(getProvider(), JANUS_FLOW_EVM);
}

// ─── COA / FCL helpers — wrap SDK helpers ──────────────────────────────────────

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

// ─── Local types ───────────────────────────────────────────────────────────────

/** Result of /api/proof/encrypt (amount-disclose proof). */
export interface AmountDiscloseProofResponse {
  commitment: { x: string; y: string };
  txCommit: [string, string];
  proof: string[]; // uint256[8]
  publicInputs: string[];
  blinding: string;
}

/** Result of /api/proof/decrypt (confidential-transfer proof). */
export interface ShieldedTransferProofResponse {
  commitments: {
    oldCommit: { x: string; y: string };
    transferCommit: { x: string; y: string };
    newCommit: { x: string; y: string };
  };
  txCommit: [string, string];
  proof: string[];
  publicInputs: string[];
  transferBlinding: string;
  newBlinding: string;
}

// ─── Proof generation (delegates to server routes) ─────────────────────────────

export async function generateAmountDiscloseProof(
  amountWei: bigint,
  blinding?: bigint
): Promise<AmountDiscloseProofResponse> {
  const response = await fetch("/api/proof/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountWei.toString(),
      blinding: blinding?.toString(),
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Amount-disclose proof generation failed");
  }
  return response.json();
}

export async function generateShieldedTransferProof(params: {
  oldBalance: bigint;
  oldBlinding: bigint;
  transferAmount: bigint;
  transferBlinding?: bigint;
  newBlinding?: bigint;
}): Promise<ShieldedTransferProofResponse> {
  const response = await fetch("/api/proof/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oldBalance: params.oldBalance.toString(),
      oldBlinding: params.oldBlinding.toString(),
      transferAmount: params.transferAmount.toString(),
      transferBlinding: params.transferBlinding?.toString(),
      newBlinding: params.newBlinding?.toString(),
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Shielded-transfer proof generation failed");
  }
  return response.json();
}

// ─── End-to-end wrap action ────────────────────────────────────────────────────

export interface WrapParams {
  amountUFix64: string;
  amountWei: bigint;
  source?: WrapSource;
}

export interface WrapResult {
  txId: string;
  blinding: bigint;
  commitment: Point;
}

export async function wrapAction(params: WrapParams): Promise<WrapResult> {
  const { amountUFix64, amountWei, source = "vault" } = params;

  const proofRes = await generateAmountDiscloseProof(amountWei);
  const txCommit: [bigint, bigint] = [
    BigInt(proofRes.txCommit[0]),
    BigInt(proofRes.txCommit[1]),
  ];
  const proof = proofRes.proof.map((s) => BigInt(s));

  const calldataHex = await buildWrapCalldata(txCommit, proof);

  const fcl = await getFcl();
  const cadence = source === "coa" ? TX_WRAP_FROM_COA : TX_WRAP;
  const txId = await fcl.mutate({
    cadence,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(amountUFix64, t.UFix64),
      arg(
        txCommit.map((v) => v.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt256)
      ),
      arg(
        proof.map((v) => v.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt256)
      ),
      arg(calldataHex, t.String),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();

  return {
    txId,
    blinding: BigInt(proofRes.blinding),
    commitment: {
      x: BigInt(proofRes.commitment.x),
      y: BigInt(proofRes.commitment.y),
    },
  };
}

// ─── End-to-end send-shielded-tip action (v0.4.1: encrypted memo) ─────────────

/** PrivateTip-specific Cadence tx: shielded transfer + recordTip with encrypted memo. */
export const TX_SEND_SHIELDED_TIP = `
import JanusFlow from 0x5dcbeb41055ec57e
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    recipient: Address,
    recipientEVMHex: String,
    publicInputs: [UInt256],
    proof: [UInt256],
    calldataHex: String,
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256
) {
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        assert(
            publicInputs.length == 6,
            message: "publicInputs must be 6 UInt256 (C_old, C_tx, C_new)"
        )
        assert(
            proof.length == 8,
            message: "proof must be 8 UInt256 (Groth16)"
        )

        JanusFlow.shieldedTransfer(
            signer: self.signerRef,
            toEVMHex: recipientEVMHex,
            publicInputs: publicInputs,
            proof: proof,
            calldataHex: calldataHex
        )

        let ciphertextRef: [UInt256] = [publicInputs[2], publicInputs[3]]

        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: recipient,
            ciphertextRef: ciphertextRef,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY
        )
        log("PrivateTip.recordTip emitted shielded tipID=".concat(tipID.toString()))
    }
}
`;

export interface SendShieldedTipParams {
  recipientFlowAddr: string;
  recipientCoaHex: string;
  transferAmountWei: bigint;
  oldBalanceWei: bigint;
  oldBlinding: bigint;
  /** Optional plaintext memo. Encrypted client-side; never sent in cleartext. */
  memo?: string;
  /**
   * Recipient's MemoKey pubkey. Required when `memo` is set. Fetched via
   * `getRecipientMemoPubkey()` before calling sendShieldedTipAction.
   */
  recipientMemoPubkey?: Point;
}

export interface SendShieldedTipResult {
  txId: string;
  newBlinding: bigint;
  transferBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

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
  } = params;

  if (transferAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, need ${transferAmountWei} wei`
    );
  }
  if (memo && memo.length > 0 && !recipientMemoPubkey) {
    throw new Error(
      "sendShieldedTipAction: recipientMemoPubkey is required when memo is set"
    );
  }

  // 1. Build proof.
  const proofRes = await generateShieldedTransferProof({
    oldBalance: oldBalanceWei,
    oldBlinding,
    transferAmount: transferAmountWei,
  });

  const publicInputs = proofRes.publicInputs.map((s) => BigInt(s));
  const proof = proofRes.proof.map((s) => BigInt(s));

  // 2. Build EVM calldata.
  const calldataHex = await buildShieldedTransferCalldata(
    recipientCoaHex,
    publicInputs,
    proof
  );

  // 3. Encrypt memo (or send empty payload).
  let memoCiphertext: number[] = [];
  let memoEphPubkeyX = 0n;
  let memoEphPubkeyY = 1n;
  if (memo && memo.length > 0 && recipientMemoPubkey) {
    const encrypted = await encryptText(memo, recipientMemoPubkey);
    memoCiphertext = Array.from(encrypted.ciphertext);
    memoEphPubkeyX = encrypted.ephemeralPubkey.x;
    memoEphPubkeyY = encrypted.ephemeralPubkey.y;
  }

  // 4. Submit Cadence tx.
  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_SEND_SHIELDED_TIP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(recipientFlowAddr, t.Address),
      arg(recipientCoaHex, t.String),
      arg(
        publicInputs.map((v) => v.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt256)
      ),
      arg(
        proof.map((v) => v.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt256)
      ),
      arg(calldataHex, t.String),
      arg(
        memoCiphertext.map((b) => b.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt8)
      ),
      arg(memoEphPubkeyX.toString(), t.UInt256),
      arg(memoEphPubkeyY.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();

  return {
    txId,
    newBlinding: BigInt(proofRes.newBlinding),
    transferBlinding: BigInt(proofRes.transferBlinding),
    newCommit: {
      x: BigInt(proofRes.commitments.newCommit.x),
      y: BigInt(proofRes.commitments.newCommit.y),
    },
    newBalanceWei: oldBalanceWei - transferAmountWei,
  };
}

// ─── Unwrap action ─────────────────────────────────────────────────────────────

export interface UnwrapParams {
  claimedAmountWei: bigint;
  recipientEvmHex: string;
  oldBalanceWei: bigint;
  oldBlinding: bigint;
  toCadenceVault?: boolean;
}

export interface UnwrapResult {
  txId: string;
  newBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

export async function unwrapAction(params: UnwrapParams): Promise<UnwrapResult> {
  const {
    claimedAmountWei,
    recipientEvmHex,
    oldBalanceWei,
    oldBlinding,
    toCadenceVault = false,
  } = params;

  if (claimedAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, claim ${claimedAmountWei} wei`
    );
  }

  const amountRes = await generateAmountDiscloseProof(claimedAmountWei);
  const transferRes = await generateShieldedTransferProof({
    oldBalance: oldBalanceWei,
    oldBlinding,
    transferAmount: claimedAmountWei,
    transferBlinding: BigInt(amountRes.blinding),
  });

  const txCommit: [bigint, bigint] = [
    BigInt(amountRes.txCommit[0]),
    BigInt(amountRes.txCommit[1]),
  ];
  const amountProof = amountRes.proof.map((s) => BigInt(s));
  const transferPublicInputs = transferRes.publicInputs.map((s) => BigInt(s));
  const transferProof = transferRes.proof.map((s) => BigInt(s));

  const calldataHex = await buildUnwrapCalldata(
    claimedAmountWei,
    recipientEvmHex,
    txCommit,
    amountProof,
    transferPublicInputs,
    transferProof
  );

  const claimedAmountUFix64 = formatWeiToFlowUFix64(claimedAmountWei);

  const fcl = await getFcl();

  const cadence = toCadenceVault ? TX_UNWRAP_TO_VAULT : TX_UNWRAP;
  const args = toCadenceVault
    ? (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
        arg(claimedAmountUFix64, t.UFix64),
        arg(
          txCommit.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          amountProof.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          transferPublicInputs.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          transferProof.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(calldataHex, t.String),
      ]
    : (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
        arg(claimedAmountUFix64, t.UFix64),
        arg(recipientEvmHex, t.String),
        arg(
          txCommit.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          amountProof.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          transferPublicInputs.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(
          transferProof.map((v) => v.toString()),
          // @ts-expect-error — fcl types missing
          t.Array(t.UInt256)
        ),
        arg(calldataHex, t.String),
      ];

  const txId = await fcl.mutate({
    cadence,
    args,
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();

  return {
    txId,
    newBlinding: BigInt(transferRes.newBlinding),
    newCommit: {
      x: BigInt(transferRes.commitments.newCommit.x),
      y: BigInt(transferRes.commitments.newCommit.y),
    },
    newBalanceWei: oldBalanceWei - claimedAmountWei,
  };
}

// ─── PrivateTip Cadence script builders ───────────────────────────────────────

export function buildIsPausedScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(): Bool {
      return PrivateTip.isPaused()
    }
  `;
}

export function buildGetShieldedTipsByRecipientScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(recipient: Address): [PrivateTip.TipMetadata] {
      return PrivateTip.getShieldedTipsByRecipient(recipient: recipient)
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

// ─── Memo encryption — recipient pubkey lookup (PrivateTip-specific) ──────────

/** Resolve a recipient's published memo pubkey via PrivateTip.getMemoPubkey. */
export async function getRecipientMemoPubkey(flowAddr: string): Promise<Point | null> {
  const fcl = await getFcl();
  const script = `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(owner: Address): {String: UInt256}? {
      return PrivateTip.getMemoPubkey(owner: owner)
    }
  `;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await fcl.query({
      cadence: script,
      args: (arg: any, t: any) => [arg(flowAddr, t.Address)],
    })) as { x: string; y: string } | null;
    if (!result) return null;
    return { x: BigInt(result.x), y: BigInt(result.y) };
  } catch {
    return null;
  }
}

/** Check whether an account has BOTH a COA and a published MemoKey. */
export async function recipientFullyConfigured(flowAddr: string): Promise<{
  hasCoa: boolean;
  hasMemoKey: boolean;
}> {
  const [coaOk, pk] = await Promise.all([
    hasCOA(flowAddr, "testnet"),
    getRecipientMemoPubkey(flowAddr),
  ]);
  return { hasCoa: coaOk, hasMemoKey: pk !== null };
}
