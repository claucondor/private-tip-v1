/// POST /api/proof/batch-claim — build ConfidentialClaimBatch Groth16 proof server-side.
///
/// This proof drives BatchClaimClient.claimBatch() — it aggregates up to 50
/// ShieldedInbox notes into a single consolidated shielded balance update.
///
/// Circuit: ConfidentialClaimBatch(N=50)
///   C_new = C_old + C_consumed
///   C_old = Commit(oldBalance, oldBlinding)
///   C_new = Commit(oldBalance + Σ amounts[i], newBlinding)
///   C_consumed = Σ Commit(amounts[i], blindings[i])   (chained BabyJub point adds)
///
/// Public inputs (6 signals):
///   [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
///
/// IMPORTANT: The zkey is 151MB. Proof generation takes 60-90s.
/// This route MUST run on Node.js (not Edge) — wasm + zkey require file I/O.
/// maxDuration=90 exceeds Vercel Hobby plan cap (60s) — upgrade to Pro for production.
///
/// The SDK resolves the zkey path via PACKAGE_ROOT walk-up — no hardcoded paths.
///
/// Body: {
///   oldBalance: string,                              // decimal string (current balance, wei)
///   oldBlinding: string,                             // decimal string (current blinding)
///   newBlinding: string,                             // decimal string (fresh blinding)
///   notesToConsume: Array<{ amount: string, blinding: string }>,  // up to 50 notes
/// }
/// Response: {
///   proof: string[8],           // uint256[8] EVM-ready (pB Fp2-swapped)
///   publicInputs: string[6],    // [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildBatchClaimProof } from "@claucondor/sdk";

export const runtime = "nodejs";
export const maxDuration = 90; // proof gen takes 60-90s — requires Vercel Pro plan

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { oldBalance, oldBlinding, newBlinding, notesToConsume } = body ?? {};

    if (typeof oldBalance !== "string") {
      return NextResponse.json({ error: "oldBalance required (decimal string)" }, { status: 400 });
    }
    if (typeof oldBlinding !== "string") {
      return NextResponse.json({ error: "oldBlinding required (decimal string)" }, { status: 400 });
    }
    if (typeof newBlinding !== "string") {
      return NextResponse.json({ error: "newBlinding required (decimal string)" }, { status: 400 });
    }
    if (!Array.isArray(notesToConsume)) {
      return NextResponse.json(
        { error: "notesToConsume required (array of {amount, blinding}; pass [] for re-blinding only)" },
        { status: 400 }
      );
    }

    // Validate and parse each note.
    const notes: Array<{ amount: bigint; blinding: bigint }> = [];
    for (let i = 0; i < notesToConsume.length; i++) {
      const note = notesToConsume[i];
      if (typeof note?.amount !== "string" || typeof note?.blinding !== "string") {
        return NextResponse.json(
          { error: `notesToConsume[${i}] must have amount + blinding as decimal strings` },
          { status: 400 }
        );
      }
      notes.push({ amount: BigInt(note.amount), blinding: BigInt(note.blinding) });
    }

    const result = await buildBatchClaimProof({
      oldBalance: BigInt(oldBalance),
      oldBlinding: BigInt(oldBlinding),
      newBlinding: BigInt(newBlinding),
      notes,
    });

    return NextResponse.json({
      proof: Array.from(result.proof).map((p) => p.toString()),
      publicInputs: result.publicInputs.map((p) => p.toString()),
    });
  } catch (err) {
    console.error("[/api/proof/batch-claim] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
