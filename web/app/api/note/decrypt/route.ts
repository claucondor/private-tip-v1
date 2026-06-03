/// POST /api/note/decrypt — server-side shielded-note decryption.
///
/// Body: {
///   ciphertext: number[],
///   ephemeralPubkey: { x: string, y: string },
///   privkey: string  (decimal BabyJub scalar)
/// }
/// Response: { amount: string, blinding: string, data?: string }
///
/// Fails (400) if the ciphertext doesn't decode to a versioned ShieldedNote
/// (likely a legacy plain-text memo from before SDK v0.4.4).

import { NextRequest, NextResponse } from "next/server";
import { decryptShieldedNote } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { ciphertext, ephemeralPubkey, privkey } = body ?? {};

    if (!Array.isArray(ciphertext)) {
      return NextResponse.json(
        { error: "ciphertext must be number[]" },
        { status: 400 }
      );
    }
    if (
      !ephemeralPubkey ||
      typeof ephemeralPubkey.x !== "string" ||
      typeof ephemeralPubkey.y !== "string"
    ) {
      return NextResponse.json(
        { error: "ephemeralPubkey { x: string, y: string } required" },
        { status: 400 }
      );
    }
    if (typeof privkey !== "string") {
      return NextResponse.json(
        { error: "privkey required (decimal string)" },
        { status: 400 }
      );
    }

    const note = await decryptShieldedNote(
      new Uint8Array(ciphertext),
      { x: BigInt(ephemeralPubkey.x), y: BigInt(ephemeralPubkey.y) },
      BigInt(privkey)
    );

    return NextResponse.json({
      amount: note.amount.toString(),
      blinding: note.blinding.toString(),
      data: note.data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
