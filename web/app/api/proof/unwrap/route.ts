/// POST /api/proof/unwrap — build both proofs needed for JanusFlow.unwrap server-side.
///
/// unwrap needs TWO proofs:
///   1. AmountDisclose proof: proves claimedAmount binds to the current commitment.
///   2. ConfidentialTransfer proof: proves the spend transition (old → residual).
///
/// Both proof builders require Node.js (snarkjs wasm/zkey file I/O).
/// The browser generates blindings, POSTs here, receives both proofs.
///
/// v0.7: AmountDisclose now takes a nonce (4th public input, anti-replay).
/// The SDK's orchestrateUnwrap defaults nonce to 0n; here we pass it through.
///
/// Body: {
///   claimedAmount: string,      // decimal string (full debit from commitment, wei)
///   currentBalance: string,     // decimal string (current shielded balance, wei)
///   currentBlinding: string,    // decimal string (current blinding from snapshot)
///   transferBlinding: string,   // decimal string (fresh, generated client-side)
///   newBlinding: string,        // decimal string (fresh, generated client-side)
///   nonce?: string,             // decimal string (defaults to 0n for unwrap anti-replay)
/// }
/// Response: {
///   amountProof: string[8],           // AmountDisclose proof uint256[8]
///   txCommit: [string, string],       // AmountDisclose [Cx, Cy]
///   amountPublicInputs: string[4],    // [claimed_amount, Cx, Cy, nonce]
///   transferProof: string[8],         // ConfidentialTransfer proof uint256[8]
///   transferPublicInputs: string[6],  // [C_old.x,y, C_tx.x,y, C_new.x,y]
///   newBlinding: string,              // echo back for snapshot encryption (same value client sent)
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof, buildShieldedTransferProof } from "@claucondor/sdk/crypto";
import path from "path";

export const runtime = "nodejs";

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
const CT_WASM = path.join(SDK_ROOT, "confidential_transfer_aggregate.wasm");
const CT_ZKEY = path.join(SDK_ROOT, "confidential_transfer_aggregate_test.zkey");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { claimedAmount, currentBalance, currentBlinding, transferBlinding, newBlinding, nonce } =
      body ?? {};

    const required = {
      claimedAmount,
      currentBalance,
      currentBlinding,
      transferBlinding,
      newBlinding,
    };
    for (const [key, val] of Object.entries(required)) {
      if (typeof val !== "string") {
        return NextResponse.json(
          { error: `${key} required (decimal string)` },
          { status: 400 }
        );
      }
    }

    const claimedBig = BigInt(claimedAmount);
    const balanceBig = BigInt(currentBalance);
    const curBlindBig = BigInt(currentBlinding);
    const txBlindBig = BigInt(transferBlinding);
    const newBlindBig = BigInt(newBlinding);
    // v0.7: SDK's orchestrateUnwrap defaults nonce to 0n (anti-replay, Phase B.5 fix).
    const nonceBig = nonce !== undefined ? BigInt(nonce) : 0n;

    // Build both proofs in parallel.
    const [amountResult, transferResult] = await Promise.all([
      buildAmountDiscloseProof(
        { amount: claimedBig, blinding: txBlindBig, nonce: nonceBig },
        { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
      ),
      buildShieldedTransferProof(
        {
          oldBalance: balanceBig,
          oldBlinding: curBlindBig,
          transferAmount: claimedBig,
          transferBlinding: txBlindBig,
          newBlinding: newBlindBig,
        },
        { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
      ),
    ]);

    return NextResponse.json({
      amountProof: Array.from(amountResult.proof).map((p) => p.toString()),
      txCommit: [amountResult.txCommit[0].toString(), amountResult.txCommit[1].toString()],
      // v0.7: 4 public inputs [amount, Cx, Cy, nonce]
      amountPublicInputs: amountResult.publicInputs.map((p) => p.toString()),
      transferProof: Array.from(transferResult.proof).map((p) => p.toString()),
      transferPublicInputs: transferResult.publicInputs.map((p) => p.toString()),
      newBlinding: newBlinding, // echo back for snapshot encryption
    });
  } catch (err) {
    console.error("[/api/proof/unwrap] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
