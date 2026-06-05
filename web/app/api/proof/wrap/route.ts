/// POST /api/proof/wrap — build AmountDisclose Groth16 proof server-side.
///
/// Required because buildAmountDiscloseProof uses snarkjs with wasm/zkey
/// file I/O (Node.js only). The browser generates blinding, POSTs here,
/// and receives the proof + commitment + nonce to pass into adapter.wrapViaCoa.
///
/// v0.7.4: Nonce is now a random 256-bit value generated server-side if not
/// explicitly provided. This eliminates the localStorage counter strategy
/// which caused "nonce already used" reverts when localStorage was cleared.
///
/// Body: { amount: string, blinding: string, nonce?: string }  (decimal strings, NET amount)
/// Response: {
///   proof: string[8],                          // uint256[8] as decimal strings
///   txCommit: [string, string],                // [Cx, Cy] decimal strings
///   publicInputs: [string, string, string, string], // [amount, Cx, Cy, nonce]
///   nonce: string,                             // generated (or echo of provided) nonce
/// }

import { NextRequest, NextResponse } from "next/server";
import { buildAmountDiscloseProof } from "@claucondor/sdk/crypto";
import { randomBytes } from "@noble/hashes/utils";
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amount, blinding, nonce } = body ?? {};

    if (typeof amount !== "string" || typeof blinding !== "string") {
      return NextResponse.json(
        { error: "amount + blinding required (decimal strings)" },
        { status: 400 }
      );
    }

    // nonce: use explicit value if provided (tests/replay), else random 256-bit.
    const nonceBig = nonce !== undefined
      ? BigInt(nonce)
      : (() => {
          const bytes = randomBytes(32);
          let n = 0n;
          for (const b of bytes) n = (n << 8n) | BigInt(b);
          return n;
        })();

    const result = await buildAmountDiscloseProof(
      { amount: BigInt(amount), blinding: BigInt(blinding), nonce: nonceBig },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );

    return NextResponse.json({
      proof: Array.from(result.proof).map((p) => p.toString()),
      txCommit: [result.txCommit[0].toString(), result.txCommit[1].toString()],
      publicInputs: result.publicInputs.map((p) => p.toString()),
      nonce: nonceBig.toString(),
    });
  } catch (err) {
    console.error("[/api/proof/wrap] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
