/// Tip action helpers for PrivateTip -- encrypt/decrypt proof generation and transaction submission.
///
/// NOTE on SDK compatibility:
/// @openjanus/sdk/crypto (buildEncryptProof, buildDecryptProof, generateBlinding) uses Node.js
/// APIs (fs, path) for circuit artifact loading and does NOT work in the browser. The proof
/// generation is delegated to server-side API routes (/api/proof/encrypt, /api/proof/decrypt).
/// Only @openjanus/sdk/tokens (JanusFlow) is imported client-side since its Cadence-related
/// methods use FCL-based HTTP communication.
///
/// All BigInt literals use BigInt() constructor instead of `n` suffix for ES2017 target compat.

import { JanusFlow } from "@openjanus/sdk/tokens";
import type {
  Ciphertext,
  EncryptProofResult,
  DecryptProofResult,
  EncryptedSlot,
} from "@openjanus/sdk/tokens";
import type { Point } from "@openjanus/sdk";

/** Network to use for JanusFlow and all operations. */
const FLOW_NETWORK = "testnet" as const;

/** Max amount value for BSGS decrypt (search space). */
const BSGS_MAX_VALUE: bigint = BigInt("100000000000000"); // 1M FLOW in attoflow (10^8 * 10^10)

/** Attosec per FLOW (UFix64 has 8 decimals, attoflow has 18 decimals). */
const ATTOFLOW_PER_FLOW: bigint = BigInt("1000000000000000000");

// ─── JanusFlow Singleton ────────────────────────────────────────────────────────

let _janusFlow: JanusFlow | null = null;

/**
 * Get or create the shared JanusFlow SDK instance.
 * configure() is called once on first access. Other methods work after that.
 */
export async function getJanusFlow(): Promise<JanusFlow> {
  if (!_janusFlow) {
    _janusFlow = new JanusFlow({ network: FLOW_NETWORK });
    await _janusFlow.configure();
  }
  return _janusFlow;
}

// ─── Pubkey Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a point is the BabyJubJub identity point (0, 1) -- meaning not registered.
 */
export function isIdentityPoint(p: Point): boolean {
  return p.x === BigInt(0) && p.y === BigInt(1);
}

/**
 * Check if a given recipient address has a registered BabyJubJub pubkey.
 *
 * @param recipientAddr  The Flow address of the recipient
 * @returns              The pubkey Point if registered, null if not
 */
export async function checkRecipientPubkey(
  recipientAddr: string
): Promise<Point | null> {
  const janusFlow = await getJanusFlow();
  const pk = await janusFlow.getPubkey(recipientAddr);
  if (isIdentityPoint(pk)) return null;
  return pk;
}

// ─── Encrypt Proof Generation ───────────────────────────────────────────────────

/**
 * Generate an ElGamal encrypt-consistency proof for wrapping FLOW into a tip.
 *
 * Delegates to the server-side API route because @openjanus/sdk/crypto uses
 * Node.js APIs (fs) that are not available in the browser.
 *
 * @param value           Amount in FLOW as a decimal string (e.g. "10.0")
 * @param recipientPubkey The recipient's BabyJubJub public key [x, y] as bigints
 * @returns               Server response with ciphertext, proof, and publicInputs
 */
export async function generateEncryptProof(
  value: string,
  recipientPubkey: Point
): Promise<{
  ciphertext: { c1: [string, string]; c2: [string, string] };
  proof: string[];
  publicInputs: string[];
}> {
  const valueAtto = parseFlowToAttoflow(value);

  const response = await fetch("/api/proof/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value: valueAtto.toString(),
      recipientPubkey: [recipientPubkey.x.toString(), recipientPubkey.y.toString()],
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Encrypt proof generation failed");
  }

  return response.json();
}

// ─── Decrypt Proof Generation ───────────────────────────────────────────────────

/**
 * Generate a decrypt-open proof for claiming accumulated tips.
 *
 * Delegates to the server-side API route because @openjanus/sdk/crypto uses
 * Node.js APIs (fs) that are not available in the browser.
 *
 * @param slot      The encrypted slot from JanusToken (as Ciphertext)
 * @param secretKey The recipient's BabyJubJub secret key
 * @param amount    The decrypted total amount in attoflow
 * @returns         Server response with proof and publicInputs
 */
export async function generateDecryptProof(
  slot: Ciphertext,
  secretKey: bigint,
  amount: bigint
): Promise<{
  proof: string[];
  publicInputs: string[];
}> {
  const response = await fetch("/api/proof/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertext: {
        c1: [slot.c1.x.toString(), slot.c1.y.toString()],
        c2: [slot.c2.x.toString(), slot.c2.y.toString()],
      },
      secretKey: secretKey.toString(),
      amount: amount.toString(),
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Decrypt proof generation failed");
  }

  return response.json();
}

// ─── Cadence Script Queries ─────────────────────────────────────────────────────

/**
 * Build a Cadence script to check whether PrivateTip is paused.
 * Used with useFlowQuery.
 */
export function buildIsPausedScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1

    access(all) fun main(): Bool {
      return PrivateTip.isPaused()
    }
  `;
}

/**
 * Build a Cadence script to get tips by recipient.
 * Used with useFlowQuery.
 */
export function buildGetTipsScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1

    access(all) fun main(recipient: Address): [PrivateTip.TipInfo] {
      return PrivateTip.getTipsByRecipient(recipient: recipient)
    }
  `;
}

/**
 * Build a Cadence script to get the tip count for a recipient.
 */
export function buildGetTipCountScript(): string {
  return `
    import PrivateTip from 0xb9ac529c14a4c5a1

    access(all) fun main(recipient: Address): UInt64 {
      return PrivateTip.getTipCount(recipient: recipient)
    }
  `;
}

// ─── Address / Balance Helpers ─────────────────────────────────────────────────

/**
 * Convert a FLOW amount string to attoflow (BigInt).
 * UFix64 format: up to 8 decimal places.
 * 1 FLOW = 10^18 attoflow.
 *
 * @param flowStr  FLOW amount string (e.g. "10.0", "0.5")
 * @returns        Amount in attoflow as BigInt
 */
export function parseFlowToAttoflow(flowStr: string): bigint {
  // Remove whitespace
  const trimmed = flowStr.trim();
  const parts = trimmed.split(".");
  let wholeStr = parts[0] || "0";
  let fracStr = parts[1] || "";

  // Pad fraction to 18 decimals (attoflow precision)
  // But UFix64 is only 8 decimals, so we pad to 18
  while (fracStr.length < 18) {
    fracStr += "0";
  }
  if (fracStr.length > 18) {
    fracStr = fracStr.slice(0, 18);
  }

  const combined = wholeStr + fracStr;
  // Remove leading zeros
  const clean = combined.replace(/^0+/, "") || "0";
  return BigInt(clean);
}

/**
 * Convert attoflow to a FLOW amount string (8 decimal places).
 *
 * @param attoflow  Amount in attoflow as BigInt
 * @returns         FLOW amount string (e.g. "10.00000000")
 */
export function formatAttoflowToFlow(attoflow: bigint): string {
  const whole = attoflow / ATTOFLOW_PER_FLOW;
  const remainder = attoflow % ATTOFLOW_PER_FLOW;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, 8);
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Format a BabyJubJub point as (x, y) hex string for display.
 */
export function formatPubkey(pk: Point): string {
  const xHex = `0x${pk.x.toString(16)}`;
  const yHex = `0x${pk.y.toString(16)}`;
  return `(${xHex}, ${yHex})`;
}

/**
 * Validate a Flow address format.
 */
export function isValidFlowAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{16}$/.test(addr.trim());
}

/**
 * Validate a FLOW amount string (positive, up to 8 decimal places).
 */
export function isValidFlowAmount(amount: string): boolean {
  return /^\d+(\.\d{1,8})?$/.test(amount.trim()) &&
    parseFloat(amount.trim()) > 0;
}
