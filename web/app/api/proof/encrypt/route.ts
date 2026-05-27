/// API route for v0.3 amount-disclose proof generation.
///
/// Server-side endpoint because @openjanus/sdk/crypto uses Node.js APIs (fs, path)
/// for reading circuit artifacts (.wasm, .zkey) and generating Groth16 proofs via snarkjs.
///
/// Used for the wrap path (proving that a Pedersen commitment binds to a public
/// msg.value amount). Half of the unwrap path also uses this proof.
///
/// POST /api/proof/amount-disclose  (legacy alias: /api/proof/encrypt — kept for
///                                   the existing route layout)
/// Body: { amount: string, blinding?: string }
///   - amount: Wei (attoFLOW) being bound, as decimal string
///   - blinding: Optional 128-bit blinding (decimal string). If omitted the
///               server generates one — but the CALLER MUST PERSIST IT to
///               later spend the resulting commitment.
/// Returns: {
///   commitment: { x: string, y: string },
///   txCommit: [string, string],
///   proof: string[],          // uint256[8]
///   publicInputs: string[],   // [amount, Cx, Cy]
///   blinding: string,         // ALWAYS returned so caller can store it
/// }

import { NextRequest, NextResponse } from "next/server";
import {
  buildAmountDiscloseProof,
  generateBlinding,
} from "@openjanus/sdk/crypto";
import path from "path";

// v0.3 SDK bundles circuit artifacts under node_modules/@openjanus/sdk/circuits/v0.3.
const SDK_ROOT = path.resolve(
  process.cwd(),
  "node_modules",
  "@openjanus",
  "sdk",
  "circuits",
  "v0.3"
);
const AMOUNT_WASM = path.join(SDK_ROOT, "amount_disclose.wasm");
const AMOUNT_ZKEY = path.join(SDK_ROOT, "amount_disclose_final.zkey");

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, blinding } = body as {
      amount: string;
      blinding?: string;
    };

    if (!amount) {
      return NextResponse.json(
        { error: "Missing parameter: amount (decimal-string wei)" },
        { status: 400 }
      );
    }

    const amountBig = BigInt(amount);
    const blindingBig = blinding ? BigInt(blinding) : generateBlinding();

    const result = await buildAmountDiscloseProof(
      {
        amount: amountBig,
        blinding: blindingBig,
      },
      {
        wasmPath: AMOUNT_WASM,
        zkeyPath: AMOUNT_ZKEY,
      }
    );

    return NextResponse.json({
      commitment: {
        x: result.commitment.x.toString(),
        y: result.commitment.y.toString(),
      },
      txCommit: result.txCommit.map((v) => v.toString()),
      proof: result.proof.map((v) => v.toString()),
      publicInputs: result.publicInputs.map((v) => v.toString()),
      blinding: blindingBig.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Amount-disclose proof generation failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
