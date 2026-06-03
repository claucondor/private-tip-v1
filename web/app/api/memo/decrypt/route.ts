/// POST /api/memo/decrypt — server-side memo decryption.

import { NextRequest, NextResponse } from "next/server";
import { decryptText } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { ciphertext, ephemeralPubkey, privkey } = body ?? {};

    if (!Array.isArray(ciphertext)) {
      return NextResponse.json({ error: "ciphertext (number[]) required" }, { status: 400 });
    }
    if (
      !ephemeralPubkey ||
      typeof ephemeralPubkey.x !== "string" ||
      typeof ephemeralPubkey.y !== "string"
    ) {
      return NextResponse.json(
        { error: "ephemeralPubkey { x, y } required (decimal strings)" },
        { status: 400 }
      );
    }
    if (typeof privkey !== "string") {
      return NextResponse.json({ error: "privkey (decimal string) required" }, { status: 400 });
    }

    const plaintext = await decryptText(
      new Uint8Array(ciphertext),
      { x: BigInt(ephemeralPubkey.x), y: BigInt(ephemeralPubkey.y) },
      BigInt(privkey)
    );

    return NextResponse.json({ plaintext });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
