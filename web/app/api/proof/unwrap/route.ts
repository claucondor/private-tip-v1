/// POST /api/proof/unwrap — build both proofs needed for JanusFlow.unwrap server-side.
///
/// unwrap needs TWO proofs:
///   1. AmountDisclose proof:     proves claimedAmount is bound to the transfer commitment.
///   2. ConfidentialTransfer proof: proves old commit = new (residual) commit + transfer commit.
///
/// Both proof builders require Node.js (snarkjs wasm/zkey file I/O).
/// The browser generates blindings, POSTs here, and receives both proof bundles.
///
/// Nonce for unwrap: JanusFlow._unwrap always calls _verifyAmountDisclose(..., nonce=0).
/// The unwrap nonce is NOT a per-user replay counter — it is always 0n on-chain.
/// Passing any non-zero value will cause a public input mismatch and the tx reverts.
///
/// The SDK resolves artifact paths automatically via PACKAGE_ROOT walk-up.
///
/// Body: {
///   oldBalance: string,         // decimal string (current shielded balance, wei)
///   oldBlinding: string,        // decimal string (current blinding from checkpoint)
///   claimedAmount: string,      // decimal string (full debit from commitment, wei)
///   claimedBlinding: string,    // decimal string (fresh blinding for the transfer commit)
///   newBlinding: string,        // decimal string (fresh blinding for residual commit)
///   nonce?: string,             // decimal string (MUST be 0 for unwrap — defaults to 0n)
/// }
/// Response: {
///   amountDisclose: { proof: string[8], publicInputs: string[4] },
///   transfer:       { proof: string[8], publicInputs: string[6] },
/// }
///
/// The client submits both bundles in a single JanusFlow.unwrap(...) call.
/// txCommit = amountDisclose.publicInputs[1..2], nonce = amountDisclose.publicInputs[3].

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof, buildShieldedTransferProof } from "@claucondor/sdk";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { oldBalance, oldBlinding, claimedAmount, claimedBlinding, newBlinding, nonce } =
      body ?? {};

    const required = { oldBalance, oldBlinding, claimedAmount, claimedBlinding, newBlinding };
    for (const [key, val] of Object.entries(required)) {
      if (typeof val !== "string") {
        return NextResponse.json(
          { error: `${key} required (decimal string)` },
          { status: 400 }
        );
      }
    }

    const claimedBig = BigInt(claimedAmount);
    const claimedBlindBig = BigInt(claimedBlinding);
    // nonce MUST be 0n for JanusFlow.unwrap — hardcoded on-chain.
    const nonceBig = nonce !== undefined ? BigInt(nonce) : 0n;

    // Build both proofs in parallel — independent inputs.
    const [amountResult, transferResult] = await Promise.all([
      buildAmountDiscloseProof({
        amount: claimedBig,
        blinding: claimedBlindBig,
        nonce: nonceBig,
      }),
      buildShieldedTransferProof({
        oldBalance: BigInt(oldBalance),
        oldBlinding: BigInt(oldBlinding),
        transferAmount: claimedBig,
        transferBlinding: claimedBlindBig,
        newBlinding: BigInt(newBlinding),
      }),
    ]);

    return NextResponse.json({
      amountDisclose: {
        proof: Array.from(amountResult.proof).map((p) => p.toString()),
        publicInputs: amountResult.publicInputs.map((p) => p.toString()),
      },
      transfer: {
        proof: Array.from(transferResult.proof).map((p) => p.toString()),
        publicInputs: transferResult.publicInputs.map((p) => p.toString()),
      },
    });
  } catch (err) {
    console.error("[/api/proof/unwrap] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
