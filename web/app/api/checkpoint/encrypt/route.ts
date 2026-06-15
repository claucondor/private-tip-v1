/// POST /api/checkpoint/encrypt — ECIES-encrypt a (balance, blinding) snapshot.
///
/// Called after a wrap or shielded-transfer to persist the sender's new state
/// on-chain via ShieldedCheckpoint.update(). The WrapWithSnapshot event flow
/// (Phase 4-6) will consume this route to write permanent checkpoints.
///
/// Internally calls SDK encryptSnapshot({ balance, blinding }, { x, y }) which
/// uses BabyJub ECIES + AES-GCM. Typically encrypted to the sender's own memo
/// pubkey (self-directed checkpoint), but any BabyJub pubkey is accepted.
///
/// Body: {
///   balance: string,             // decimal string (new balance after operation, wei)
///   blinding: string,            // decimal string (new blinding factor)
///   recipientPubkeyX: string,    // decimal string (BabyJub pubkey X — sender's memo pubkey)
///   recipientPubkeyY: string,    // decimal string (BabyJub pubkey Y — sender's memo pubkey)
/// }
/// Response: {
///   ciphertext: string,          // hex-encoded ECIES blob (iv + ct + tag)
///   ephemeralPubkey: { x: string, y: string },  // ephemeral BabyJub key for ECDH on receiver side
/// }

import { NextRequest, NextResponse } from "next/server";
import { encryptSnapshot } from "@claucondor/sdk";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { balance, blinding, recipientPubkeyX, recipientPubkeyY } = body ?? {};

    const required = { balance, blinding, recipientPubkeyX, recipientPubkeyY };
    for (const [key, val] of Object.entries(required)) {
      if (typeof val !== "string") {
        return NextResponse.json(
          { error: `${key} required (decimal string)` },
          { status: 400 }
        );
      }
    }

    const result = await encryptSnapshot(
      { balance: BigInt(balance), blinding: BigInt(blinding) },
      { x: BigInt(recipientPubkeyX), y: BigInt(recipientPubkeyY) }
    );

    // Encode ciphertext as hex for JSON transport (Uint8Array is not JSON-serializable).
    const ciphertextHex = Buffer.from(result.ciphertext).toString("hex");

    return NextResponse.json({
      ciphertext: ciphertextHex,
      ephemeralPubkey: {
        x: result.ephemeralPubkey.x.toString(),
        y: result.ephemeralPubkey.y.toString(),
      },
    });
  } catch (err) {
    console.error("[/api/checkpoint/encrypt] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
