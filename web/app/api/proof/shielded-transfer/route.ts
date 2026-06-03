/// POST /api/proof/shielded-transfer — build ConfidentialTransfer Groth16 proof server-side.
///
/// Required because buildShieldedTransferProof uses snarkjs with wasm/zkey
/// file I/O (Node.js only). The browser generates blindings, POSTs here,
/// and receives the proof + publicInputs to pass into adapter.shieldedTransferViaCoa.
///
/// Body: {
///   oldBalance: string,         // decimal string (current shielded balance, wei)
///   oldBlinding: string,        // decimal string (current blinding from snapshot)
///   transferAmount: string,     // decimal string (wei)
///   transferBlinding: string,   // decimal string (fresh blinding, generated client-side)
///   newBlinding: string,        // decimal string (fresh blinding for residual, generated client-side)
/// }
/// Response: {
///   proof: string[8],           // uint256[8] as decimal strings
///   publicInputs: string[6],    // [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildShieldedTransferProof } from "@claucondor/sdk/crypto";
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
const CT_WASM = path.join(SDK_ROOT, "confidential_transfer.wasm");
const CT_ZKEY = path.join(SDK_ROOT, "confidential_transfer_final.zkey");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { oldBalance, oldBlinding, transferAmount, transferBlinding, newBlinding } = body ?? {};

    const required = { oldBalance, oldBlinding, transferAmount, transferBlinding, newBlinding };
    for (const [key, val] of Object.entries(required)) {
      if (typeof val !== "string") {
        return NextResponse.json(
          { error: `${key} required (decimal string)` },
          { status: 400 }
        );
      }
    }

    const result = await buildShieldedTransferProof(
      {
        oldBalance: BigInt(oldBalance),
        oldBlinding: BigInt(oldBlinding),
        transferAmount: BigInt(transferAmount),
        transferBlinding: BigInt(transferBlinding),
        newBlinding: BigInt(newBlinding),
      },
      { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
    );

    return NextResponse.json({
      proof: Array.from(result.proof).map((p) => p.toString()),
      publicInputs: result.publicInputs.map((p) => p.toString()),
    });
  } catch (err) {
    console.error("[/api/proof/shielded-transfer] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
