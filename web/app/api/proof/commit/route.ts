/// POST /api/proof/commit — compute a 2-gen Pedersen commitment without ZK proof.
///
/// Used by the recovery flow to validate that a reconstructed (balance, blinding)
/// matches the on-chain commitment WITHOUT paying the cost of a full Groth16 proof.
///
/// Body: { amount: string, blinding: string }  (decimal wei strings)
/// Response: { x: string, y: string }           (BabyJubJub point, decimal strings)
///
/// Uses computeCommitment from @claucondor/sdk/crypto (2-gen Pedersen).
/// A mismatch between this result and the on-chain commitment means the
/// reconstructed state cannot open the on-chain commitment and unwrap WILL revert.

import { NextRequest, NextResponse } from "next/server";
import { computeCommitment } from "@claucondor/sdk/crypto";

export const runtime = "nodejs";

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

    // computeCommitment is the SDK's canonical 2-gen Pedersen helper.
    // No ZK proof needed — we just want the commitment point (C = [amount]·G + [blinding]·H)
    // to validate that the local state matches the on-chain commitment.
    const commitment = await computeCommitment(amountBig, blindingBig);

    return NextResponse.json({
      x: commitment.x.toString(),
      y: commitment.y.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
