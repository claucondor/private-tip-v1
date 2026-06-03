/// POST /api/proof/wrap — build AmountDisclose Groth16 proof server-side.
///
/// Required because buildAmountDiscloseProof uses snarkjs with wasm/zkey
/// file I/O (Node.js only). The browser generates blinding, POSTs here,
/// and receives the proof + commitment to pass into adapter.wrapViaCoa.
///
/// Body: { amount: string, blinding: string }  (decimal strings, NET amount)
/// Response: {
///   proof: string[8],          // uint256[8] as decimal strings
///   txCommit: [string, string], // [Cx, Cy] decimal strings
///   publicInputs: [string, string, string], // [claimed_amount, Cx, Cy]
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof } from "@claucondor/sdk/crypto";
import path from "path";

export const runtime = "nodejs";

const SDK_ROOT = path.resolve(
  process.cwd(),
  "node_modules",
  "@claucondor",
  "sdk",
  "circuits",
  "v0.3"
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

    const result = await buildAmountDiscloseProof(
      { amount: BigInt(amount), blinding: BigInt(blinding) },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );

    return NextResponse.json({
      proof: Array.from(result.proof).map((p) => p.toString()),
      txCommit: [result.txCommit[0].toString(), result.txCommit[1].toString()],
      publicInputs: result.publicInputs.map((p) => p.toString()),
    });
  } catch (err) {
    console.error("[/api/proof/wrap] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
