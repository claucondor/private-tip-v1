/// Tip action helpers — v0.3 rewrite.
///
/// This module wires the frontend to:
///   - JanusFlow EVM (v0.3 Pedersen):     0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
///   - JanusFlow Cadence router (v0.3):   0x5dcbeb41055ec57e
///   - PrivateTip Cadence router (v0.3):  0xb9ac529c14a4c5a1 (orchestrator, no escrow)
///
/// The privacy contract:
///   - wrap()              : msg.value VISIBLE | commitment opaque   (boundary in)
///   - shieldedTransfer()  : amount HIDDEN on calldata/events/storage (full shielded)
///   - unwrap()            : claimedAmount + recipient VISIBLE        (boundary out)
///
/// Proof generation runs SERVER-SIDE via /api/proof/{encrypt,decrypt} (the
/// SDK's crypto module uses fs/path; not browser-safe). The browser only does
/// EVM RPC reads, calldata building, and FCL submission.
///
/// User-side state to PERSIST (apps SHOULD store these locally — wallet
/// encryption, IndexedDB, etc.):
///   - balance       : current cleartext balance (wei)
///   - blinding      : 128-bit blinding for the current commitment
/// Without these, the user cannot construct a future shieldedTransfer or
/// unwrap. The MVP demo uses a "wallet-derived" approach (HKDF from a fixed
/// signed message) — see notes in send/page.tsx and claim/page.tsx.

import { JsonRpcProvider, Interface } from "ethers";
import {
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_VERSION,
  JANUS_TOKEN_BASE_ABI,
  JANUS_FLOW_EXTRA_ABI,
} from "@openjanus/sdk/tokens";

// FCL has no type declarations bundled.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fcl = any;
let _fcl: Fcl | null = null;
async function getFcl(): Promise<Fcl> {
  if (!_fcl) {
    // @ts-expect-error — no types for @onflow/fcl
    _fcl = await import("@onflow/fcl");
  }
  return _fcl!;
}

// ─── Addresses (re-export from SDK so the UI shows them) ────────────────────────

export const JANUS_FLOW_EVM = JANUS_FLOW_EVM_ADDRESS;
export const JANUS_FLOW_CADENCE = JANUS_FLOW_CADENCE_ADDRESS;
export const PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1";
export const SDK_VERSION = JANUS_FLOW_VERSION;

/** Flow EVM testnet RPC. */
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;

let _provider: JsonRpcProvider | null = null;
function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  }
  return _provider;
}

// Merged ABI: base JanusToken reads + JanusFlow wrap/unwrap/MAX_WRAP.
const janusIface = new Interface([
  ...JANUS_TOKEN_BASE_ABI,
  ...JANUS_FLOW_EXTRA_ABI,
]);

// ─── Local types ────────────────────────────────────────────────────────────────

export interface Point {
  x: bigint;
  y: bigint;
}

/** Result of /api/proof/encrypt (amount-disclose proof). */
export interface AmountDiscloseProofResponse {
  commitment: { x: string; y: string };
  txCommit: [string, string];
  proof: string[];          // uint256[8]
  publicInputs: string[];   // [amount, Cx, Cy]
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
  proof: string[];          // uint256[8]
  publicInputs: string[];   // [C_old, C_tx, C_new] (6 values)
  transferBlinding: string;
  newBlinding: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

export const FLOW_SCALE: bigint = BigInt("1000000000000000000");

/** Identity point on BabyJubJub — returned for accounts never written to. */
export function isIdentityPoint(p: Point): boolean {
  return p.x === BigInt(0) && p.y === BigInt(1);
}

// ─── EVM reads ─────────────────────────────────────────────────────────────────

/**
 * Read the Pedersen commitment of an account's hidden balance.
 * Returns the identity point (0, 1) for accounts that have never been written to.
 */
export async function getCommitment(coaEvmHex: string): Promise<Point> {
  const provider = getProvider();
  const data = janusIface.encodeFunctionData("balanceOfCommitmentXY", [
    coaEvmHex,
  ]);
  const result = await provider.call({ to: JANUS_FLOW_EVM, data });
  const [x, y] = janusIface.decodeFunctionResult(
    "balanceOfCommitmentXY",
    result
  );
  return { x: BigInt(x), y: BigInt(y) };
}

/** Read the cleartext `totalLocked` custody pool size (wei). */
export async function getTotalLocked(): Promise<bigint> {
  const provider = getProvider();
  const data = janusIface.encodeFunctionData("totalLocked", []);
  const result = await provider.call({ to: JANUS_FLOW_EVM, data });
  const [v] = janusIface.decodeFunctionResult("totalLocked", result);
  return BigInt(v);
}

// ─── COA resolution (Flow Address → EVM hex) ────────────────────────────────────

/**
 * Resolve a Flow account's COA EVM address via Cadence script.
 */
export async function getCoaEvmAddress(flowAddress: string): Promise<string> {
  const script = `
    import EVM from 0x8c5303eaa26202d6

    access(all) fun main(addr: Address): String {
      let acct = getAccount(addr)
      let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
        ?? panic("No COA at /public/evm for ".concat(addr.toString()))
      return coa.address().toString()
    }
  `;
  const fcl = await getFcl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await fcl.query({
    cadence: script,
    args: (arg: any, t: any) => [arg(flowAddress, t.Address)],
  })) as string;
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

// ─── Calldata builders ──────────────────────────────────────────────────────────

/**
 * Build calldata for `JanusFlow.wrap(uint256[2] txCommit, uint256[8] amountProof)`.
 * Returns hex string WITHOUT leading 0x (Cadence side `.decodeHex()`s it).
 */
export function buildWrapCalldata(
  txCommit: [bigint, bigint],
  amountProof: bigint[]
): string {
  return janusIface
    .encodeFunctionData("wrap", [txCommit, amountProof])
    .slice(2);
}

/**
 * Build calldata for `JanusFlow.shieldedTransfer(address, uint256[6], uint256[8])`.
 * Returns hex string WITHOUT leading 0x.
 */
export function buildShieldedTransferCalldata(
  to: string,
  publicInputs: bigint[],
  proof: bigint[]
): string {
  return janusIface
    .encodeFunctionData("shieldedTransfer", [to, publicInputs, proof])
    .slice(2);
}

/**
 * Build calldata for the full unwrap signature.
 */
export function buildUnwrapCalldata(
  claimedAmountWei: bigint,
  recipientEvmHex: string,
  txCommit: [bigint, bigint],
  amountProof: bigint[],
  transferPublicInputs: bigint[],
  transferProof: bigint[]
): string {
  return janusIface
    .encodeFunctionData("unwrap", [
      claimedAmountWei,
      recipientEvmHex,
      txCommit,
      amountProof,
      transferPublicInputs,
      transferProof,
    ])
    .slice(2);
}

// ─── Proof generation (delegates to server routes) ──────────────────────────────

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

// ─── Cadence templates (FCL-friendly, no SDK import needed in browser) ──────────

/** Wrap: deposits N FLOW into the signer's JanusFlow shielded slot. */
export const TX_WRAP = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    calldataHex: String
) {
    let vault: @{FungibleToken.Vault}
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault in signer storage")
        self.vault <- flowVault.withdraw(amount: amount)
    }

    execute {
        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <-(self.vault as! @FlowToken.Vault),
            txCommit: txCommit,
            amountProof: amountProof,
            calldataHex: calldataHex
        )
    }
}
`;

/** Send-shielded-tip: calls JanusFlow.shieldedTransfer + PrivateTip.recordTip atomically. */
export const TX_SEND_SHIELDED_TIP = `
import JanusFlow from 0x5dcbeb41055ec57e
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    recipient: Address,
    recipientEVMHex: String,
    publicInputs: [UInt256],
    proof: [UInt256],
    calldataHex: String,
    memo: String
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
        let memoOpt: String? = memo.length > 0 ? memo : nil

        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: recipient,
            ciphertextRef: ciphertextRef,
            memo: memoOpt
        )
        log("PrivateTip.recordTip emitted shielded tipID=".concat(tipID.toString()))
    }
}
`;

/** Unwrap: releases N FLOW from the signer's shielded slot to a target EVM address. */
export const TX_UNWRAP = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    recipientEVMHex: String,
    txCommit: [UInt256],
    amountProof: [UInt256],
    transferPublicInputs: [UInt256],
    transferProof: [UInt256],
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.unwrap(
            signer: signer,
            claimedAmount: claimedAmount,
            recipientEVMHex: recipientEVMHex,
            txCommit: txCommit,
            amountProof: amountProof,
            transferPublicInputs: transferPublicInputs,
            transferProof: transferProof,
            calldataHex: calldataHex
        )
    }
}
`;

// ─── End-to-end actions ─────────────────────────────────────────────────────────

export interface WrapParams {
  /** Whole-FLOW amount as UFix64 string (e.g. "5.00000000"). */
  amountUFix64: string;
  /** Amount in wei (must match amountUFix64). */
  amountWei: bigint;
}

export interface WrapResult {
  /** Sealed Cadence tx id. */
  txId: string;
  /** Blinding factor used — CALLER MUST PERSIST for future spends. */
  blinding: bigint;
  /** Resulting commitment (caller's new shielded balance). */
  commitment: Point;
}

/**
 * Wrap N FLOW into the caller's JanusFlow shielded slot.
 *
 * Side-effects:
 *   - msg.value = amountWei (VISIBLE — this is the wrap boundary).
 *   - Sender's Pedersen commitment is updated: C += Pedersen(amountWei, blinding).
 *
 * RETURNS the random blinding. The CALLER MUST STORE IT — without (balance,
 * blinding) you cannot later construct a shieldedTransfer or unwrap from the
 * resulting commitment.
 */
export async function wrapAction(params: WrapParams): Promise<WrapResult> {
  const { amountUFix64, amountWei } = params;

  const proofRes = await generateAmountDiscloseProof(amountWei);
  const txCommit: [bigint, bigint] = [
    BigInt(proofRes.txCommit[0]),
    BigInt(proofRes.txCommit[1]),
  ];
  const proof = proofRes.proof.map((s) => BigInt(s));

  const calldataHex = buildWrapCalldata(txCommit, proof);

  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_WRAP,
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

export interface SendShieldedTipParams {
  /** Recipient's Flow Cadence address (for PrivateTip indexing). */
  recipientFlowAddr: string;
  /** Recipient's COA EVM hex (target of JanusFlow.shieldedTransfer). */
  recipientCoaHex: string;
  /** Amount being sent in wei (HIDDEN on-chain after the call). */
  transferAmountWei: bigint;
  /** Caller's CURRENT cleartext balance in wei (must match stored commit). */
  oldBalanceWei: bigint;
  /** Caller's CURRENT blinding factor for the stored commit. */
  oldBlinding: bigint;
  /** Optional public memo (max 280 chars). */
  memo?: string;
}

export interface SendShieldedTipResult {
  /** Sealed Cadence tx id. */
  txId: string;
  /** New blinding for the residual commitment — CALLER MUST PERSIST. */
  newBlinding: bigint;
  /** Blinding used for the transfer commit — useful for off-chain receipts. */
  transferBlinding: bigint;
  /** Sender's new (residual) commitment. */
  newCommit: Point;
  /** Sender's new cleartext balance (oldBalance - transferAmount). */
  newBalanceWei: bigint;
}

/**
 * Send a shielded tip — full pipeline.
 *
 *   1. Build the confidential-transfer proof (server-side).
 *   2. Build EVM calldata for JanusFlow.shieldedTransfer.
 *   3. Submit the Cadence transaction that calls JanusFlow.shieldedTransfer
 *      and PrivateTip.recordTip atomically.
 *
 * Privacy guarantees (from JanusFlow v0.3):
 *   - Calldata: amount hidden in the Pedersen commits, NO cleartext.
 *   - Events: JanusFlow emits ConfidentialTransfer(from, to) — NO amount.
 *            PrivateTip emits TipSentShielded — NO amount.
 *   - Storage: commitment updates are point ops; observer sees C changes
 *              but cannot extract the amount.
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
  } = params;

  if (transferAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, need ${transferAmountWei} wei`
    );
  }

  // 1. Build proof
  const proofRes = await generateShieldedTransferProof({
    oldBalance: oldBalanceWei,
    oldBlinding,
    transferAmount: transferAmountWei,
  });

  const publicInputs = proofRes.publicInputs.map((s) => BigInt(s));
  const proof = proofRes.proof.map((s) => BigInt(s));

  // 2. Build EVM calldata
  const calldataHex = buildShieldedTransferCalldata(
    recipientCoaHex,
    publicInputs,
    proof
  );

  // 3. Submit Cadence tx
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
      arg(memo ?? "", t.String),
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

export interface UnwrapParams {
  /** Wei being released (VISIBLE — boundary out). */
  claimedAmountWei: bigint;
  /** EVM hex address that receives the FLOW (typically the signer's own COA). */
  recipientEvmHex: string;
  /** Caller's CURRENT cleartext balance in wei. */
  oldBalanceWei: bigint;
  /** Caller's CURRENT blinding factor. */
  oldBlinding: bigint;
}

export interface UnwrapResult {
  txId: string;
  newBlinding: bigint;
  newCommit: Point;
  newBalanceWei: bigint;
}

/**
 * Unwrap (release) N FLOW from the caller's shielded slot.
 *
 * Requires TWO proofs:
 *   1. amount-disclose:  binds claimedAmountWei to a fresh Pedersen commit.
 *   2. confidential-transfer: proves caller's stored commit = txCommit + newCommit.
 *
 * NOTE: claimedAmountWei is VISIBLE on calldata and emitted in
 * JanusFlow.Unwrapped(user, recipient, amount). This is by design — it's
 * the unwrap boundary.
 */
export async function unwrapAction(params: UnwrapParams): Promise<UnwrapResult> {
  const {
    claimedAmountWei,
    recipientEvmHex,
    oldBalanceWei,
    oldBlinding,
  } = params;

  if (claimedAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, claim ${claimedAmountWei} wei`
    );
  }

  // Generate amount-disclose proof for the claimed amount.
  const amountRes = await generateAmountDiscloseProof(claimedAmountWei);
  // Generate confidential-transfer proof using the SAME blinding for tx commit.
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

  const calldataHex = buildUnwrapCalldata(
    claimedAmountWei,
    recipientEvmHex,
    txCommit,
    amountProof,
    transferPublicInputs,
    transferProof,
  );

  const claimedAmountUFix64 = formatWeiToFlowUFix64(claimedAmountWei);

  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_UNWRAP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
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
    ],
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

// ─── PrivateTip Cadence script builders ─────────────────────────────────────────

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

// ─── Address / Balance Helpers ─────────────────────────────────────────────────

export function parseFlowToWei(flowStr: string): bigint {
  const trimmed = flowStr.trim();
  const parts = trimmed.split(".");
  const wholeStr = parts[0] || "0";
  let fracStr = parts[1] || "";
  while (fracStr.length < 18) fracStr += "0";
  if (fracStr.length > 18) fracStr = fracStr.slice(0, 18);
  const combined = wholeStr + fracStr;
  const clean = combined.replace(/^0+/, "") || "0";
  return BigInt(clean);
}

export function formatWeiToFlow(wei: bigint, decimals = 8): string {
  const whole = wei / FLOW_SCALE;
  const remainder = wei % FLOW_SCALE;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, decimals);
  return `${whole.toString()}.${fracStr}`;
}

/** UFix64-safe formatting (always 8 decimal places). */
export function formatWeiToFlowUFix64(wei: bigint): string {
  return formatWeiToFlow(wei, 8);
}

export function formatPoint(p: Point): string {
  return `(0x${p.x.toString(16)}, 0x${p.y.toString(16)})`;
}

export function isValidFlowAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{16}$/.test(addr.trim());
}

export function isValidFlowAmount(amount: string): boolean {
  return /^\d+(\.\d{1,18})?$/.test(amount.trim()) && parseFloat(amount.trim()) > 0;
}
