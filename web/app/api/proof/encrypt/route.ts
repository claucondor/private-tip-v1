/// API route for amount-disclose proof generation (legacy alias kept for route layout).
///
/// Server-side endpoint because @claucondor/sdk/crypto uses Node.js APIs (fs, path)
/// for reading circuit artifacts (.wasm, .zkey) and generating Groth16 proofs via snarkjs.
///
/// Used for the wrap path (proving that a Pedersen commitment binds to a public
/// msg.value amount). Half of the unwrap path also uses this proof.
///
/// POST /api/proof/encrypt  (legacy alias — canonical name is /api/proof/wrap)
/// Body: { amount: string, blinding?: string, nonce?: string }
///   - amount:   Wei (attoFLOW) being bound, as decimal string
///   - blinding: Optional blinding (decimal string). If omitted the server generates one —
///               but the CALLER MUST PERSIST IT to later spend the resulting commitment.
///   - nonce:    Anti-replay nonce (defaults to 1n if omitted).
/// Returns: {
///   commitment: { x: string, y: string },
///   txCommit: [string, string],
///   proof: string[],          // uint256[8]
///   publicInputs: string[],   // v0.7: [amount, Cx, Cy, nonce] (4 signals)
///   blinding: string,         // ALWAYS returned so caller can store it
/// }

import { NextRequest, NextResponse } from "next/server";
import {
  buildAmountDiscloseProof,
  generateBlinding,
} from "@claucondor/sdk/crypto";
import path from "path";

// v0.7.1 SDK ships aggregate circuit artifacts under circuits/aggregate/.
// 2-gen Pedersen circuit with 4 public signals: [amount, Cx, Cy, nonce].
const SDK_ROOT = path.resolve(
  process.cwd(),
  "node_modules",
  "@claucondor",
  "sdk",
  "circuits",
  "aggregate"
);
const AMOUNT_WASM = path.join(SDK_ROOT, "amount_disclose_aggregate.wasm");
const AMOUNT_ZKEY = path.join(SDK_ROOT, "amount_disclose_aggregate_test.zkey");

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
    // nonce defaults to 1n if not supplied (legacy callers that don't pass nonce).
    const nonceBig = (body as { nonce?: string }).nonce !== undefined
      ? BigInt((body as { nonce: string }).nonce)
      : 1n;

    const result = await buildAmountDiscloseProof(
      {
        amount: amountBig,
        blinding: blindingBig,
        nonce: nonceBig,
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
