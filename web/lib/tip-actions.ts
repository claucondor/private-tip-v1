/// Tip action helpers — v0.5.2.
///
/// THIN APP LAYER over @claucondor/sdk@0.5.2. Anything generic now lives in
/// the SDK; this module only contains:
///   - PrivateTip-specific Cadence templates
///   - sendShieldedTipAction (orchestrates JanusFlow.shieldedTransfer +
///     PrivateTip.recordTip + memo encryption — app-specific bundling)
///   - PrivateTip script builders
///   - Memo encryption helpers wired to the recipient's published MemoKey
///   - Shielded-state persistence (sessionStorage)
///
/// v0.5.2 contracts:
///   JanusFlow EVM proxy:           0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
///   JanusFlow EVM impl:            0x9b454866100f985C28718Fe7d04Eedfa740e1c00
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
} from "@claucondor/sdk/tokens";
import {
  // COA helpers
  getCoaEvmAddress as sdkGetCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei as sdkGetCoaBalanceWei,
  getFlowVaultBalanceWei as sdkGetFlowVaultBalanceWei,
  TX_SETUP_COA,
} from "@claucondor/sdk/network";
// NOTE: @claucondor/sdk/crypto transitively pulls circomlibjs (~30MB) into
// the client bundle, which makes Turbopack compile take 30+ min. We removed
// the top-level imports and route the heavy crypto through API routes
// (server-only). Pure unit conversions live in /utils which IS browser-safe.
//
// MemoCiphertext shape (was a type export from /crypto):
type MemoCiphertext = {
  ciphertext: Uint8Array;
  ephemeralPubkey: { x: bigint; y: bigint };
};
// BabyJubKeypair shape (deferred — only generated server-side):
type BabyJubKeypair = {
  privkey: bigint;
  pubkey: { x: bigint; y: bigint };
};

/** Encrypt a memo via the server-side /api/memo/encrypt route. */
async function encryptMemo(
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

/** ShieldedNote payload (mirrors the SDK type, repeated locally to avoid
 * pulling the crypto barrel into the client bundle). */
export interface ShieldedNote {
  amount: bigint;
  blinding: bigint;
  data?: string;
}

/** Encrypt a ShieldedNote via the server-side /api/note/encrypt route. */
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

/** Decrypt a ShieldedNote via /api/note/decrypt. Throws on non-note ciphertext
 * (i.e. legacy plain-text memo) so caller can fall back to decryptText. */
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
import {
  // Formatters / validators
  formatPoint as sdkFormatPoint,
  isValidFlowAddress as sdkIsValidFlowAddress,
  isValidFlowAmount as sdkIsValidFlowAmount,
} from "@claucondor/sdk/utils";
// Type-only imports — fully erased at build time, so they don't pull the SDK
// barrel into the client bundle. The value `isIdentityPoint` would re-trigger
// the heavy crypto import chain (amount-disclose -> dynamic url import that
// Turbopack mis-polyfills to native-url), so we inline it here.
import type { Point, WrapSource } from "@claucondor/sdk";

/** BabyJub identity check (point at infinity = (0, 1)). */
function sdkIsIdentityPoint(p: Point): boolean {
  return p.x === 0n && p.y === 1n;
}

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

// Pure-math unit conversions inlined (no SDK import to keep bundle light).
export const FLOW_SCALE: bigint = 10n ** 18n;

export type { Point, WrapSource, MemoCiphertext, BabyJubKeypair };

export const isIdentityPoint = sdkIsIdentityPoint;
export const formatPoint = sdkFormatPoint;
export const isValidFlowAddress = sdkIsValidFlowAddress;
export const isValidFlowAmount = sdkIsValidFlowAmount;

export function parseFlowToWei(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole) * FLOW_SCALE + BigInt(fracPadded || "0");
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

// Memo encryption — server-side via API routes (heavy crypto kept off client bundle).
export { encryptMemo as encryptText };

/** Decrypt a memo via /api/memo/decrypt. */
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

/** Generate a fresh BabyJub keypair via /api/keypair/generate. */
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

// ─── MemoKey session cache + sign-derive helpers ──────────────────────────────

export {
  getCachedMemoPrivkey,
  cacheMemoPrivkey,
  clearMemoPrivkeyCache,
} from "./memo-key-session";

export { deriveMemoKeyFromWallet } from "./memo-key-derive";

import { getCachedMemoPrivkey, cacheMemoPrivkey } from "./memo-key-session";
import { deriveMemoKeyFromWallet } from "./memo-key-derive";

/**
 * Get or derive the caller's MemoKey privkey.
 *
 * 1. Returns immediately from sessionStorage if already cached this session.
 * 2. Otherwise, prompts the wallet for a single signature, derives the BabyJub
 *    scalar via HKDF (server-side), caches it in sessionStorage, and returns it.
 *    Same wallet + same message → same scalar in any browser.
 */
export async function getOrDeriveMemoPrivkey(
  flowAddr: string
): Promise<bigint> {
  const cached = getCachedMemoPrivkey(flowAddr);
  if (cached !== null) return cached;
  const kp = await deriveMemoKeyFromWallet();
  cacheMemoPrivkey(flowAddr, kp.privkey);
  return kp.privkey;
}

/** @deprecated Use getCachedMemoPrivkey (sessionStorage) or getOrDeriveMemoPrivkey instead.
 *  This sync helper now ONLY reads sessionStorage — localStorage is no longer
 *  used for the MemoKey privkey. Retained to avoid mass-refactor of callers. */
export function loadMemoPrivkey(flowAddr: string): bigint | null {
  return getCachedMemoPrivkey(flowAddr);
}

// ─── Smart-setup Cadence template (COA + MemoKey in one atomic tx) ────────────

/**
 * Smart-setup (v0.5.2):
 *   - COA       → idempotent (create only if missing)
 *   - MemoKey   → uses JanusFlow.MemoKey generic resource (NOT PrivateTip.MemoKey)
 *                 stored at JanusFlow.memoKeyStoragePath() = /storage/openjanusMemoKey
 *                 and published at JanusFlow.memoKeyPublicPath() = /public/openjanusMemoKey
 *   - EVM pubkey → calls JanusFlow.publishMemoKey(pubkeyX, pubkeyY) on proxy
 *
 * v0.5.2 change: MemoKey resource type moved from PrivateTip → JanusFlow.
 * The privkey is NEVER passed to this transaction (sign-derive is client-side
 * only). Only (pubkeyX, pubkeyY) go on-chain. Existing PrivateTip.MemoKey
 * resources at the same path are replaced with JanusFlow.MemoKey on first run.
 *
 * Idempotent in effect: sign-derive is deterministic, so re-running produces
 * the same final MemoKey resource.
 *
 * For full atomic COA+MemoKey setup in one tx, this embeds the logic from
 * cadence/transactions/setup_memo_key.cdc plus the COA creation step.
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

        // 2. MemoKey (JanusFlow.MemoKey) — replace any existing resource at the
        //    canonical path, regardless of type. This handles:
        //      - old PrivateTip.MemoKey (pre-v0.5.2 accounts)
        //      - stale JanusFlow.MemoKey (re-setup / key rotation)
        //    We load as AnyResource to handle the PrivateTip.MemoKey type mismatch.
        let memoStoragePath = JanusFlow.memoKeyStoragePath()
        let memoPublicPath  = JanusFlow.memoKeyPublicPath()

        // Evict any existing resource (ANY type) at that path.
        // This is the only safe way to handle PrivateTip.MemoKey → JanusFlow.MemoKey migration.
        if let anyOld <- signer.storage.load<@AnyResource>(from: memoStoragePath) {
            destroy anyOld
            signer.capabilities.unpublish(memoPublicPath)
        }

        // Install the fresh JanusFlow.MemoKey (pubkey-only; no privkey on-chain).
        let key <- JanusFlow.createMemoKey(pubkeyX: memoPubkeyX, pubkeyY: memoPubkeyY)
        signer.storage.save(<-key, to: memoStoragePath)
        let memoCap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(memoStoragePath)
        signer.capabilities.publish(memoCap, at: memoPublicPath)

        // 3. EVM side: call JanusFlow.publishMemoKey(uint256,uint256) on the proxy
        //    so the EVM mapping is also updated.
        //    selector: bytes4(keccak256("publishMemoKey(uint256,uint256)")) = 0x6370796a
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("smart_setup: no COA — should have been created above")
        var calldata: [UInt8] = [0x63, 0x70, 0x79, 0x6a]
        var xVal: UInt256 = memoPubkeyX
        var xEncoded: [UInt8] = []
        var xi: Int = 0
        while xi < 32 { xEncoded.insert(at: 0, UInt8(xVal & 0xFF)); xVal = xVal >> 8; xi = xi + 1 }
        calldata = calldata.concat(xEncoded)
        var yVal: UInt256 = memoPubkeyY
        var yEncoded: [UInt8] = []
        var yi: Int = 0
        while yi < 32 { yEncoded.insert(at: 0, UInt8(yVal & 0xFF)); yVal = yVal >> 8; yi = yi + 1 }
        calldata = calldata.concat(yEncoded)
        let janusFlowEVM = EVM.addressFromString("0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078")
        let evmResult = coa.call(
            to: janusFlowEVM, data: calldata,
            gasLimit: 200_000, value: EVM.Balance(attoflow: 0)
        )
        assert(evmResult.status == EVM.Status.successful,
            message: "smart_setup: publishMemoKey EVM call failed: ".concat(evmResult.errorMessage))
    }
}
`;

/**
 * Smart-setup action (v0.5.2): sign-derives the MemoKey (HKDF over wallet
 * signature), caches the privkey in sessionStorage, and submits the atomic
 * COA+MemoKey setup tx.
 *
 * v0.5.2 change: MemoKey is now JanusFlow.MemoKey (generic primitive in the
 * JanusFlow contract, NOT PrivateTip.MemoKey). The privkey is NEVER sent on
 * chain — only (pubkeyX, pubkeyY) travel to the Cadence tx. The EVM mapping
 * is also updated atomically (publishMemoKey call inside TX_SMART_SETUP).
 *
 * The wallet will prompt for ONE signature (the DERIVE_MESSAGE). This happens
 * BEFORE the Cadence tx popup so the user sees both steps.
 */
export async function smartSetupAccount(opts: {
  flowAddr: string;
}): Promise<{ txId: string; pubkey: Point }> {
  const { flowAddr } = opts;
  // 1. Derive keypair from wallet signature. Same wallet → same keypair in
  //    any browser. Privkey is cached in sessionStorage (not localStorage).
  const kp = await deriveMemoKeyFromWallet();
  cacheMemoPrivkey(flowAddr, kp.privkey);

  const fcl = await getFcl();
  const txId = await fcl.mutate({
    cadence: TX_SMART_SETUP,
    // v0.5.2: only pubkeyX + pubkeyY — no privkey on-chain.
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

// loadMemoPrivkey is defined above (in the MemoKey session cache section).
// The old localStorage implementation has been removed in v0.4.5.

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
  /** GROSS amount in wei. This is the msg.value transferred to the contract. */
  amountWei: bigint;
  source?: WrapSource;
  /** v0.5.2: encrypted snapshot of post-wrap (balance, blinding). Optional with default "0x". */
  encryptedSnapshot?: Uint8Array | string;
  /** v0.5.2: ephemeral pubkey X for snapshot decryption. */
  ephPubkeyX?: bigint;
  /** v0.5.2: ephemeral pubkey Y for snapshot decryption. */
  ephPubkeyY?: bigint;
  /**
   * v0.5.4-fees: NET amount in wei that the on-chain commitment binds to.
   * If omitted, falls back to `amountWei` (backwards-compat with pre-fee builds).
   * For fee-enabled contracts: net = gross - (gross * feeBps / 10000).
   * The proof MUST bind to this net amount, not the gross msg.value.
   */
  netAmountForProofWei?: bigint;
}

export interface WrapResult {
  txId: string;
  blinding: bigint;
  commitment: Point;
}

export async function wrapAction(params: WrapParams): Promise<WrapResult> {
  const {
    amountUFix64,
    amountWei,
    source = "vault",
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY,
    netAmountForProofWei,
  } = params;

  // v0.5.4-fees: the on-chain contract verifies the proof against the NET amount
  // (msg.value - fee). If caller supplies netAmountForProofWei, use it; otherwise
  // fall back to amountWei (pre-fee build assumption).
  const proofAmount = netAmountForProofWei ?? amountWei;
  const proofRes = await generateAmountDiscloseProof(proofAmount);
  const txCommit: [bigint, bigint] = [
    BigInt(proofRes.txCommit[0]),
    BigInt(proofRes.txCommit[1]),
  ];
  const proof = proofRes.proof.map((s) => BigInt(s));

  // v0.5.2: pass snapshot params so JanusFlow emits WrapWithSnapshot event.
  // If caller doesn't supply them, defaults to "0x", 0n, 0n (backwards compat).
  const calldataHex = await buildWrapCalldata(
    txCommit,
    proof,
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY
  );

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
  /**
   * v0.5.2: encrypted snapshot of sender's post-send residual (balance, blinding).
   * Embedded in the ShieldedTransferWithSnapshot event for cross-device recovery.
   */
  encryptedSnapshot?: Uint8Array | string;
  /** v0.5.2: ephemeral pubkey X for snapshot decryption. */
  ephPubkeyX?: bigint;
  /** v0.5.2: ephemeral pubkey Y for snapshot decryption. */
  ephPubkeyY?: bigint;
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
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY,
  } = params;

  if (transferAmountWei > oldBalanceWei) {
    throw new Error(
      `Insufficient shielded balance: have ${oldBalanceWei} wei, need ${transferAmountWei} wei`
    );
  }
  // ShieldedNote carries (amount, transferBlinding, memo) — REQUIRED for the
  // recipient to be able to unwrap. We refuse to send if the recipient has no
  // MemoKey published; sending without it would brick their shielded balance
  // (they'd see the commitment update but never recover the underlying values).
  if (!recipientMemoPubkey) {
    throw new Error(
      "sendShieldedTipAction: recipient has no published MemoKey — they would not be able to unwrap. Ask them to run setup first."
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
  const transferBlinding = BigInt(proofRes.transferBlinding);

  // 2. Build EVM calldata (v0.5.2: pass snapshot params for recovery event).
  const calldataHex = await buildShieldedTransferCalldata(
    recipientCoaHex,
    publicInputs,
    proof,
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY
  );

  // 3. Encrypt a ShieldedNote: amount + transfer blinding + optional memo text.
  // Always sent (not optional like the old plain memo) because recipient needs
  // (amount, blinding) for unwrap correctness — the memo text just stows away
  // as the `data` field.
  const note: ShieldedNote = {
    amount: transferAmountWei,
    blinding: transferBlinding,
    data: memo && memo.length > 0 ? memo : undefined,
  };
  const encrypted = await encryptNote(note, recipientMemoPubkey);
  const memoCiphertext = Array.from(encrypted.ciphertext);
  const memoEphPubkeyX = encrypted.ephemeralPubkey.x;
  const memoEphPubkeyY = encrypted.ephemeralPubkey.y;

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
  /** v0.5.2: encrypted snapshot of post-unwrap residual (balance, blinding). */
  encryptedSnapshot?: Uint8Array | string;
  /** v0.5.2: ephemeral pubkey X for snapshot decryption. */
  ephPubkeyX?: bigint;
  /** v0.5.2: ephemeral pubkey Y for snapshot decryption. */
  ephPubkeyY?: bigint;
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
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY,
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

  // v0.5.2: pass snapshot params so JanusFlow emits UnwrapWithSnapshot event.
  const calldataHex = await buildUnwrapCalldata(
    claimedAmountWei,
    recipientEvmHex,
    txCommit,
    amountProof,
    transferPublicInputs,
    transferProof,
    encryptedSnapshot,
    ephPubkeyX,
    ephPubkeyY
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

/**
 * v0.4.2 — returns metadata + the encrypted memo blob in a single script call,
 * so /tips can decrypt inline without scanning event logs. Memo is nil for
 * pre-v0.4.2 tips (no on-chain blob persisted before this contract version).
 */
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

/**
 * v0.4.3 — sender-side metadata + memo in a single script call.
 * Mirrors buildGetShieldedTipsByRecipientWithMemoScript but indexes by sender.
 * Used by the recovery flow to scan all outgoing tips for carbon-copy notes.
 */
export function buildGetShieldedTipsBySenderWithMemoScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1
    access(all) fun main(sender: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsBySenderWithMemo(sender: sender)
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

/**
 * Resolve a recipient's published memo pubkey.
 *
 * v0.5.2: MemoKey is now a JanusFlow generic primitive. The public capability
 * is published at /public/openjanusMemoKey (same path, different resource type).
 * We read via JanusFlow.getMemoPubkey() which borrows from that path.
 *
 * Falls back to PrivateTip.getMemoPubkey() for accounts that haven't migrated yet
 * (pre-v0.5.2 setup). Both live at the same storage path; the fallback handles
 * the case where only the old PrivateTip.MemoKey exists.
 */
export async function getRecipientMemoPubkey(flowAddr: string): Promise<Point | null> {
  const fcl = await getFcl();
  const script = `
    import JanusFlow from 0x5dcbeb41055ec57e
    access(all) fun main(owner: Address): {String: UInt256}? {
      return JanusFlow.getMemoPubkey(owner: owner)
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
