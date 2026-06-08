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

// Inline type for the SDK's decryptAnyNote — avoids TS reading stale cached
// type declarations from a previous Vercel build. Runtime cast is safe because
// the dynamic import below loads the real module at execution time.
type DecryptAnyNoteFn = (
  ciphertext: Uint8Array,
  ephPubkey: { x: bigint; y: bigint },
  memoPrivKey: bigint
) => Promise<{ amount: bigint; blinding: bigint; data?: string } | null>;

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

    // Dynamic import avoids Turbopack static-export analysis against a stale
    // build cache. The type annotation above keeps full TypeScript safety.
    const { decryptAnyNote } = (await import("@claucondor/sdk") as unknown) as {
      decryptAnyNote: DecryptAnyNoteFn;
    };

    const ct = new Uint8Array(ciphertext);
    const ephPub = { x: BigInt(ephemeralPubkey.x), y: BigInt(ephemeralPubkey.y) };
    const pk = BigInt(privkey);
    const decoded = await decryptAnyNote(ct, ephPub, pk);
    if (!decoded) {
      throw new Error("cannot decrypt note: neither v3 nor shielded format matched");
    }
    return NextResponse.json({
      amount: decoded.amount.toString(),
      blinding: decoded.blinding.toString(),
      data: decoded.data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
