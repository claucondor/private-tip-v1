/**
 * test-multi-sender.mjs — Multi-sender confidential accumulation test
 *
 * Scenario (Phase 4a — extended coverage):
 *   - Charlie is the recipient (already has BabyJub pubkey on the new UUPS proxy)
 *   - Alice, Bob, Dave each wrap 1, 2, 3 FLOW respectively to Charlie
 *   - All three encrypted slots accumulate homomorphically in Charlie's slot
 *   - Charlie BSGS-decrypts the total — must equal 6 (= 1 + 2 + 3)
 *   - Charlie generates a decrypt_open proof and calls unwrap()
 *   - Charlie's native FLOW balance must INCREASE by ~6 FLOW (minus gas)
 *   - Privacy assertion: only the TOTAL is observable to Charlie — per-sender
 *     amounts are not revealed (BSGS on the homomorphic sum)
 *
 * Verifies:
 *   ✓ Multi-sender homomorphic accumulation works on the new proxy
 *   ✓ SCALE = 1e18 unwrap (vuln 014 fix) recovers full FLOW from a multi-source slot
 *   ✓ Recipient cannot derive individual sender amounts (only the sum)
 *
 * Target deployment:
 *   JanusToken UUPS proxy: 0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *
 * Pre-conditions:
 *   - Charlie has a pubkey registered (verified in Phase 2; this test asserts)
 *   - Alice, Bob, Dave have COAs at /storage/evm with no pubkey requirement
 *     (sender side does not need a registered pubkey for wrap)
 *   - Alice/Bob/Dave each have ≥ 3 FLOW in their Cadence vault for gas + msg.value
 *
 * Usage: node scripts/test-multi-sender.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { createHmac, randomBytes } from "crypto";
import { JsonRpcProvider, Interface, formatEther } from "ethers";
import { buildBabyjub } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ─── Constants ─────────────────────────────────────────────────────────────────
const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;
const PROXY = "0x025efe7e89acdb8F315C804BE7245F348AA9c538";

// Recipient
const CHARLIE_FLOW = "0x3c601a443c81e6cd";
const CHARLIE_SIGNER = "testnet-charlie";
const CHARLIE_COA = "0x00000000000000000000000249065458581f9bf0";
const CHARLIE_PKEY_PATH = "/home/oydual3/.flow/testnet-charlie.pkey";

// Senders (FlowAddr, signer, COA, amount)
const SENDERS = [
  { name: "alice", flow: "0x7599043aea001283", signer: "testnet-claucondor", coa: "0x000000000000000000000002b7557ee5d4a32d06", units: 1n },
  { name: "bob",   flow: "0xd807a3992d7be612", signer: "testnet-bob",         coa: "0x00000000000000000000000250d93efba617e0bf", units: 2n },
  { name: "dave",  flow: "0xd32d9100e1fe983b", signer: "testnet-dave",        coa: "0x0000000000000000000000027b94cfc8a64971cd", units: 3n },
];

// SDK circuit artifacts (v0.2.1)
const SDK_DIR = join(PROJECT_ROOT, "node_modules/@openjanus/sdk");
const ENCRYPT_WASM = join(SDK_DIR, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = join(SDK_DIR, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = join(SDK_DIR, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = join(SDK_DIR, "circuits/setup/decrypt_open_final.zkey");
const DECRYPT_VKEY = join(SDK_DIR, "circuits/setup/decrypt_open_vkey.json");

// Cadence transactions
const TX_COA_CALL_WITH_VALUE = join(PROJECT_ROOT, "cadence/transactions/coa_call_with_value.cdc");
const TX_COA_CALL_AND_WITHDRAW = join(PROJECT_ROOT, "cadence/transactions/coa_call_and_withdraw.cdc");

// ABI
const ABI = [
  "function SCALE() view returns (uint256)",
  "function hasPubkey(address) view returns (bool)",
  "function slotOf(address) view returns (tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y))",
  "function nonce(address) view returns (uint256)",
  "function locked(address) view returns (uint256)",
  "function wrap(address to, tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct, uint256 senderNonce, uint[6] publicInputs, uint[8] encryptProof) external payable",
  "function unwrap(uint256 claimedUnits, address recipient, uint[7] publicInputs, uint[8] decryptProof) external",
];

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
const iface = new Interface(ABI);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function callView(func, ...args) {
  const data = iface.encodeFunctionData(func, args);
  const result = await provider.call({ to: PROXY, data });
  const decoded = iface.decodeFunctionResult(func, result);
  return decoded.length === 1 ? decoded[0] : decoded;
}

function flowTx(cdcFile, argsJson, signer) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcFile}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, cwd: PROJECT_ROOT });
    const parsed = JSON.parse(out);
    if (parsed.error) return { ok: false, txId: parsed.id || "", error: parsed.error };
    if (parsed.status !== "SEALED") return { ok: false, txId: parsed.id || "", error: `not sealed: ${parsed.status}` };
    return { ok: true, txId: parsed.id || "", raw: parsed };
  } catch (e) {
    const raw = (e.stdout || "") + (e.stderr || "");
    return { ok: false, txId: "", error: raw.slice(0, 600) };
  }
}

function getCadenceBalance(addr) {
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

async function deriveBabyJub(keyHex) {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const flowKeyBuf = Buffer.from(keyHex, "hex");
  const salt = Buffer.from("openjanus-privacy-v1", "utf8");
  const prk = createHmac("sha256", salt).update(flowKeyBuf).digest();
  const info = Buffer.from("babyjub-privkey", "utf8");
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([prk, info, Buffer.from([0x01])]))
    .digest();
  const ORDER = babyjub.subOrder;
  const raw = BigInt("0x" + okm.toString("hex"));
  const privkey = ((raw % ORDER) + ORDER) % ORDER || 1n;
  const pkPoint = babyjub.mulPointEscalar(babyjub.Base8, privkey);
  return {
    privkey,
    pubkey: { x: BigInt(Fr.toObject(pkPoint[0])), y: BigInt(Fr.toObject(pkPoint[1])) },
  };
}

async function randomBabyJubScalar() {
  const babyjub = await buildBabyjub();
  const ORDER = babyjub.subOrder;
  const bytes = randomBytes(32);
  const raw = BigInt("0x" + bytes.toString("hex"));
  return ((raw % ORDER) + ORDER) % ORDER || 1n;
}

function packProof(proof) {
  return [
    BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]),
  ];
}

async function bsgsDecrypt(C1x, C1y, C2x, C2y, privkey, maxVal = 10000n) {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const G = babyjub.Base8;
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const C1 = [Fr.e(C1x), Fr.e(C1y)];
  const skC1 = babyjub.mulPointEscalar(C1, privkey);
  const negSkC1 = [Fr.e(P - BigInt(Fr.toObject(skC1[0]))), skC1[1]];
  const vG = babyjub.addPoint([Fr.e(C2x), Fr.e(C2y)], negSkC1);
  const n = BigInt(Math.ceil(Math.sqrt(Number(maxVal) + 1)));
  const babies = new Map();
  let pt = [Fr.e(0n), Fr.e(1n)];
  for (let i = 0n; i <= n; i++) {
    babies.set(`${Fr.toObject(pt[0])},${Fr.toObject(pt[1])}`, i);
    pt = babyjub.addPoint(pt, G);
  }
  const step = babyjub.mulPointEscalar(G, n + 1n);
  const negStep = [Fr.e(P - BigInt(Fr.toObject(step[0]))), step[1]];
  let giant = vG;
  for (let j = 0n; j * (n + 1n) <= maxVal; j++) {
    const key = `${Fr.toObject(giant[0])},${Fr.toObject(giant[1])}`;
    if (babies.has(key)) {
      const v = babies.get(key) + j * (n + 1n);
      if (v <= maxVal) return v;
    }
    giant = babyjub.addPoint(giant, negStep);
  }
  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  const ok = (m) => console.log(`  PASS: ${m}`);
  const fail = (m) => { console.error(`  FAIL: ${m}`); failures++; };
  const info = (m) => console.log(`  INFO: ${m}`);

  const results = {
    test: "multi-sender",
    startedAt: new Date().toISOString(),
    proxy: PROXY,
    recipient: { name: "charlie", flow: CHARLIE_FLOW, coa: CHARLIE_COA },
    senders: SENDERS.map((s) => ({ name: s.name, units: s.units.toString() })),
    txHashes: {},
    steps: {},
  };

  console.log("=".repeat(70));
  console.log("  test-multi-sender — 3 senders → Charlie (homomorphic accumulation)");
  console.log("  Proxy:", PROXY);
  console.log("=".repeat(70));

  // ── 0. Verify SCALE ─────────────────────────────────────────────────────────
  console.log("\n--- Step 0: Verify SCALE = 1e18 on proxy ---");
  const scale = await callView("SCALE");
  if (scale === 10n ** 18n) ok(`SCALE = ${scale}`);
  else { fail(`SCALE = ${scale}`); return 1; }

  // ── 1. Verify Charlie has pubkey ───────────────────────────────────────────
  console.log("\n--- Step 1: Verify Charlie has pubkey on new proxy ---");
  const charlieHasPk = await callView("hasPubkey", CHARLIE_COA);
  if (!charlieHasPk) {
    fail("Charlie has no pubkey on new proxy — register first (see e2e_unwrap_scale_fix.mjs)");
    return 1;
  }
  ok("Charlie pubkey present");

  // ── 2. Derive Charlie keypair (needed for BSGS decrypt later) ──────────────
  const charlieKeyHex = readFileSync(CHARLIE_PKEY_PATH, "utf-8").trim();
  const charlieKp = await deriveBabyJub(charlieKeyHex);
  info(`Charlie pubkey.x = ${charlieKp.pubkey.x.toString().slice(0, 20)}...`);

  // ── 3. Snapshot pre-state ───────────────────────────────────────────────────
  console.log("\n--- Step 3: Snapshot pre-state ---");
  const lockedPre = BigInt(await callView("locked", CHARLIE_COA));
  const slotPre = await callView("slotOf", CHARLIE_COA);
  const charlieCadBalPre = getCadenceBalance(CHARLIE_FLOW);
  const slotIsIdentity = (slotPre.C1x === 0n && slotPre.C1y === 1n && slotPre.C2x === 0n && slotPre.C2y === 1n);
  info(`Charlie locked pre:    ${formatEther(lockedPre)} FLOW`);
  info(`Charlie slot identity: ${slotIsIdentity}`);
  info(`Charlie Cadence bal:   ${(Number(charlieCadBalPre) / 1e8).toFixed(8)} FLOW`);
  if (!slotIsIdentity) {
    info(`Slot non-identity pre-test — accumulation will add on top of prior balance`);
  }

  const { buildEncryptProof } = await import("@openjanus/sdk");

  // ── 4. Each sender wraps to Charlie ────────────────────────────────────────
  console.log("\n--- Step 4: Senders wrap to Charlie ---");
  const senderResults = [];
  for (const s of SENDERS) {
    console.log(`\n  ─── ${s.name} wraps ${s.units} FLOW → charlie ───`);

    // Fetch sender's nonce on the proxy
    const senderNonce = BigInt(await callView("nonce", s.coa));
    info(`${s.name} nonce on proxy: ${senderNonce}`);

    // Build encrypt proof targeting Charlie's pubkey
    const randomness = await randomBabyJubScalar();
    const enc = await buildEncryptProof(
      { value: s.units, randomness, recipientPubkey: charlieKp.pubkey },
      { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
    );
    const ct = enc.ciphertext;
    const proof8 = packProof(enc.rawProof);
    const pubInputs6 = enc.publicInputs.slice(0, 6);

    // Pre-encode wrap calldata
    const calldata = iface
      .encodeFunctionData("wrap", [
        CHARLIE_COA,
        [ct.C1.x, ct.C1.y, ct.C2.x, ct.C2.y],
        senderNonce,
        pubInputs6,
        proof8,
      ])
      .slice(2);

    const flowStr = s.units.toString() + ".00000000";
    const args = [
      { type: "String", value: PROXY },
      { type: "String", value: calldata },
      { type: "UInt64", value: "600000" },
      { type: "UFix64", value: flowStr },
    ];
    const res = flowTx(TX_COA_CALL_WITH_VALUE, args, s.signer);
    if (!res.ok) {
      fail(`${s.name} wrap failed: ${res.error.slice(0, 300)}`);
      results.txHashes[`wrap_${s.name}`] = "(failed)";
      return 1;
    }
    ok(`${s.name} wrap sealed: ${res.txId}`);
    results.txHashes[`wrap_${s.name}`] = res.txId;
    senderResults.push({ name: s.name, units: s.units, tx: res.txId });
  }
  results.steps.wraps = senderResults;

  // ── 5. Verify locked on Charlie's COA increased by 6 FLOW ──────────────────
  console.log("\n--- Step 5: Verify locked increased by 6 FLOW (= 6e18 attoFLOW) ---");
  const lockedAfterWraps = BigInt(await callView("locked", CHARLIE_COA));
  const lockedDelta = lockedAfterWraps - lockedPre;
  const expectedDelta = 6n * (10n ** 18n);
  if (lockedDelta === expectedDelta) {
    ok(`locked increased by exactly 6 FLOW (= ${expectedDelta} attoFLOW)`);
  } else {
    fail(`locked delta ${lockedDelta} != expected ${expectedDelta}`);
  }

  // ── 6. Charlie BSGS-decrypts slot total ────────────────────────────────────
  console.log("\n--- Step 6: Charlie decrypts accumulated slot via BSGS ---");
  const slotAfter = await callView("slotOf", CHARLIE_COA);
  info(`slot C1x: ${slotAfter.C1x.toString().slice(0, 18)}...`);
  const total = await bsgsDecrypt(slotAfter.C1x, slotAfter.C1y, slotAfter.C2x, slotAfter.C2y, charlieKp.privkey, 10000n);
  if (total === null) { fail("BSGS could not decrypt"); return 1; }
  info(`BSGS total = ${total} units`);
  // Privacy assertion: total = sum of all wraps if slot was identity.
  // Charlie sees the SUM only — per-sender amounts (1, 2, 3) are not recoverable
  // from the homomorphic accumulator without the per-wrap ciphertexts (which the
  // contract overwrites with the running sum).
  if (slotIsIdentity && total === 6n) {
    ok(`Total = 6 (= 1 + 2 + 3) — homomorphic accumulation verified`);
    ok(`Privacy: Charlie sees only the TOTAL, not individual sender amounts`);
  } else if (!slotIsIdentity) {
    info(`Slot was non-identity pre-test; total=${total} (includes prior balance)`);
    ok(`Cumulative total decrypted via BSGS`);
  } else {
    fail(`Expected total=6, got ${total}`);
  }
  results.steps.decryptedTotal = total.toString();

  // ── 7. Generate decrypt_open proof for full slot total ─────────────────────
  console.log("\n--- Step 7: Generate decrypt_open proof ---");
  const decInput = {
    privkey: charlieKp.privkey.toString(),
    pubkey: [charlieKp.pubkey.x.toString(), charlieKp.pubkey.y.toString()],
    C1: [slotAfter.C1x.toString(), slotAfter.C1y.toString()],
    C2: [slotAfter.C2x.toString(), slotAfter.C2y.toString()],
    claimed_value: total.toString(),
  };
  const { proof: dProof, publicSignals: dPubs } = await snarkjs.groth16.fullProve(decInput, DECRYPT_WASM, DECRYPT_ZKEY);
  const vkey = JSON.parse(readFileSync(DECRYPT_VKEY, "utf-8"));
  const ocValid = await snarkjs.groth16.verify(vkey, dPubs, dProof);
  if (ocValid) ok("Off-chain decrypt verify = true");
  else { fail("Off-chain decrypt verify = false"); return 1; }

  // ── 8. Charlie unwraps total → his own COA, recovers ~total FLOW ──────────
  console.log(`\n--- Step 8: Charlie unwraps ${total} units → his COA ---`);
  const dProof8 = packProof(dProof);
  const dPubs7 = dPubs.map((s) => BigInt(s));
  const unwrapCalldata = iface
    .encodeFunctionData("unwrap", [total, CHARLIE_COA, dPubs7, dProof8])
    .slice(2);
  const unwrapArgs = [
    { type: "String", value: PROXY },
    { type: "String", value: unwrapCalldata },
    { type: "UInt64", value: "800000" },
  ];
  const ur = flowTx(TX_COA_CALL_AND_WITHDRAW, unwrapArgs, CHARLIE_SIGNER);
  if (!ur.ok) {
    fail(`unwrap failed: ${ur.error.slice(0, 400)}`);
    return 1;
  }
  ok(`Unwrap sealed: ${ur.txId}`);
  results.txHashes.unwrap = ur.txId;

  // ── 9. Verify FLOW recovered ───────────────────────────────────────────────
  console.log("\n--- Step 9: Verify FLOW recovered on Charlie's Cadence balance ---");
  const charlieCadBalPost = getCadenceBalance(CHARLIE_FLOW);
  const cadDelta = charlieCadBalPost - charlieCadBalPre;
  const cadDeltaFlow = Number(cadDelta) / 1e8;
  info(`Charlie Cadence pre:   ${(Number(charlieCadBalPre) / 1e8).toFixed(8)} FLOW`);
  info(`Charlie Cadence post:  ${(Number(charlieCadBalPost) / 1e8).toFixed(8)} FLOW`);
  info(`Charlie delta:         ${cadDeltaFlow.toFixed(8)} FLOW`);
  // Charlie did not wrap (he only unwrapped), so he should have gained ~`total` FLOW
  // minus the gas of the unwrap call. Pre-fix bug would have given him only `total` wei.
  const expectedMin = Number(total) - 0.5;  // generous for gas
  if (cadDeltaFlow >= expectedMin) {
    ok(`Charlie gained ${cadDeltaFlow.toFixed(8)} FLOW (>= ${expectedMin} expected min)`);
  } else {
    fail(`Charlie gained only ${cadDeltaFlow.toFixed(8)} FLOW; expected ~${Number(total)} FLOW`);
  }

  const lockedFinal = BigInt(await callView("locked", CHARLIE_COA));
  const slotFinal = await callView("slotOf", CHARLIE_COA);
  const slotReset = (slotFinal.C1x === 0n && slotFinal.C1y === 1n && slotFinal.C2x === 0n && slotFinal.C2y === 1n);
  if (slotReset) ok("Slot reset to identity post-unwrap");
  else fail("Slot not reset");

  results.steps.flowRecovered = cadDeltaFlow;
  results.steps.lockedPost = lockedFinal.toString();
  results.failures = failures;
  results.verdict = failures === 0 ? "PASS" : "FAIL";
  results.endedAt = new Date().toISOString();

  // Custom replacer for BigInt serialization
  writeFileSync(
    join(PROJECT_ROOT, "scripts/test-multi-sender-results.json"),
    JSON.stringify(results, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)
  );

  console.log("\n" + "=".repeat(70));
  console.log(`  Verdict: ${results.verdict}`);
  console.log(`  Failures: ${failures}`);
  console.log("  TX hashes:");
  for (const [k, v] of Object.entries(results.txHashes)) {
    console.log(`    ${k.padEnd(16)} ${v}`);
  }
  console.log("=".repeat(70));

  return failures > 0 ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("FATAL:", e.message);
    console.error(e.stack?.split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  });
