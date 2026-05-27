/**
 * test-router-claim.mjs — Functional test for the new PrivateTip router (Phase 3).
 *
 * Verifies vuln 015 is fixed:
 *   1. Charlie sends a 1 FLOW tip to Alice.
 *   2. Alice claims it herself — her balance increases by ~1 FLOW (minus gas).
 *   3. Bob tries to claim Alice's tip with a fresh tipID — must REVERT.
 *
 * Account roles in this test (all on testnet, all already exist):
 *   sender   = testnet-charlie (0x3c601a443c81e6cd)  — has plenty of FLOW
 *   alice    = testnet-claucondor (0x7599043aea001283) — recipient
 *   attacker = testnet-bob (0xd807a3992d7be612) — must fail to claim
 *
 * Bob keeps his account as a regular test user; he is NO LONGER the PrivateTip
 * deployer (the new router lives on openjanus-privatetip-router, 0xb9ac529c14a4c5a1).
 *
 * Usage:
 *   node scripts/test-router-claim.mjs
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";

const ROUTER_FLOW = "0xb9ac529c14a4c5a1";
const CHARLIE = "0x3c601a443c81e6cd";
const ALICE   = "0x7599043aea001283";
const BOB     = "0xd807a3992d7be612";
const CHARLIE_SIGNER = "testnet-charlie";
const ALICE_SIGNER   = "testnet-claucondor";
const BOB_SIGNER     = "testnet-bob";

const SEND_TX  = "cadence/transactions/send_tip.cdc";
const CLAIM_TX = "cadence/transactions/claim_tips.cdc";

const txHashes = {};
let failures = 0;
const ok = (m) => console.log(`  PASS: ${m}`);
const fail = (m) => { console.error(`  FAIL: ${m}`); failures++; };
const info = (m) => console.log(`  INFO: ${m}`);

function flowTxRaw(cdcFile, argsJson, signer) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcFile}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
    const parsed = JSON.parse(out);
    return { ok: parsed.status === "SEALED" && !parsed.error, txId: parsed.id, error: parsed.error, raw: parsed };
  } catch (e) {
    const raw = (e.stdout || "") + (e.stderr || "");
    let txId = "";
    try { txId = JSON.parse(e.stdout || "{}").id || ""; } catch {}
    return { ok: false, txId, error: raw.slice(0, 700) };
  }
}

function balRaw(addr) {
  const out = execSync(`flow accounts get ${addr} --network testnet -o json`, { encoding: "utf-8" });
  const parsed = JSON.parse(out);
  const balStr = String(parsed.balance);
  if (balStr.includes(".")) {
    const [whole, frac] = balStr.split(".");
    const fracPadded = (frac + "00000000").slice(0, 8);
    return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
  }
  return BigInt(balStr) * 100_000_000n;
}

function fmt(raw) {
  return (Number(raw) / 1e8).toFixed(8);
}

function getTipID(txRaw) {
  // The router emits TipSent with tipID. Parse events from the tx response.
  // Flow CLI JSON returns "events": [ { type, values: { value: { fields: [...] } } } ]
  const events = txRaw?.events ?? [];
  for (const e of events) {
    const type = e.type || "";
    if (type.endsWith(".PrivateTip.TipSent")) {
      const fields = e.values?.value?.fields ?? [];
      const tipIdField = fields.find((f) => f.name === "tipID");
      if (tipIdField) {
        return BigInt(tipIdField.value.value);
      }
    }
  }
  return null;
}

async function main() {
  console.log("=".repeat(70));
  console.log("  PrivateTip router functional test (vuln 015 verification)");
  console.log(`  Router: ${ROUTER_FLOW}`);
  console.log("=".repeat(70));

  // ── Step 1: Charlie sends Alice 1.5 FLOW ──────────────────────────────────
  console.log("\n--- Step 1: Charlie sends Alice 1.5 FLOW ---");
  const aliceBalBefore = balRaw(ALICE);
  info(`Alice balance before:  ${fmt(aliceBalBefore)} FLOW`);

  const sendArgs = [
    { type: "Address", value: ALICE },
    { type: "UFix64", value: "1.50000000" },
    { type: "String", value: "phase-3-functional-test" },
  ];
  const sendRes = flowTxRaw(SEND_TX, sendArgs, CHARLIE_SIGNER);
  if (!sendRes.ok) {
    fail(`sendTip failed: ${sendRes.error.slice(0, 300)}`);
    return 1;
  }
  ok(`Charlie sent tip — tx ${sendRes.txId}`);
  txHashes.sendTip = sendRes.txId;
  const tipID = getTipID(sendRes.raw);
  if (tipID === null) {
    fail("could not parse tipID from TipSent event");
    return 1;
  }
  info(`tipID = ${tipID}`);

  // ── Step 2: Bob (attacker) tries to claim Alice's tip — MUST FAIL ─────────
  console.log("\n--- Step 2: Bob tries to claim Alice's tip — MUST FAIL ---");
  const claimArgs = [
    { type: "Array", value: [{ type: "UInt64", value: tipID.toString() }] },
  ];
  const bobRes = flowTxRaw(CLAIM_TX, claimArgs, BOB_SIGNER);
  if (bobRes.ok) {
    fail("Bob's claim succeeded — vuln 015 NOT fixed!");
    return 1;
  } else {
    ok("Bob's claim was rejected (as expected)");
    info(`reject reason snippet: ${(bobRes.error || "").slice(0, 200)}`);
    txHashes.bobAttempt = bobRes.txId || "(no txId — pre-execute reject)";
  }

  // ── Step 3: Alice claims her own tip — must SUCCEED ───────────────────────
  console.log("\n--- Step 3: Alice claims her own tip — must SUCCEED ---");
  const aliceRes = flowTxRaw(CLAIM_TX, claimArgs, ALICE_SIGNER);
  if (!aliceRes.ok) {
    fail(`Alice's claim failed: ${aliceRes.error.slice(0, 300)}`);
    return 1;
  }
  ok(`Alice claimed her tip — tx ${aliceRes.txId}`);
  txHashes.aliceClaim = aliceRes.txId;

  // ── Step 4: Verify Alice's balance increased by ~1.5 FLOW (minus gas) ─────
  console.log("\n--- Step 4: Verify Alice's balance increased ---");
  const aliceBalAfter = balRaw(ALICE);
  const delta = aliceBalAfter - aliceBalBefore;
  const deltaFlow = Number(delta) / 1e8;
  info(`Alice balance after:   ${fmt(aliceBalAfter)} FLOW`);
  info(`Alice net delta:       ${deltaFlow.toFixed(8)} FLOW`);

  // Alice paid one tx gas (claim) and received 1.5 FLOW.
  // Net delta should be ~ +1.5 FLOW - (gas, < 0.01).
  if (deltaFlow >= 1.45 && deltaFlow <= 1.5) {
    ok(`Alice received the tip (delta = ${deltaFlow.toFixed(8)} FLOW)`);
  } else {
    fail(`Alice's net delta ${deltaFlow.toFixed(8)} FLOW outside expected band [1.45, 1.5]`);
  }

  // ── Step 5: Re-claim of same tip MUST FAIL ────────────────────────────────
  console.log("\n--- Step 5: Alice cannot re-claim already-claimed tip ---");
  const reclaimRes = flowTxRaw(CLAIM_TX, claimArgs, ALICE_SIGNER);
  if (reclaimRes.ok) {
    fail("Alice re-claimed same tip — double-spend bug!");
  } else {
    ok("Alice cannot re-claim already-claimed tip (as expected)");
    info(`reject snippet: ${(reclaimRes.error || "").slice(0, 200)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log(`  Failures: ${failures}`);
  console.log(`  Verdict:  ${failures === 0 ? "PASS" : "FAIL"}`);
  console.log("  TX hashes:");
  for (const [k, v] of Object.entries(txHashes)) {
    console.log(`    ${k.padEnd(14)} ${v}`);
  }
  console.log("=".repeat(70));

  writeFileSync(
    "/home/oydual3/zkapps/private-tip-v1/scripts/test-router-claim-results.json",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      router: ROUTER_FLOW,
      tipID: tipID?.toString(),
      txHashes,
      failures,
      verdict: failures === 0 ? "PASS" : "FAIL",
    }, null, 2)
  );

  return failures > 0 ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
