/// POST /api/keypair/generate — server-side BabyJub keypair generation.
///
/// Response: { privkey: string, pubkey: { x: string, y: string } } (decimal strings).
/// SECURITY: the privkey is returned to the client so it can be cached in
/// localStorage for memo decryption. This is consistent with the existing
/// MemoKey design (browser-side decryption). Server has no persistent storage
/// of this key — it's generated fresh per call.

import { NextResponse } from "next/server";
import { generateBabyJubKeypair } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

export async function POST() {
  try {
    const kp = await generateBabyJubKeypair();
    return NextResponse.json({
      privkey: kp.privkey.toString(),
      pubkey: { x: kp.pubkey.x.toString(), y: kp.pubkey.y.toString() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
