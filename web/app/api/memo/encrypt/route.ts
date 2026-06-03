/// POST /api/memo/encrypt — server-side memo encryption.
///
/// Body: { plaintext: string, recipientPubkey: { x: string, y: string } }
/// Response: { ciphertext: number[], ephemeralPubkey: { x: string, y: string } }
///
/// Rationale: @claucondor/sdk crypto helpers transitively pull circomlibjs
/// (~30MB) into any client bundle that imports them, blowing up Turbopack
/// compile times. Keep them server-only and have the client call this route.

import { NextRequest, NextResponse } from "next/server";
import { encryptText } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { plaintext, recipientPubkey } = body ?? {};

    if (typeof plaintext !== "string" || plaintext.length === 0) {
      return NextResponse.json(
        { error: "plaintext required (non-empty string)" },
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

    const result = await encryptText(plaintext, {
      x: BigInt(recipientPubkey.x),
      y: BigInt(recipientPubkey.y),
    });

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
