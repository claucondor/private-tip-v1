/// API route for confidential-transfer (shielded transfer) proof generation.
///
/// Server-side endpoint because @claucondor/sdk/crypto uses Node.js APIs (fs, path)
/// for reading circuit artifacts (.wasm, .zkey) and generating Groth16 proofs via snarkjs.
///
/// Used for the shielded transfer path (and the transfer-half of unwrap).
/// Proves that the caller's stored Pedersen commitment can be split into
/// (transfer_commit, new_residual_commit).
///
/// POST /api/proof/decrypt  (legacy alias — canonical name is /api/proof/shielded-transfer)
/// Body: {
///   oldBalance:       string,  // current cleartext balance (wei)
///   oldBlinding:      string,  // blinding for the current commit
///   transferAmount:   string,  // amount to transfer (wei)
///   transferBlinding?: string, // fresh blinding for tx commit (optional)
///   newBlinding?:     string,  // fresh blinding for residual commit (optional)
/// }
/// Returns: {
///   commitments: { oldCommit, transferCommit, newCommit },  // each { x, y }
///   txCommit: [string, string],
///   proof: string[],          // uint256[8]
///   publicInputs: string[],   // [C_old, C_tx, C_new] = 6 values
///   transferBlinding: string, // ALWAYS returned for caller's records
///   newBlinding: string,      // ALWAYS returned — required to spend C_new
/// }

import { NextRequest, NextResponse } from "next/server";
import {
  buildShieldedTransferProof,
  generateBlinding,
} from "@claucondor/sdk/crypto";
import path from "path";

// v0.7.1 SDK ships aggregate circuit artifacts under circuits/aggregate/.
// 2-gen Pedersen ConfidentialTransfer circuit — same 6 public signals as v0.3.
const SDK_ROOT = path.resolve(
  process.cwd(),
  "node_modules",
  "@claucondor",
  "sdk",
  "circuits",
  "aggregate"
);
const TRANSFER_WASM = path.join(SDK_ROOT, "confidential_transfer_aggregate.wasm");
const TRANSFER_ZKEY = path.join(SDK_ROOT, "confidential_transfer_aggregate_test.zkey");

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      oldBalance,
      oldBlinding,
      transferAmount,
      transferBlinding,
      newBlinding,
    } = body as {
      oldBalance: string;
      oldBlinding: string;
      transferAmount: string;
      transferBlinding?: string;
      newBlinding?: string;
    };

    if (
      oldBalance === undefined ||
      oldBlinding === undefined ||
      transferAmount === undefined
    ) {
      return NextResponse.json(
        {
          error:
            "Missing required parameters: oldBalance, oldBlinding, transferAmount (decimal-string wei)",
        },
        { status: 400 }
      );
    }

    const oldBalanceBig = BigInt(oldBalance);
    const oldBlindingBig = BigInt(oldBlinding);
    const transferAmountBig = BigInt(transferAmount);
    const transferBlindingBig = transferBlinding
      ? BigInt(transferBlinding)
      : generateBlinding();
    const newBlindingBig = newBlinding ? BigInt(newBlinding) : generateBlinding();

    const result = await buildShieldedTransferProof(
      {
        oldBalance: oldBalanceBig,
        oldBlinding: oldBlindingBig,
        transferAmount: transferAmountBig,
        transferBlinding: transferBlindingBig,
        newBlinding: newBlindingBig,
      },
      {
        wasmPath: TRANSFER_WASM,
        zkeyPath: TRANSFER_ZKEY,
      }
    );

    return NextResponse.json({
      commitments: {
        oldCommit: {
          x: result.commitments.oldCommit.x.toString(),
          y: result.commitments.oldCommit.y.toString(),
        },
        transferCommit: {
          x: result.commitments.transferCommit.x.toString(),
          y: result.commitments.transferCommit.y.toString(),
        },
        newCommit: {
          x: result.commitments.newCommit.x.toString(),
          y: result.commitments.newCommit.y.toString(),
        },
      },
      txCommit: result.txCommit.map((v) => v.toString()),
      proof: result.proof.map((v) => v.toString()),
      publicInputs: result.publicInputs.map((v) => v.toString()),
      transferBlinding: transferBlindingBig.toString(),
      newBlinding: newBlindingBig.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Shielded-transfer proof generation failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
