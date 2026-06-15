#!/usr/bin/env node
"use strict";
/**
 * test-batch-claim-mockft.cjs — Scenario C+.2: MockFT batch-claim consolidation
 *
 * Validates: Alice wraps 60 MockFT; sends 6 × 10 to Bob; Bob's accumulated
 * blinding may overflow SUBORDER; JanusFT.claimBatch (Cadence) with
 * notesToConsume=[] re-blinds Bob's commitment to a fresh safe state;
 * Bob can then shieldedTransfer 5 MockFT to Charlie; Bob residual = 55 MockFT.
 *
 * Steps:
 *   1. Admin resets Alice + Bob JanusFT slots (flow CLI, openjanus-v08)
 *   2. Admin mints 100 MockFT to Alice
 *   3. Install Bob + Charlie ShieldedInboxes (idempotent)
 *   4. Derive BabyJub keypairs (Alice, Bob, Charlie)
 *   5. Query feeBps
 *   6. Alice wraps 60 MockFT → checkpoint
 *   7. Alice sends 6 × 10 MockFT tips to Bob (track transferBlinding per tip)
 *   8. Document blinding overflow state (bob accum blinding >= SUBORDER?)
 *   9. buildBatchClaimProof (notesToConsume=[]) — pure re-blinding
 *  10. Submit claim_batch_ft.cdc via flow CLI (testnet-bob as signer)
 *  11. Bob updates ShieldedCheckpoint
 *  12. shieldedTransfer 5 MockFT: Bob → Charlie (flow CLI, testnet-bob signer)
 *  13. Assert: Bob residual = 55 MockFT (60 - 5)
 *
 * MockFT decimals: 8. 1 MockFT = 100_000_000 raw.
 *
 * Alice Cadence: openjanus-v08 (0x4b6bc58bc8bf5dcc)
 * Bob Cadence:   testnet-bob   (0xd807a3992d7be612)
 * Charlie Cadence: testnet-charlie (0x3c601a443c81e6cd)
 *
 * Output: JSON at scripts/results-batch-claim-mockft.json + stdout
 */

const path            = require("path");
const fs              = require("fs");
const { execFileSync } = require("child_process");
const { ethers }      = require("ethers");

const {
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  provider,
  DEPLOYER_EOA_KEY,
  jsonOutput,
  bigintReplacer,
} = require("./_shared.cjs");

const {
  orchestrateWrap,
  orchestrateShieldedTransfer,
  buildBatchClaimProof,
  encryptSnapshot,
  generateBlinding,
} = require("@claucondor/sdk");

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT        = "/home/oydual3/zkapps/private-tip-v1";
const RESULTS_FILE     = path.join(REPO_ROOT, "scripts", "results-batch-claim-mockft.json");
const CADENCE_TX_DIR   = "/home/oydual3/openjanus-contracts/tests/v0.8-smoke/cadence";
const LOCAL_TX_DIR     = path.join(REPO_ROOT, "cadence", "transactions");
const NETWORK          = "testnet";
const FLOW_REST        = "https://rest-testnet.onflow.org";

// Batch-claim circuit files
const ZKEY_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/ceremony/cb_final.zkey";
const WASM_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/build/confidential_claim_batch_js/confidential_claim_batch.wasm";

// BabyJub suborder
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// Cadence accounts
const ALICE_CADENCE_ADDR   = "0x4b6bc58bc8bf5dcc";
const BOB_CADENCE_ADDR     = "0xd807a3992d7be612";
const CHARLIE_CADENCE_ADDR = "0x3c601a443c81e6cd";
const ALICE_FLOW_ACCT      = "openjanus-v08";
const BOB_FLOW_ACCT        = "testnet-bob";
const CHARLIE_FLOW_ACCT    = "testnet-charlie";

// EVM wallets for memo-keypair derivation + ShieldedCheckpoint
const ALICE_KEY   = DEPLOYER_EOA_KEY;
const BOB_KEY     = "0x98ce0bff00e393fa28b89bf60f4d463add1d914bd869f432dac191d2e3cb907b";
const CHARLIE_KEY = "0xa4c3e7a9b2f1d0e5c8b7a6d3f2e1c0d9b8a7e6d5c4b3a2f1e0d9c8b7a6d5e4c3";

// MockFT amounts (8 decimals: 1 MockFT = 100_000_000 raw)
const UFIX64_SCALE   = 100_000_000n;
const WRAP_AMOUNT    = 60n * UFIX64_SCALE;   //  60 MockFT
const TIP_AMOUNT     = 10n * UFIX64_SCALE;   //  10 MockFT each
const SEND_AMOUNT    =  5n * UFIX64_SCALE;   //   5 MockFT (post-batchClaim)
const MINT_AMOUNT_UFIX = "100.00000000";
const TIP_COUNT      = 6;
// Bob expected residual: 60 - 5 = 55 MockFT
const EXPECTED_BOB_RESIDUAL = 55n * UFIX64_SCALE;

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario: "batch-claim-mockft",
  started:  new Date().toISOString(),
  aliceCadenceAddr:   ALICE_CADENCE_ADDR,
  bobCadenceAddr:     BOB_CADENCE_ADDR,
  charlieCadenceAddr: CHARLIE_CADENCE_ADDR,
  steps:    {},
  verdict:  "RUNNING",
};

function save() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, bigintReplacer, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ufixFormat(raw) {
  const whole = raw / UFIX64_SCALE;
  const frac  = raw % UFIX64_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

/**
 * Split SDK EVM-format proof back to natural pA/pB/pC for wrap_mockft.cdc
 * (JanusFT.wrapWithProof re-swaps internally).
 */
function splitProofForCadence(proof) {
  return {
    pA: [proof[0], proof[1]],
    pB: [
      [proof[3], proof[2]],
      [proof[5], proof[4]],
    ],
    pC: [proof[6], proof[7]],
  };
}

// Cadence args builders
const u256  = (v)    => ({ type: "UInt256", value: v.toString() });
const addr  = (a)    => ({ type: "Address", value: a });
const ufix  = (v)    => ({ type: "UFix64",  value: v });
const arrU256 = (arr) => ({ type: "Array",  value: arr.map(u256) });
const arr2d   = (arr) => ({
  type:  "Array",
  value: arr.map(row => ({ type: "Array", value: row.map(u256) })),
});
const arrU8 = (buf) => ({
  type:  "Array",
  value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })),
});
const arrAddr = (addrs) => ({ type: "Array", value: addrs.map(addr) });

/**
 * Run a Cadence transaction via flow CLI. Returns sealed tx ID.
 */
function flowSend(txPath, signer, argsJson) {
  const cmd = [
    "flow", "transactions", "send",
    "--network", NETWORK,
    "--signer", signer,
    "--config-path", path.join(REPO_ROOT, "flow.json"),
    "--output", "json",
    "--args-json", JSON.stringify(argsJson),
    txPath,
  ];
  process.stderr.write(`[S2-MockFT] flow send ${path.basename(txPath)} (signer=${signer})...\n`);
  const output = execFileSync(cmd[0], cmd.slice(1), {
    cwd: REPO_ROOT,
    timeout: 180_000,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    const match = output.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error(`flow send ${path.basename(txPath)}: no JSON:\n${output.slice(0, 400)}`);
    result = JSON.parse(match[1]);
  }
  if (!result.id) {
    throw new Error(`flow send ${path.basename(txPath)}: no tx id:\n${JSON.stringify(result).slice(0, 400)}`);
  }
  process.stderr.write(`[S2-MockFT] sealed: ${result.id}\n`);
  return result.id;
}

/**
 * Query Cadence script via REST API.
 */
async function cadenceScript(script, args = []) {
  const scriptB64 = Buffer.from(script.trim(), "utf8").toString("base64");
  const argsB64   = args.map(a => Buffer.from(JSON.stringify(a), "utf8").toString("base64"));
  const resp = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ script: scriptB64, arguments: argsB64 }),
  });
  const raw = await resp.json();
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(decoded);
}

async function getFeeBps() {
  const result = await cadenceScript(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(): UInt16 { return JanusFT.feeBps() }
  `);
  return Number(result.value);
}

async function getJanusFTCommitment(cadenceAddr) {
  const result = await cadenceScript(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(addr: Address): {String: UInt256} {
  let c = JanusFT.balanceOfCommitment(account: addr)
  return {"x": c.x, "y": c.y}
}
  `, [{ type: "Address", value: cadenceAddr }]);
  const fields = result.value;
  let x = 0n, y = 1n;
  for (const item of fields) {
    if (item.key?.value === "x") x = BigInt(item.value.value);
    if (item.key?.value === "y") y = BigInt(item.value.value);
  }
  return { x, y };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const alice   = makeWallet(ALICE_KEY);
  const bob     = makeWallet(BOB_KEY);
  const charlie = makeWallet(CHARLIE_KEY);
  const cpClient = new ShieldedCheckpointClient();

  process.stderr.write(`[S2-MockFT] Alice EVM:   ${alice.address}\n`);
  process.stderr.write(`[S2-MockFT] Bob EVM:     ${bob.address}\n`);
  process.stderr.write(`[S2-MockFT] Charlie EVM: ${charlie.address}\n`);
  save();

  const aliceJub   = await deriveMemoKeypair(alice);
  const bobJub     = await deriveMemoKeypair(bob);
  const charlieJub = await deriveMemoKeypair(charlie);

  // ── Step 1: Admin reset Alice + Bob JanusFT slots ─────────────────────────
  process.stderr.write(`[S2-MockFT] Step 1: Admin reset Alice+Bob JanusFT slots...\n`);
  const resetTxId = flowSend(
    path.join(CADENCE_TX_DIR, "admin_reset_janusFT.cdc"),
    ALICE_FLOW_ACCT,
    [arrAddr([ALICE_CADENCE_ADDR, BOB_CADENCE_ADDR])],
  );
  results.steps.admin_reset = { cadenceTxId: resetTxId };
  save();
  process.stderr.write(`[S2-MockFT] Reset done: ${resetTxId}\n`);

  // ── Step 2: Mint 100 MockFT to Alice ─────────────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 2: Mint ${MINT_AMOUNT_UFIX} MockFT to Alice...\n`);
  const mintTxId = flowSend(
    path.join(CADENCE_TX_DIR, "mint_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [ufix(MINT_AMOUNT_UFIX), addr(ALICE_CADENCE_ADDR)],
  );
  results.steps.mint = { cadenceTxId: mintTxId };
  save();
  process.stderr.write(`[S2-MockFT] Minted: ${mintTxId}\n`);

  // ── Step 3: Install Bob + Charlie ShieldedInboxes ─────────────────────────
  process.stderr.write(`[S2-MockFT] Step 3a: Install Bob inbox...\n`);
  const bobInboxTxId = flowSend(
    path.join(CADENCE_TX_DIR, "install_inbox.cdc"),
    BOB_FLOW_ACCT,
    [],
  );
  process.stderr.write(`[S2-MockFT] Step 3b: Install Charlie inbox...\n`);
  const charlieInboxTxId = flowSend(
    path.join(CADENCE_TX_DIR, "install_inbox.cdc"),
    CHARLIE_FLOW_ACCT,
    [],
  );
  results.steps.install_inboxes = {
    bob:     { cadenceTxId: bobInboxTxId },
    charlie: { cadenceTxId: charlieInboxTxId },
  };
  save();

  // ── Step 4 (inline): Keypairs derived above ───────────────────────────────

  // ── Step 5: Query feeBps ──────────────────────────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 5: Query JanusFT feeBps...\n`);
  const feeBps = await getFeeBps();
  process.stderr.write(`[S2-MockFT] feeBps: ${feeBps}\n`);
  results.steps.fee_query = { feeBps };
  save();

  // ── Step 6: Alice wraps 60 MockFT ─────────────────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 6: Alice wraps ${ufixFormat(WRAP_AMOUNT)} MockFT...\n`);
  const orchWrap = await orchestrateWrap({
    grossAmount: WRAP_AMOUNT,
    feeBps,
    senderMemoKeypair: aliceJub,
  });

  const { pA: wPA, pB: wPB, pC: wPC } = splitProofForCadence(orchWrap.amountProof);

  const wrapTxId = flowSend(
    path.join(CADENCE_TX_DIR, "wrap_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [
      ufix(ufixFormat(WRAP_AMOUNT)),
      u256(orchWrap.nonce),
      u256(orchWrap.txCommit[0]),
      u256(orchWrap.txCommit[1]),
      arrU256(wPA),
      arr2d(wPB),
      arrU256(wPC),
      arrU8(orchWrap.encryptedSnapshot),
      u256(orchWrap.ephPubkeyX),
      u256(orchWrap.ephPubkeyY),
    ],
  );

  let aliceBalance  = orchWrap.netAmount;
  let aliceBlinding = orchWrap.blinding % SUBORDER;

  // Checkpoint Alice
  const aliceCp1 = await cpClient.update(
    {
      encryptedSnapshot: orchWrap.encryptedSnapshot,
      ephPubkeyX: orchWrap.ephPubkeyX,
      ephPubkeyY: orchWrap.ephPubkeyY,
    },
    0n,
    alice,
  );

  results.steps.alice_wrap = {
    cadenceTxId:    wrapTxId,
    checkpointTx:   aliceCp1.txHash,
    netAmount:      aliceBalance.toString(),
    blinding:       aliceBlinding.toString().slice(0, 20) + "...",
  };
  save();
  process.stderr.write(`[S2-MockFT] Alice wrapped. balance=${aliceBalance}\n`);

  // ── Step 7: Alice sends 6 × 10 MockFT tips to Bob ───────────────────────
  process.stderr.write(`[S2-MockFT] Step 7: Sending ${TIP_COUNT} × ${ufixFormat(TIP_AMOUNT)} MockFT tips to Bob...\n`);

  const tipTxIds = [];
  const tipTransferBlindings = [];  // one per tip — accumulated by Bob on-chain

  // Bob's accumulated commitment state
  let bobAccumBalance  = 0n;
  let bobAccumBlinding = 0n;

  for (let i = 1; i <= TIP_COUNT; i++) {
    process.stderr.write(`[S2-MockFT]   Tip ${i}/${TIP_COUNT}: ${ufixFormat(TIP_AMOUNT)} → Bob...\n`);

    const orchTip = await orchestrateShieldedTransfer({
      currentBalance:    aliceBalance,
      currentBlinding:   aliceBlinding,
      transferAmount:    TIP_AMOUNT,
      senderMemoKeypair: aliceJub,
      recipientMemoKey:  bobJub.pubkey,
      memo:              `S2-MockFT tip ${i}/${TIP_COUNT}`,
    });

    const tipTxId = flowSend(
      path.join(LOCAL_TX_DIR, "send_shielded_tip_mockft.cdc"),
      ALICE_FLOW_ACCT,
      [
        addr(ALICE_CADENCE_ADDR),
        addr(BOB_CADENCE_ADDR),
        arrU256(orchTip.txParams.proof),
        arrU256(orchTip.txParams.publicInputs),
        arrU8(orchTip.txParams.encryptedNoteTo),
        u256(orchTip.txParams.ephPubkeyToX),
        u256(orchTip.txParams.ephPubkeyToY),
      ],
    );

    tipTxIds.push(tipTxId);
    tipTransferBlindings.push(orchTip.transferBlinding);

    // Update local Alice state
    aliceBalance  = orchTip.newBalance;
    aliceBlinding = orchTip.newBlinding % SUBORDER;

    // Accumulate Bob's commitment state
    bobAccumBalance  = bobAccumBalance + TIP_AMOUNT;
    bobAccumBlinding = (bobAccumBlinding + orchTip.transferBlinding) % SUBORDER;

    process.stderr.write(`[S2-MockFT]   Tip ${i} done: ${tipTxId} | aliceBal=${aliceBalance} | bobAccumBal=${bobAccumBalance}\n`);
  }

  // Update Alice checkpoint after all tips
  {
    const aliceEncSnap = await encryptSnapshot(
      { balance: aliceBalance, blinding: aliceBlinding },
      aliceJub.pubkey,
    );
    const aliceCp2 = await cpClient.update(
      {
        encryptedSnapshot: aliceEncSnap.ciphertext,
        ephPubkeyX: aliceEncSnap.ephemeralPubkey.x,
        ephPubkeyY: aliceEncSnap.ephemeralPubkey.y,
      },
      0n,
      alice,
    );
    results.steps.alice_checkpoint_after_tips = { txHash: aliceCp2.txHash };
  }

  results.steps.alice_tips = {
    count:         TIP_COUNT,
    tipAmount:     TIP_AMOUNT.toString(),
    txIds:         tipTxIds,
    aliceResidual: aliceBalance.toString(),
    bobAccumBalance:  bobAccumBalance.toString(),
    bobAccumBlinding: bobAccumBlinding.toString().slice(0, 20) + "...",
  };
  save();
  process.stderr.write(`[S2-MockFT] All ${TIP_COUNT} tips sent. Alice residual=${aliceBalance}, Bob accum=${bobAccumBalance}\n`);

  // ── Step 8: Document blinding overflow state ──────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 8: Checking Bob's accumulated blinding...\n`);
  const rawBlindingSum = tipTransferBlindings.reduce((acc, b) => acc + b, 0n);
  const overflows2_252 = rawBlindingSum > (1n << 252n);
  const overflowsSUB   = rawBlindingSum >= SUBORDER;

  process.stderr.write(`[S2-MockFT] Raw blinding sum: ${rawBlindingSum.toString().slice(0, 20)}...\n`);
  process.stderr.write(`[S2-MockFT] Overflows 2^252: ${overflows2_252} | >= SUBORDER: ${overflowsSUB}\n`);

  // On-chain Bob commitment
  const bobOnChain = await getJanusFTCommitment(BOB_CADENCE_ADDR);
  const bobIdentity = (bobOnChain.x === 0n) && (bobOnChain.y === 1n);

  process.stderr.write(`[S2-MockFT] Bob on-chain commit: x=${bobOnChain.x.toString().slice(0,20)}...\n`);

  let preBatchReason;
  if (overflowsSUB) {
    preBatchReason = `Raw blinding sum ${rawBlindingSum.toString().slice(0, 20)}... >= SUBORDER. ` +
      "computeCommitment would throw RangeError — shieldedTransfer impossible without claimBatch.";
  } else {
    preBatchReason = "Raw blinding sum < SUBORDER but claimBatch re-blinding provides fresh safe state for future transfers.";
  }

  results.steps.blinding_check = {
    rawBlindingSum:         rawBlindingSum.toString(),
    blindingMod:            bobAccumBlinding.toString(),
    overflows2_252:         overflows2_252,
    overflowsSUBORDER:      overflowsSUB,
    bobOnChainCommitX:      bobOnChain.x.toString(),
    bobOnChainCommitY:      bobOnChain.y.toString(),
    bobCommitIsIdentity:    bobIdentity,
    reason:                 preBatchReason,
  };
  save();

  // ── Step 9: Build batchClaim proof (notesToConsume=[], pure re-blinding) ───
  process.stderr.write(`[S2-MockFT] Step 9: Building batchClaim proof (notesToConsume=[], ~90s)...\n`);

  // Validate circuit files exist
  if (!fs.existsSync(ZKEY_PATH)) {
    throw new Error(`batchClaim zkey not found: ${ZKEY_PATH}`);
  }
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`batchClaim wasm not found: ${WASM_PATH}`);
  }
  process.stderr.write(`[S2-MockFT] Circuit files verified. Building proof...\n`);

  const freshBlinding = generateBlinding();

  const batchProofResult = await buildBatchClaimProof(
    {
      oldBalance:  bobAccumBalance,
      oldBlinding: bobAccumBlinding,
      newBlinding: freshBlinding,
      notes:       [],  // pure re-blinding — no inbox notes to consume
    },
    {
      zkeyPath: ZKEY_PATH,
      wasmPath: WASM_PATH,
    },
  );

  process.stderr.write(`[S2-MockFT] batchClaim proof built. newBalance=${batchProofResult.newBalance}\n`);

  results.steps.batch_proof = {
    oldBalance:  bobAccumBalance.toString(),
    oldBlinding: bobAccumBlinding.toString(),
    newBalance:  batchProofResult.newBalance.toString(),
    publicInputs: batchProofResult.publicInputs.map(p => p.toString()),
    newCommit:   { x: batchProofResult.newCommit.x.toString(), y: batchProofResult.newCommit.y.toString() },
  };
  save();

  // ── Step 10: Submit claim_batch_ft.cdc via flow CLI ───────────────────────
  process.stderr.write(`[S2-MockFT] Step 10: Submitting claim_batch_ft.cdc (signer=${BOB_FLOW_ACCT})...\n`);

  const claimTxId = flowSend(
    path.join(LOCAL_TX_DIR, "claim_batch_ft.cdc"),
    BOB_FLOW_ACCT,
    [
      addr(BOB_CADENCE_ADDR),
      arrU256(batchProofResult.publicInputs),
      arrU256(batchProofResult.proof),
    ],
  );

  process.stderr.write(`[S2-MockFT] claimBatch sealed: ${claimTxId}\n`);
  results.steps.claim_batch = { cadenceTxId: claimTxId };
  save();

  // Verify Bob's on-chain commitment updated
  const bobOnChainAfter = await getJanusFTCommitment(BOB_CADENCE_ADDR);
  const commitMatchX = batchProofResult.newCommit.x === bobOnChainAfter.x;
  const commitMatchY = batchProofResult.newCommit.y === bobOnChainAfter.y;

  process.stderr.write(`[S2-MockFT] Bob post-claim commit match: x=${commitMatchX}, y=${commitMatchY}\n`);
  results.steps.claim_batch.onChainAfter = {
    x: bobOnChainAfter.x.toString(),
    y: bobOnChainAfter.y.toString(),
  };
  results.steps.claim_batch.commitMatch = commitMatchX && commitMatchY;
  save();

  // ── Step 11: Bob updates ShieldedCheckpoint ───────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 11: Updating Bob's ShieldedCheckpoint...\n`);

  const bobEncSnap = await encryptSnapshot(
    { balance: batchProofResult.newBalance, blinding: freshBlinding },
    bobJub.pubkey,
  );
  const bobCpResult = await cpClient.update(
    {
      encryptedSnapshot: bobEncSnap.ciphertext,
      ephPubkeyX: bobEncSnap.ephemeralPubkey.x,
      ephPubkeyY: bobEncSnap.ephemeralPubkey.y,
    },
    BigInt(TIP_COUNT),  // cursor: we've processed TIP_COUNT notes
    bob,
  );
  process.stderr.write(`[S2-MockFT] Bob checkpoint updated: ${bobCpResult.txHash}\n`);
  results.steps.bob_checkpoint = { txHash: bobCpResult.txHash };
  save();

  // ── Step 12: Bob shieldedTransfers 5 MockFT → Charlie ───────────────────
  process.stderr.write(`[S2-MockFT] Step 12: Bob transfers ${ufixFormat(SEND_AMOUNT)} MockFT → Charlie...\n`);

  let postClaimTxId   = null;
  let postClaimFailed = false;
  let postClaimError  = null;
  let bobResidual     = batchProofResult.newBalance;

  try {
    const orchBobSend = await orchestrateShieldedTransfer({
      currentBalance:    batchProofResult.newBalance,
      currentBlinding:   freshBlinding,
      transferAmount:    SEND_AMOUNT,
      senderMemoKeypair: bobJub,
      recipientMemoKey:  charlieJub.pubkey,
      memo:              "S2-MockFT post-batchClaim",
    });

    postClaimTxId = flowSend(
      path.join(CADENCE_TX_DIR, "shielded_transfer_mockft.cdc"),
      BOB_FLOW_ACCT,
      [
        addr(BOB_CADENCE_ADDR),
        addr(CHARLIE_CADENCE_ADDR),
        arrU256(orchBobSend.txParams.proof),
        arrU256(orchBobSend.txParams.publicInputs),
        arrU8(orchBobSend.txParams.encryptedNoteTo),
        u256(orchBobSend.txParams.ephPubkeyToX),
        u256(orchBobSend.txParams.ephPubkeyToY),
      ],
    );

    bobResidual = orchBobSend.newBalance;
    process.stderr.write(`[S2-MockFT] Bob transfer succeeded: ${postClaimTxId}\n`);

    // Update Bob checkpoint post-transfer
    if (orchBobSend.checkpointPayload) {
      const bobCp2 = await cpClient.update(orchBobSend.checkpointPayload, BigInt(TIP_COUNT), bob);
      results.steps.bob_post_transfer_checkpoint = { txHash: bobCp2.txHash };
    }

    results.steps.post_batch_transfer = {
      cadenceTxId:    postClaimTxId,
      amount:         SEND_AMOUNT.toString(),
      bobResidual:    bobResidual.toString(),
      couldMismatch:  false,
    };

  } catch (err) {
    postClaimFailed = true;
    postClaimError  = err.message;
    process.stderr.write(`[S2-MockFT] Post-claim transfer FAILED: ${err.message}\n`);
    results.steps.post_batch_transfer = {
      cadenceTxId:    null,
      error:          postClaimError,
      couldMismatch:  true,
    };
  }
  save();

  // ── Step 13: Final assertions ─────────────────────────────────────────────
  process.stderr.write(`[S2-MockFT] Step 13: Final assertions...\n`);

  const bobFinalOnChain = await getJanusFTCommitment(BOB_CADENCE_ADDR);
  const residualMatch   = bobResidual === EXPECTED_BOB_RESIDUAL;

  process.stderr.write(`[S2-MockFT] Bob residual: ${bobResidual} (expected ${EXPECTED_BOB_RESIDUAL}) match=${residualMatch}\n`);

  results.steps.final = {
    bobOnChainCommit:   { x: bobFinalOnChain.x.toString(), y: bobFinalOnChain.y.toString() },
    bobResidual:        bobResidual.toString(),
    expectedResidual:   EXPECTED_BOB_RESIDUAL.toString(),
    residualMatch,
    postClaimFailed,
    postClaimError,
  };
  save();

  // ── Final verdict ─────────────────────────────────────────────────────────
  const allTipsGood    = tipTxIds.length === TIP_COUNT;
  const claimGood      = !!(results.steps.claim_batch?.cadenceTxId);
  const commitGood     = !!(results.steps.claim_batch?.commitMatch);
  const transferGood   = !postClaimFailed;
  const balanceGood    = residualMatch;

  const verdict = allTipsGood && claimGood && commitGood && transferGood && balanceGood ? "PASS" : "FAIL";

  results.verdict  = verdict;
  results.finished = new Date().toISOString();
  results.summary  = {
    token:           "MockFT",
    aliceCadence:    ALICE_CADENCE_ADDR,
    bobCadence:      BOB_CADENCE_ADDR,
    feeBps,
    allTipsGood,
    claimGood,
    commitGood,
    transferGood,
    balanceGood,
    bobResidual:     bobResidual.toString(),
    expectedResidual: EXPECTED_BOB_RESIDUAL.toString(),
    verdict,
  };
  save();

  jsonOutput(results);
  process.stderr.write(`\n[S2-MockFT] SCENARIO VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S2-MockFT] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict    = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
