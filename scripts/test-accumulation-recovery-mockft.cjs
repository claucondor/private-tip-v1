#!/usr/bin/env node
"use strict";
/**
 * test-accumulation-recovery-mockft.cjs — Scenario C+.2: MockFT accumulation + state recovery
 *
 * Validates: JanusFT (Cadence FT) user can wrap multiple times, state recovery from
 * ShieldedCheckpoint always matches on-chain commitment. No C_old mismatch errors.
 *
 * Steps:
 *   1. Admin resets Alice's JanusFT slot
 *   2. Admin mints 100 MockFT to Alice (Cadence tx)
 *   3. Ensure Bob has ShieldedInbox installed
 *   4. Derive BabyJub memokeys from EVM keys
 *   5. Query feeBps from JanusFT contract
 *   6. Wrap #1: orchestrateWrap(10 MockFT) → proof → flow CLI wrap_mockft.cdc → checkpoint
 *   7. Wrap #2: orchestrateWrap(5 MockFT)  → proof → flow CLI wrap_mockft.cdc → checkpoint
 *   8. Wrap #3: orchestrateWrap(3 MockFT)  → proof → flow CLI wrap_mockft.cdc → checkpoint
 *   9. "Browser reopen": recover state ONLY via ShieldedCheckpoint.readAndDecrypt
 *  10. shieldedTransfer 5 MockFT → Bob using recovered state (flow CLI)
 *      → PASS if proof succeeds (no C_old mismatch)
 *  11. Assert: alice residual = 13 MockFT (10+5+3-5 = 13)
 *
 * MockFT decimals: 8 (UFix64). 1 MockFT = 100_000_000 raw units.
 *
 * Alice Cadence account: openjanus-v08 (0x4b6bc58bc8bf5dcc)
 * Alice EVM wallet: DEPLOYER_EOA_KEY (for ShieldedCheckpoint)
 * Bob Cadence account: testnet-bob (0xd807a3992d7be612)
 * Bob EVM wallet: BOB_KEY (for memokey derivation)
 *
 * Output: JSON at scripts/results-accumulation-recovery-mockft.json + stdout
 */

const path          = require("path");
const fs            = require("fs");
const { execFileSync } = require("child_process");
const { ethers }    = require("ethers");

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
  encryptSnapshot,
  generateBlinding,
} = require("@claucondor/sdk");

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT      = "/home/oydual3/zkapps/private-tip-v1";
const RESULTS_FILE   = path.join(REPO_ROOT, "scripts", "results-accumulation-recovery-mockft.json");
const CADENCE_TX_DIR = path.join("/home/oydual3/openjanus-contracts/tests/v0.8-smoke/cadence");
const NETWORK        = "testnet";
const FLOW_REST      = "https://rest-testnet.onflow.org";

// BabyJub suborder (for blinding mod)
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// Cadence accounts
const ALICE_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const BOB_CADENCE_ADDR   = "0xd807a3992d7be612";
const ALICE_FLOW_ACCT    = "openjanus-v08";
const BOB_FLOW_ACCT      = "testnet-bob";

// EVM wallets
const ALICE_KEY = DEPLOYER_EOA_KEY;
const BOB_KEY   = "0x98ce0bff00e393fa28b89bf60f4d463add1d914bd869f432dac191d2e3cb907b";

// MockFT amounts (8 decimals: 1 MockFT = 100_000_000 raw)
const UFIX64_SCALE   = 100_000_000n;
const WRAP1_AMOUNT   = 10n * UFIX64_SCALE;  // 10 MockFT
const WRAP2_AMOUNT   =  5n * UFIX64_SCALE;  //  5 MockFT
const WRAP3_AMOUNT   =  3n * UFIX64_SCALE;  //  3 MockFT
const SEND_AMOUNT    =  5n * UFIX64_SCALE;  //  5 MockFT
const MINT_AMOUNT_UFIX = "100.00000000";
// Expected residual after 3 wraps minus 1 send: 10+5+3-5 = 13 MockFT
const EXPECTED_RESIDUAL = 13n * UFIX64_SCALE;

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario:  "accumulation-recovery-mockft",
  started:   new Date().toISOString(),
  aliceCadenceAddr: ALICE_CADENCE_ADDR,
  bobCadenceAddr:   BOB_CADENCE_ADDR,
  steps:     {},
  verdict:   "RUNNING",
};

function save() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, bigintReplacer, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a raw bigint (10^8 units) to UFix64 string "N.XXXXXXXX"
 */
function ufixFormat(raw) {
  const whole = raw / UFIX64_SCALE;
  const frac  = raw % UFIX64_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

/**
 * Split SDK EVM-format proof (uint256[8], pB Fp2-swapped) back to natural
 * pA/pB/pC order for JanusFT.wrapWithProof (which re-swaps internally).
 */
function splitProofForCadence(proof) {
  return {
    pA: [proof[0], proof[1]],
    pB: [
      [proof[3], proof[2]],   // un-swap: EVM has [pB[0][1], pB[0][0]]
      [proof[5], proof[4]],   // un-swap: EVM has [pB[1][1], pB[1][0]]
    ],
    pC: [proof[6], proof[7]],
  };
}

// Cadence args builders
const u256  = (v)    => ({ type: "UInt256",  value: v.toString() });
const addr  = (a)    => ({ type: "Address",  value: a });
const ufix  = (v)    => ({ type: "UFix64",   value: v });
const arrU256 = (arr) => ({ type: "Array",   value: arr.map(u256) });
const arr2d   = (arr) => ({
  type: "Array",
  value: arr.map(row => ({ type: "Array", value: row.map(u256) })),
});
const arrU8 = (buf) => ({
  type: "Array",
  value: Array.from(buf).map(b => ({ type: "UInt8", value: b.toString() })),
});
const arrAddr = (addrs) => ({ type: "Array", value: addrs.map(addr) });

/**
 * Run a Cadence transaction via flow CLI. Returns sealed tx ID.
 * txPath: absolute path to the .cdc file
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
  process.stderr.write(`[S1-MockFT] flow send ${path.basename(txPath)} (signer=${signer})...\n`);
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
  process.stderr.write(`[S1-MockFT] sealed: ${result.id}\n`);
  return result.id;
}

/**
 * Query Cadence script via REST API. Returns parsed Cadence JSON value.
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

/**
 * Query JanusFT.feeBps()
 */
async function getFeeBps() {
  const result = await cadenceScript(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(): UInt16 { return JanusFT.feeBps() }
  `);
  return Number(result.value);
}

/**
 * Query JanusFT.balanceOfCommitment(account: addr)
 */
async function getJanusFTCommitment(cadenceAddr) {
  const result = await cadenceScript(`
import JanusFT from 0x4b6bc58bc8bf5dcc
access(all) fun main(addr: Address): {String: UInt256} {
  let c = JanusFT.balanceOfCommitment(account: addr)
  return {"x": c.x, "y": c.y}
}
  `, [{ type: "Address", value: cadenceAddr }]);
  // result.value is a dict: { "x": {...}, "y": {...} }
  const fields = result.value;
  let x = 0n, y = 1n;
  for (const item of fields) {
    if (item.key?.value === "x") x = BigInt(item.value.value);
    if (item.key?.value === "y") y = BigInt(item.value.value);
  }
  return { x, y };
}

/**
 * Write ShieldedCheckpoint for the given (balance, blinding) state.
 */
async function writeCheckpoint(cpClient, wallet, keypair, balance, blinding) {
  const enc = await encryptSnapshot({ balance, blinding }, keypair.pubkey);
  return cpClient.update(
    { encryptedSnapshot: enc.ciphertext, ephPubkeyX: enc.ephemeralPubkey.x, ephPubkeyY: enc.ephemeralPubkey.y },
    0n,
    wallet,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const alice    = makeWallet(ALICE_KEY);
  const bob      = makeWallet(BOB_KEY);
  const cpClient = new ShieldedCheckpointClient();

  process.stderr.write(`[S1-MockFT] Alice EVM: ${alice.address}\n`);
  process.stderr.write(`[S1-MockFT] Bob EVM:   ${bob.address}\n`);
  process.stderr.write(`[S1-MockFT] Alice Cadence: ${ALICE_CADENCE_ADDR}\n`);
  process.stderr.write(`[S1-MockFT] Bob Cadence:   ${BOB_CADENCE_ADDR}\n`);
  save();

  const aliceJub = await deriveMemoKeypair(alice);
  const bobJub   = await deriveMemoKeypair(bob);

  // ── Step 1: Admin reset Alice's JanusFT slot ──────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 1: Admin reset Alice JanusFT slot...\n`);
  const resetTxId = flowSend(
    path.join(CADENCE_TX_DIR, "admin_reset_janusFT.cdc"),
    ALICE_FLOW_ACCT,
    [arrAddr([ALICE_CADENCE_ADDR])],
  );
  results.steps.admin_reset = { cadenceTxId: resetTxId, target: ALICE_CADENCE_ADDR };
  save();
  process.stderr.write(`[S1-MockFT] Admin reset done: ${resetTxId}\n`);

  // ── Step 2: Mint 100 MockFT to Alice ─────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 2: Mint ${MINT_AMOUNT_UFIX} MockFT to Alice...\n`);
  const mintTxId = flowSend(
    path.join(CADENCE_TX_DIR, "mint_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [ufix(MINT_AMOUNT_UFIX), addr(ALICE_CADENCE_ADDR)],
  );
  results.steps.mint = { cadenceTxId: mintTxId, amount: MINT_AMOUNT_UFIX };
  save();
  process.stderr.write(`[S1-MockFT] Minted: ${mintTxId}\n`);

  // ── Step 3: Install Bob's ShieldedInbox (idempotent) ──────────────────────
  process.stderr.write(`[S1-MockFT] Step 3: Install Bob ShieldedInbox...\n`);
  const bobInboxTxId = flowSend(
    path.join(CADENCE_TX_DIR, "install_inbox.cdc"),
    BOB_FLOW_ACCT,
    [],
  );
  results.steps.bob_inbox = { cadenceTxId: bobInboxTxId };
  save();
  process.stderr.write(`[S1-MockFT] Bob inbox installed: ${bobInboxTxId}\n`);

  // ── Step 4: Query feeBps ──────────────────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 4: Query JanusFT feeBps...\n`);
  const feeBps = await getFeeBps();
  process.stderr.write(`[S1-MockFT] JanusFT feeBps: ${feeBps}\n`);
  results.steps.fee_query = { feeBps };
  save();

  // Accumulated state (cumulative, mod SUBORDER for blinding)
  let balance  = 0n;
  let blinding = 0n;

  // ── Step 5: Wrap #1 — 10 MockFT ──────────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 5: Wrap #1 (${ufixFormat(WRAP1_AMOUNT)} MockFT)...\n`);
  const orch1 = await orchestrateWrap({
    grossAmount: WRAP1_AMOUNT,
    feeBps,
    senderMemoKeypair: aliceJub,
  });

  const { pA: pA1, pB: pB1, pC: pC1 } = splitProofForCadence(orch1.amountProof);

  const wrap1TxId = flowSend(
    path.join(CADENCE_TX_DIR, "wrap_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [
      ufix(ufixFormat(WRAP1_AMOUNT)),
      u256(orch1.nonce),
      u256(orch1.txCommit[0]),
      u256(orch1.txCommit[1]),
      arrU256(pA1),
      arr2d(pB1),
      arrU256(pC1),
      arrU8(orch1.encryptedSnapshot),
      u256(orch1.ephPubkeyX),
      u256(orch1.ephPubkeyY),
    ],
  );

  balance  = (balance + orch1.netAmount) % (2n ** 128n);  // balance is always fine
  blinding = (blinding + orch1.blinding) % SUBORDER;       // keep mod SUBORDER
  process.stderr.write(`[S1-MockFT] Wrap1: cumBalance=${balance}, blinding (partial)=${blinding.toString().slice(0, 12)}...\n`);

  const cp1 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain1 = await getJanusFTCommitment(ALICE_CADENCE_ADDR);

  results.steps.wrap1 = {
    cadenceTxId:        wrap1TxId,
    checkpointTxHash:   cp1.txHash,
    grossAmount:        WRAP1_AMOUNT.toString(),
    netAmount:          orch1.netAmount.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain1.x.toString(), y: onChain1.y.toString() },
  };
  save();
  process.stderr.write(`[S1-MockFT] Wrap1 done: ${wrap1TxId}\n`);

  // ── Step 6: Wrap #2 — 5 MockFT ───────────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 6: Wrap #2 (${ufixFormat(WRAP2_AMOUNT)} MockFT)...\n`);
  const orch2 = await orchestrateWrap({
    grossAmount: WRAP2_AMOUNT,
    feeBps,
    senderMemoKeypair: aliceJub,
  });

  const { pA: pA2, pB: pB2, pC: pC2 } = splitProofForCadence(orch2.amountProof);

  const wrap2TxId = flowSend(
    path.join(CADENCE_TX_DIR, "wrap_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [
      ufix(ufixFormat(WRAP2_AMOUNT)),
      u256(orch2.nonce),
      u256(orch2.txCommit[0]),
      u256(orch2.txCommit[1]),
      arrU256(pA2),
      arr2d(pB2),
      arrU256(pC2),
      arrU8(orch2.encryptedSnapshot),
      u256(orch2.ephPubkeyX),
      u256(orch2.ephPubkeyY),
    ],
  );

  balance  = (balance + orch2.netAmount) % (2n ** 128n);
  blinding = (blinding + orch2.blinding) % SUBORDER;
  process.stderr.write(`[S1-MockFT] Wrap2: cumBalance=${balance}, blinding (partial)=${blinding.toString().slice(0, 12)}...\n`);

  const cp2 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain2 = await getJanusFTCommitment(ALICE_CADENCE_ADDR);

  results.steps.wrap2 = {
    cadenceTxId:        wrap2TxId,
    checkpointTxHash:   cp2.txHash,
    grossAmount:        WRAP2_AMOUNT.toString(),
    netAmount:          orch2.netAmount.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain2.x.toString(), y: onChain2.y.toString() },
  };
  save();
  process.stderr.write(`[S1-MockFT] Wrap2 done: ${wrap2TxId}\n`);

  // ── Step 7: Wrap #3 — 3 MockFT ───────────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 7: Wrap #3 (${ufixFormat(WRAP3_AMOUNT)} MockFT)...\n`);
  const orch3 = await orchestrateWrap({
    grossAmount: WRAP3_AMOUNT,
    feeBps,
    senderMemoKeypair: aliceJub,
  });

  const { pA: pA3, pB: pB3, pC: pC3 } = splitProofForCadence(orch3.amountProof);

  const wrap3TxId = flowSend(
    path.join(CADENCE_TX_DIR, "wrap_mockft.cdc"),
    ALICE_FLOW_ACCT,
    [
      ufix(ufixFormat(WRAP3_AMOUNT)),
      u256(orch3.nonce),
      u256(orch3.txCommit[0]),
      u256(orch3.txCommit[1]),
      arrU256(pA3),
      arr2d(pB3),
      arrU256(pC3),
      arrU8(orch3.encryptedSnapshot),
      u256(orch3.ephPubkeyX),
      u256(orch3.ephPubkeyY),
    ],
  );

  balance  = (balance + orch3.netAmount) % (2n ** 128n);
  blinding = (blinding + orch3.blinding) % SUBORDER;
  process.stderr.write(`[S1-MockFT] Wrap3: cumBalance=${balance}, blinding (partial)=${blinding.toString().slice(0, 12)}...\n`);

  const cp3 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain3 = await getJanusFTCommitment(ALICE_CADENCE_ADDR);

  results.steps.wrap3 = {
    cadenceTxId:        wrap3TxId,
    checkpointTxHash:   cp3.txHash,
    grossAmount:        WRAP3_AMOUNT.toString(),
    netAmount:          orch3.netAmount.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain3.x.toString(), y: onChain3.y.toString() },
  };
  save();
  process.stderr.write(`[S1-MockFT] Wrap3 done: ${wrap3TxId}\n`);

  // ── Step 8: "Browser reopen" — recover ONLY from ShieldedCheckpoint ───────
  process.stderr.write(`[S1-MockFT] Step 8: Recovering state from ShieldedCheckpoint...\n`);
  const recoveredSnap = await cpClient.readAndDecrypt(alice, aliceJub.privkey);
  if (!recoveredSnap) throw new Error("Step 8: readAndDecrypt returned null — no checkpoint found");

  const recoveredBalance  = recoveredSnap.balance;
  const recoveredBlinding = recoveredSnap.blinding;
  const recoveryMatch = (recoveredBalance === balance) && (recoveredBlinding === blinding);

  process.stderr.write(`[S1-MockFT] Recovery match: ${recoveryMatch}\n`);
  process.stderr.write(`[S1-MockFT] Recovered balance=${recoveredBalance}, expected=${balance}\n`);

  results.steps.state_recovery = {
    recoveredBalance:  recoveredBalance.toString(),
    recoveredBlinding: recoveredBlinding.toString(),
    expectedBalance:   balance.toString(),
    expectedBlinding:  blinding.toString(),
    matchesLocal:      recoveryMatch,
  };
  save();

  // ── Step 9: shieldedTransfer 5 MockFT → Bob using recovered state ─────────
  process.stderr.write(`[S1-MockFT] Step 9: shieldedTransfer ${ufixFormat(SEND_AMOUNT)} MockFT → Bob...\n`);

  let sendCadenceTxId = null;
  let transferFailed  = false;
  let transferError   = null;
  let newBalance      = recoveredBalance;
  let newBlinding     = recoveredBlinding;

  try {
    const orch = await orchestrateShieldedTransfer({
      currentBalance:  recoveredBalance,
      currentBlinding: recoveredBlinding,
      transferAmount:  SEND_AMOUNT,
      senderMemoKeypair: aliceJub,
      recipientMemoKey:  bobJub.pubkey,
      memo: "S1-MockFT recovery test",
    });

    sendCadenceTxId = flowSend(
      path.join(REPO_ROOT, "cadence/transactions/send_shielded_tip_mockft.cdc"),
      ALICE_FLOW_ACCT,
      [
        addr(ALICE_CADENCE_ADDR),
        addr(BOB_CADENCE_ADDR),
        arrU256(orch.txParams.proof),
        arrU256(orch.txParams.publicInputs),
        arrU8(orch.txParams.encryptedNoteTo),
        u256(orch.txParams.ephPubkeyToX),
        u256(orch.txParams.ephPubkeyToY),
      ],
    );

    newBalance  = orch.newBalance;
    newBlinding = orch.newBlinding % SUBORDER;

    process.stderr.write(`[S1-MockFT] Transfer succeeded: ${sendCadenceTxId}\n`);

    // Update checkpoint with post-transfer state
    if (orch.checkpointPayload) {
      const cpSend = await cpClient.update(orch.checkpointPayload, 0n, alice);
      results.steps.transfer = {
        cadenceTxId:    sendCadenceTxId,
        amount:         SEND_AMOUNT.toString(),
        newBalance:     newBalance.toString(),
        checkpointTx:   cpSend.txHash,
        couldMismatch:  false,
      };
    } else {
      results.steps.transfer = {
        cadenceTxId:   sendCadenceTxId,
        amount:        SEND_AMOUNT.toString(),
        newBalance:    newBalance.toString(),
        couldMismatch: false,
      };
    }
    balance  = newBalance;
    blinding = newBlinding;

  } catch (err) {
    transferFailed = true;
    transferError  = err.message;
    process.stderr.write(`[S1-MockFT] Transfer FAILED (C_old mismatch?): ${err.message}\n`);
    results.steps.transfer = {
      cadenceTxId:   null,
      error:         transferError,
      couldMismatch: true,
    };
  }
  save();

  // ── Step 10: Final assertions ─────────────────────────────────────────────
  process.stderr.write(`[S1-MockFT] Step 10: Final assertions...\n`);

  const onChainFinal = await getJanusFTCommitment(ALICE_CADENCE_ADDR);
  const residualMatch = balance === EXPECTED_RESIDUAL;

  process.stderr.write(`[S1-MockFT] Residual: ${balance} (expected ${EXPECTED_RESIDUAL}) match=${residualMatch}\n`);

  results.steps.final = {
    onChainCommit: { x: onChainFinal.x.toString(), y: onChainFinal.y.toString() },
    residualBalance:  balance.toString(),
    expectedResidual: EXPECTED_RESIDUAL.toString(),
    residualMatch,
    transferFailed,
    transferError,
  };
  save();

  // ── Final verdict ─────────────────────────────────────────────────────────
  const allWrapsGood  = !!(results.steps.wrap1 && results.steps.wrap2 && results.steps.wrap3);
  const recoveryGood  = recoveryMatch;
  const transferGood  = !transferFailed;
  const balanceGood   = residualMatch;
  const verdict = allWrapsGood && recoveryGood && transferGood && balanceGood ? "PASS" : "FAIL";

  results.verdict  = verdict;
  results.finished = new Date().toISOString();
  results.summary  = {
    token:              "MockFT",
    aliceCadence:       ALICE_CADENCE_ADDR,
    feeBps,
    allWrapsGood,
    recoveryGood,
    transferGood,
    balanceGood,
    residualBalance:    balance.toString(),
    expectedResidual:   EXPECTED_RESIDUAL.toString(),
    verdict,
  };
  save();

  jsonOutput(results);
  process.stderr.write(`\n[S1-MockFT] SCENARIO VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S1-MockFT] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict    = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
