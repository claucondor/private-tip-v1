/// POST /api/memokey/derive — server-side MemoKey derivation.
///
/// Body: { sigBytes: number[] }  (concatenated wallet signature bytes)
/// Response: { privkey: string, pubkey: { x: string, y: string } }
///
/// Runs SDK's deriveBabyJubKeypairFromBytes(HKDF-SHA256) server-side so
/// the heavy circomlibjs dep is never bundled into the browser.
/// The returned privkey is a BabyJub scalar in decimal string form.

import { NextRequest, NextResponse } from "next/server";
import { deriveBabyJubKeypairFromBytes } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sigBytes } = body ?? {};

    if (!Array.isArray(sigBytes) || sigBytes.length < 32) {
      return NextResponse.json(
        {
          error:
            "sigBytes required: number[] with at least 32 elements (wallet signature bytes)",
        },
        { status: 400 }
      );
    }

    // Validate all elements are valid byte values.
    for (const b of sigBytes) {
      if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
        return NextResponse.json(
          { error: "sigBytes must contain integers in [0, 255]" },
          { status: 400 }
        );
      }
    }

    const inputBytes = new Uint8Array(sigBytes);
    const kp = await deriveBabyJubKeypairFromBytes(inputBytes);

    return NextResponse.json({
      privkey: kp.privkey.toString(),
      pubkey: {
        x: kp.pubkey.x.toString(),
        y: kp.pubkey.y.toString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
