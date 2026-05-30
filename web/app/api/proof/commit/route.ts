/// POST /api/proof/commit — compute a Pedersen commitment without ZK proof.
///
/// Used by the recovery flow to validate that a reconstructed (balance, blinding)
/// matches the on-chain commitment WITHOUT paying the cost of a full Groth16 proof.
///
/// Body: { amount: string, blinding: string }  (decimal wei strings)
/// Response: { x: string, y: string }           (BabyJubJub point, decimal strings)
///
/// Uses buildAmountDiscloseProof from @openjanus/sdk/crypto (which internally
/// uses computeCommitmentV05) and returns only the commitment field.
/// A mismatch between this result and the on-chain commitment means the
/// reconstructed state cannot open the on-chain commitment and unwrap WILL revert.

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof } from "@openjanus/sdk/crypto";
import path from "path";

export const runtime = "nodejs";

const SDK_ROOT = path.resolve(
  process.cwd(),
  "node_modules",
  "@openjanus",
  "sdk",
  "circuits",
  "v0.5.1"
);
const AMOUNT_WASM = path.join(SDK_ROOT, "amount_disclose.wasm");
const AMOUNT_ZKEY = path.join(SDK_ROOT, "amount_disclose_final.zkey");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amount, blinding } = body ?? {};

    if (typeof amount !== "string" || typeof blinding !== "string") {
      return NextResponse.json(
        { error: "amount + blinding required (decimal strings)" },
        { status: 400 }
      );
    }

    const amountBig = BigInt(amount);
    const blindingBig = BigInt(blinding);

    // buildAmountDiscloseProof uses computeCommitmentV05 internally.
    // We provide the caller's blinding so the commitment matches what's on-chain.
    const result = await buildAmountDiscloseProof(
      { amount: amountBig, blinding: blindingBig },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );

    return NextResponse.json({
      x: result.commitment.x.toString(),
      y: result.commitment.y.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
