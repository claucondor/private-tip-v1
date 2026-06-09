/**
 * v03-smoke.mjs — End-to-end v0.3 PrivateTip orchestrator smoke test.
 *
 * Validates the FULL shielded tip lifecycle on testnet:
 *
 *   1. Alice wraps 5 FLOW into her JanusFlow shielded slot.
 *      (msg.value VISIBLE — boundary in)
 *
 *   2. Alice sends a shielded tip of 2 FLOW to Dave via PrivateTip orchestrator.
 *      Verify: TipSentShielded event carries NO amount field.
 *
 *   3. Alice sends a shielded tip of 1 FLOW to Dave again.
 *      Verify privacy property again.
 *
 *   4. Alice unwraps 2 FLOW from her residual shielded slot back to her COA.
 *      (claimedAmount VISIBLE — boundary out)
 *
 *   5. Verify accounting: Alice wrapped 5, sent 2+1, unwrapped 2 = 0 left.
 *
 * All tx hashes captured in v03-smoke-results.json.
 *
 * Usage: node scripts/v03-smoke.mjs
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { JsonRpcProvider, Interface } from "ethers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  generateBlinding,
  flowToWei,
} from "@openjanus/sdk/crypto";
import {
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_TOKEN_BASE_ABI,
  JANUS_FLOW_EXTRA_ABI,
} from "@openjanus/sdk/tokens";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;
const JANUS_FLOW_EVM = JANUS_FLOW_EVM_ADDRESS;

const SDK_DIR = join(PROJECT_ROOT, "node_modules/@openjanus/sdk/circuits/v0.3");
const AMOUNT_WASM = join(SDK_DIR, "amount_disclose.wasm");
const AMOUNT_ZKEY = join(SDK_DIR, "amount_disclose_final.zkey");
const TRANSFER_WASM = join(SDK_DIR, "confidential_transfer.wasm");
const TRANSFER_ZKEY = join(SDK_DIR, "confidential_transfer_final.zkey");

const ALICE_FLOW = "0x7599043aea001283";
const ALICE_SIGNER = "testnet-claucondor";
const ALICE_COA = "0x000000000000000000000002b7557ee5d4a32d06";

const DAVE_FLOW = "0xd32d9100e1fe983b";
const DAVE_COA = "0x0000000000000000000000027b94cfc8a64971cd";

const TX_WRAP = join(PROJECT_ROOT, "cadence/transactions/jf_wrap.cdc");
const TX_SEND_TIP = join(PROJECT_ROOT, "cadence/transactions/send_shielded_tip.cdc");
const TX_UNWRAP = join(PROJECT_ROOT, "cadence/transactions/jf_unwrap.cdc");

const PRIVATE_TIP_ADDR = "0xb9ac529c14a4c5a1";

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
const iface = new Interface([...JANUS_TOKEN_BASE_ABI, ...JANUS_FLOW_EXTRA_ABI]);

// ─── CLI / EVM helpers ─────────────────────────────────────────────────────────

function flowTx(cdcPath, argsJson, signer) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcPath}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    const parsed = JSON.parse(out);
    if (parsed.error)
      return { ok: false, txId: parsed.id || "", error: parsed.error };
    if (parsed.status_code !== 0 && parsed.status !== "SEALED" && parsed.status !== 4)
      return {
        ok: false,
        txId: parsed.id || "",
        error: `not sealed: status=${parsed.status} ${parsed.errorMessage || ""}`,
      };
    return { ok: true, txId: parsed.id || "", raw: parsed };
  } catch (e) {
    const raw = (e.stdout || "") + (e.stderr || "");
    return { ok: false, txId: "", error: raw.slice(0, 1000) };
  }
}

async function callView(func, ...args) {
  const data = iface.encodeFunctionData(func, args);
  const result = await provider.call({ to: JANUS_FLOW_EVM, data });
  const decoded = iface.decodeFunctionResult(func, result);
  return decoded.length === 1 ? decoded[0] : decoded;
}

function arrUInt256(arr) {
  return {
    type: "Array",
    value: arr.map((v) => ({ type: "UInt256", value: BigInt(v).toString() })),
  };
}

function findEvent(rawTx, suffix) {
  return (rawTx.events || []).find((e) => e.type.endsWith(suffix));
}

function eventFieldNames(event) {
  if (!event) return [];
  const fieldsRaw = event.values?.value?.fields || [];
  return fieldsRaw.map((f) => f.name);
}

function logStep(label) {
  console.log(`\n=== ${label} ===`);
}
function pass(m) { console.log(`  PASS: ${m}`); }
function fail(m) { console.error(`  FAIL: ${m}`); }
function info(m) { console.log(`  INFO: ${m}`); }

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;

  const results = {
    test: "v03-smoke",
    startedAt: new Date().toISOString(),
    privateTipAddress: PRIVATE_TIP_ADDR,
    janusFlowEVM: JANUS_FLOW_EVM,
    janusFlowCadence: JANUS_FLOW_CADENCE_ADDRESS,
    alice: { flow: ALICE_FLOW, coa: ALICE_COA },
    dave: { flow: DAVE_FLOW, coa: DAVE_COA },
    txHashes: {},
    privacyChecks: {},
  };

  console.log("=".repeat(72));
  console.log("  v0.3 PrivateTip orchestrator smoke test");
  console.log(`  PrivateTip:        ${PRIVATE_TIP_ADDR}`);
  console.log(`  JanusFlow Cadence: ${JANUS_FLOW_CADENCE_ADDRESS}`);
  console.log(`  JanusFlow EVM:     ${JANUS_FLOW_EVM}`);
  console.log("=".repeat(72));

  // Persistent (balance, blinding) tracked across the whole run — this is what
  // a real wallet would persist locally.
  let aliceBalanceWei = 0n;
  let aliceBlinding = 0n;

  // ── Step 0 ─────────────────────────────────────────────────────────────────
  logStep("Step 0: read initial state");
  const totalLockedBefore = await callView("totalLocked");
  info(`totalLocked = ${totalLockedBefore} wei`);

  // ── Step 1: wrap 5 FLOW ───────────────────────────────────────────────────
  logStep("Step 1: Alice wraps 5 FLOW");
  const wrapWei = flowToWei(5n);
  const wrapBlinding = generateBlinding();
  const wrapProof = await buildAmountDiscloseProof(
    { amount: wrapWei, blinding: wrapBlinding },
    { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
  );

  const wrapCalldata = iface
    .encodeFunctionData("wrap", [
      [wrapProof.txCommit[0], wrapProof.txCommit[1]],
      Array.from(wrapProof.proof),
    ])
    .slice(2);

  const wrapTx = flowTx(
    TX_WRAP,
    [
      { type: "UFix64", value: "5.00000000" },
      arrUInt256(wrapProof.txCommit),
      arrUInt256(wrapProof.proof),
      { type: "String", value: wrapCalldata },
    ],
    ALICE_SIGNER
  );
  results.txHashes.wrap = wrapTx.txId || null;

  if (!wrapTx.ok) {
    fail(`Wrap failed: ${wrapTx.error}`);
    failures++;
    finalize(results, failures);
    return failures > 0 ? 1 : 0;
  }
  pass(`Wrap sealed — tx ${wrapTx.txId}`);
  aliceBalanceWei = wrapWei;
  aliceBlinding = wrapBlinding;

  // ── Step 2: Alice sends 2 FLOW shielded tip to Dave ────────────────────────
  logStep("Step 2: Alice sends 2 FLOW shielded tip to Dave");
  const tip2Wei = flowToWei(2n);
  const tip2TransferBlinding = generateBlinding();
  const tip2NewBlinding = generateBlinding();

  const tip2Proof = await buildShieldedTransferProof(
    {
      oldBalance: aliceBalanceWei,
      oldBlinding: aliceBlinding,
      transferAmount: tip2Wei,
      transferBlinding: tip2TransferBlinding,
      newBlinding: tip2NewBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  const tip2Calldata = iface
    .encodeFunctionData("shieldedTransfer", [
      DAVE_COA,
      Array.from(tip2Proof.publicInputs),
      Array.from(tip2Proof.proof),
    ])
    .slice(2);

  const tip2Tx = flowTx(
    TX_SEND_TIP,
    [
      { type: "Address", value: DAVE_FLOW },
      { type: "String", value: DAVE_COA },
      arrUInt256(tip2Proof.publicInputs),
      arrUInt256(tip2Proof.proof),
      { type: "String", value: tip2Calldata },
      { type: "String", value: "v0.3 smoke: thanks Dave!" },
    ],
    ALICE_SIGNER
  );
  results.txHashes.tip2 = tip2Tx.txId || null;

  if (!tip2Tx.ok) {
    fail(`Tip2 failed: ${tip2Tx.error}`);
    failures++;
    finalize(results, failures);
    return failures > 0 ? 1 : 0;
  }
  pass(`Tip2 sealed — tx ${tip2Tx.txId}`);

  // Privacy validation #1: TipSentShielded event has NO amount field
  const ev2 = findEvent(tip2Tx.raw, "PrivateTip.TipSentShielded");
  const ev2Names = eventFieldNames(ev2);
  if (!ev2) {
    fail("TipSentShielded event missing from tip2 tx");
    failures++;
  } else if (ev2Names.includes("amount")) {
    fail(`TipSentShielded leaked amount: ${JSON.stringify(ev2Names)}`);
    failures++;
  } else {
    pass(`TipSentShielded NO amount field (fields: ${ev2Names.join(", ")})`);
  }
  results.privacyChecks.tip2_event_fields = ev2Names;

  // JanusFlow.ShieldedTransferred (router event) shouldn't leak amount either
  const stEv2 = findEvent(tip2Tx.raw, "JanusFlow.ShieldedTransferred");
  const stNames = eventFieldNames(stEv2);
  if (stEv2 && stNames.includes("amount")) {
    fail(`JanusFlow.ShieldedTransferred leaked amount: ${JSON.stringify(stNames)}`);
    failures++;
  } else if (stEv2) {
    pass(`JanusFlow.ShieldedTransferred NO amount (fields: ${stNames.join(", ")})`);
  } else {
    info("JanusFlow.ShieldedTransferred not present (router-internal — fine)");
  }
  results.privacyChecks.jf_shielded_transferred_fields = stNames;

  aliceBalanceWei -= tip2Wei;
  aliceBlinding = tip2NewBlinding;
  info(`Alice now has ${aliceBalanceWei / flowToWei(1n)} FLOW shielded`);

  // ── Step 3: Alice sends 1 FLOW shielded tip to Dave ────────────────────────
  logStep("Step 3: Alice sends 1 FLOW shielded tip to Dave");
  const tip1Wei = flowToWei(1n);
  const tip1TransferBlinding = generateBlinding();
  const tip1NewBlinding = generateBlinding();

  const tip1Proof = await buildShieldedTransferProof(
    {
      oldBalance: aliceBalanceWei,
      oldBlinding: aliceBlinding,
      transferAmount: tip1Wei,
      transferBlinding: tip1TransferBlinding,
      newBlinding: tip1NewBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  const tip1Calldata = iface
    .encodeFunctionData("shieldedTransfer", [
      DAVE_COA,
      Array.from(tip1Proof.publicInputs),
      Array.from(tip1Proof.proof),
    ])
    .slice(2);

  const tip1Tx = flowTx(
    TX_SEND_TIP,
    [
      { type: "Address", value: DAVE_FLOW },
      { type: "String", value: DAVE_COA },
      arrUInt256(tip1Proof.publicInputs),
      arrUInt256(tip1Proof.proof),
      { type: "String", value: tip1Calldata },
      { type: "String", value: "v0.3 smoke: 2nd tip" },
    ],
    ALICE_SIGNER
  );
  results.txHashes.tip1 = tip1Tx.txId || null;

  if (!tip1Tx.ok) {
    fail(`Tip1 failed: ${tip1Tx.error}`);
    failures++;
    finalize(results, failures);
    return failures > 0 ? 1 : 0;
  }
  pass(`Tip1 sealed — tx ${tip1Tx.txId}`);

  const ev1 = findEvent(tip1Tx.raw, "PrivateTip.TipSentShielded");
  const ev1Names = eventFieldNames(ev1);
  if (ev1Names.includes("amount")) {
    fail(`Tip1 TipSentShielded leaked amount: ${JSON.stringify(ev1Names)}`);
    failures++;
  } else {
    pass(`Tip1 TipSentShielded NO amount (fields: ${ev1Names.join(", ")})`);
  }
  results.privacyChecks.tip1_event_fields = ev1Names;

  aliceBalanceWei -= tip1Wei;
  aliceBlinding = tip1NewBlinding;
  info(`Alice now has ${aliceBalanceWei / flowToWei(1n)} FLOW shielded`);

  // ── Step 4: Alice unwraps 2 FLOW from her residual slot ────────────────────
  logStep("Step 4: Alice unwraps 2 FLOW back to her COA");
  const unwrapWei = flowToWei(2n);
  const unwrapBlinding = generateBlinding();   // tx commit blinding (== amount-disclose blinding)
  const unwrapNewBlinding = generateBlinding(); // new residual blinding

  const amountProofUnwrap = await buildAmountDiscloseProof(
    { amount: unwrapWei, blinding: unwrapBlinding },
    { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
  );
  const transferProofUnwrap = await buildShieldedTransferProof(
    {
      oldBalance: aliceBalanceWei,
      oldBlinding: aliceBlinding,
      transferAmount: unwrapWei,
      transferBlinding: unwrapBlinding,   // MUST match amount-disclose's blinding
      newBlinding: unwrapNewBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  const unwrapCalldata = iface
    .encodeFunctionData("unwrap", [
      unwrapWei,
      ALICE_COA,
      [amountProofUnwrap.txCommit[0], amountProofUnwrap.txCommit[1]],
      Array.from(amountProofUnwrap.proof),
      Array.from(transferProofUnwrap.publicInputs),
      Array.from(transferProofUnwrap.proof),
    ])
    .slice(2);

  const unwrapTx = flowTx(
    TX_UNWRAP,
    [
      { type: "UFix64", value: "2.00000000" },
      { type: "String", value: ALICE_COA },
      arrUInt256(amountProofUnwrap.txCommit),
      arrUInt256(amountProofUnwrap.proof),
      arrUInt256(transferProofUnwrap.publicInputs),
      arrUInt256(transferProofUnwrap.proof),
      { type: "String", value: unwrapCalldata },
    ],
    ALICE_SIGNER
  );
  results.txHashes.unwrap = unwrapTx.txId || null;

  if (!unwrapTx.ok) {
    fail(`Unwrap failed: ${unwrapTx.error}`);
    failures++;
    finalize(results, failures);
    return failures > 0 ? 1 : 0;
  }
  pass(`Unwrap sealed — tx ${unwrapTx.txId}`);

  aliceBalanceWei -= unwrapWei;
  aliceBlinding = unwrapNewBlinding;
  info(`Alice final shielded balance: ${aliceBalanceWei / flowToWei(1n)} FLOW (expected 0)`);

  // ── Step 5: accounting ────────────────────────────────────────────────────
  logStep("Step 5: accounting");
  if (aliceBalanceWei !== 0n) {
    fail(`Local accounting off: aliceBalanceWei = ${aliceBalanceWei}, expected 0`);
    failures++;
  } else {
    pass("Local accounting: Alice 5 = 2 + 1 (sent) + 2 (unwrapped) ✓");
  }

  const totalLockedAfter = await callView("totalLocked");
  info(`totalLocked: ${totalLockedBefore} → ${totalLockedAfter} wei`);
  // After 5 wrap and 2 unwrap, totalLocked should have increased by 3 * 1e18.
  // (Shielded transfers don't change totalLocked — funds stay in the pool.)
  const expectedDelta = flowToWei(3n);
  const actualDelta = BigInt(totalLockedAfter) - BigInt(totalLockedBefore);
  if (actualDelta === expectedDelta) {
    pass(`totalLocked delta matches: +${actualDelta / flowToWei(1n)} FLOW`);
  } else {
    fail(`totalLocked delta = ${actualDelta} wei, expected ${expectedDelta} wei`);
    failures++;
  }
  results.totalLockedBefore = totalLockedBefore.toString();
  results.totalLockedAfter = totalLockedAfter.toString();

  // ── Done ──────────────────────────────────────────────────────────────────
  finalize(results, failures);
  return failures > 0 ? 1 : 0;
}

function finalize(results, failures) {
  results.completedAt = new Date().toISOString();
  results.failures = failures;
  const outPath = join(PROJECT_ROOT, "scripts/v03-smoke-results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);
  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
  } else {
    console.log("\nALL TESTS PASSED");
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
  });
