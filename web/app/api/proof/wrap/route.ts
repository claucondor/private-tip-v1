/// POST /api/proof/wrap — build AmountDisclose Groth16 proof server-side.
///
/// Required because buildAmountDiscloseProof uses snarkjs with wasm/zkey
/// file I/O (Node.js only). The browser generates blinding, POSTs here,
/// and receives the proof + publicInputs to pass into adapter.wrapViaCoa.
///
/// The SDK resolves artifact paths automatically via PACKAGE_ROOT walk-up —
/// no hardcoded paths here. Changing the zkey only requires an SDK update.
///
/// Body:   { amount: string, blinding: string, nonce?: string }  (decimal strings)
/// Response: {
///   proof: string[8],                // uint256[8] as decimal strings
///   publicInputs: string[4],         // [amount, Cx, Cy, nonce] as decimal strings
///   nonce: string,                   // echo of nonce used (may be server-generated)
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof, randomNonce256 } from "@claucondor/sdk";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amount, blinding, nonce } = body ?? {};

    if (typeof amount !== "string" || typeof blinding !== "string") {
      return NextResponse.json(
        { error: "amount + blinding required (decimal strings)" },
        { status: 400 }
      );
    }

    // Use explicit nonce if provided (tests/replay), else SDK random within BN254 field.
    const nonceBig = nonce !== undefined ? BigInt(nonce) : randomNonce256();

    const result = await buildAmountDiscloseProof({
      amount: BigInt(amount),
      blinding: BigInt(blinding),
      nonce: nonceBig,
    });

    return NextResponse.json({
      proof: Array.from(result.proof).map((p) => p.toString()),
      publicInputs: result.publicInputs.map((p) => p.toString()),
      nonce: nonceBig.toString(),
    });
  } catch (err) {
    console.error("[/api/proof/wrap] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
