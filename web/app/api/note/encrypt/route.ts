/// POST /api/note/encrypt — server-side shielded-note encryption.
///
/// Body: {
///   amount:   string  (decimal wei),
///   blinding: string  (decimal),
///   data?:    string  (UTF-8 app payload, e.g. memo text),
///   recipientPubkey: { x: string, y: string }
/// }
/// Response: { ciphertext: number[], ephemeralPubkey: { x: string, y: string } }
///
/// ShieldedNote is the protocol-level envelope that ALWAYS accompanies a
/// JanusFlow shielded transfer so recipients can decrypt + unwrap. See
/// @claucondor/sdk crypto/shielded-note.ts.

import { NextRequest, NextResponse } from "next/server";
import { encryptShieldedNote } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amount, blinding, data, recipientPubkey } = body ?? {};

    if (typeof amount !== "string" || typeof blinding !== "string") {
      return NextResponse.json(
        { error: "amount + blinding required (decimal strings)" },
        { status: 400 }
      );
    }
    if (data !== undefined && typeof data !== "string") {
      return NextResponse.json(
        { error: "data must be string (or omitted)" },
        { status: 400 }
      );
    }
    if (
      !recipientPubkey ||
      typeof recipientPubkey.x !== "string" ||
      typeof recipientPubkey.y !== "string"
    ) {
      return NextResponse.json(
        { error: "recipientPubkey { x: string, y: string } required" },
        { status: 400 }
      );
    }

    const result = await encryptShieldedNote(
      { amount: BigInt(amount), blinding: BigInt(blinding), data },
      { x: BigInt(recipientPubkey.x), y: BigInt(recipientPubkey.y) }
    );

    return NextResponse.json({
      ciphertext: Array.from(result.ciphertext),
      ephemeralPubkey: {
        x: result.ephemeralPubkey.x.toString(),
        y: result.ephemeralPubkey.y.toString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
