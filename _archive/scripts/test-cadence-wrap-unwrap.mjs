/**
 * test-cadence-wrap-unwrap.mjs — Verify Cadence JanusFlow router path
 *
 * Scenario (Phase 4a — extended coverage):
 *   - Alice wraps 1 FLOW VIA the Cadence JanusFlow router (not direct EVM)
 *     - JanusFlow.wrap moves 1 FLOW from Alice's Cadence vault into the router
 *       vault AND triggers the EVM JanusToken.wrap via Alice's COA (msg.value = 1 FLOW)
 *     - EVM proxy increments locked[alice_COA] by 1e18 attoFLOW
 *     - Slot for alice_COA receives the encrypted ciphertext
 *
 *   - Alice unwraps VIA JanusFlow.unwrap:
 *     - Calls EVM JanusToken.unwrap (which sends 1e18 wei back to alice_COA)
 *     - Router withdraws 1 FLOW from its Cadence vault → alice's Cadence vault
 *     - Net: alice ends ~where she started (minus gas) — but proves the Cadence
 *       router properly proxies to the new v0.2.1 EVM proxy.
 *
 * Why Alice: she's the only sender (besides Charlie) with an EVM COA pre-funded
 * with enough FLOW for the msg.value side. She has 10 FLOW in her COA at test time.
 *
 * NOTE on architecture: the JanusFlow Cadence router maintains parallel custody
 * (its own FlowToken vault) plus calls the EVM proxy via the user's COA. Both
 * sides increment / decrement on wrap / unwrap. The recipient COA is also alice's
 * own COA in this test (self-wrap), so EVM proxy returns the FLOW to alice_COA
 * on unwrap. This test exercises the full Cadence-mediated round trip — proving
 * the import targets the new v0.2.1 router (0x5dcbeb41055ec57e) which points at
 * the new UUPS proxy (0x025efe7e89acdb8F315C804BE7245F348AA9c538).
 *
 * Target:
 *   JanusFlow Cadence router: 0x5dcbeb41055ec57e
 *   JanusToken EVM UUPS proxy: 0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *
 * Pre-conditions:
 *   - Alice's pubkey may or may not be registered. If not, this test registers it.
 *
 * Usage: node scripts/test-cadence-wrap-unwrap.mjs
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

// Alice (sender + recipient — self-wrap)
const ALICE_FLOW = "0x7599043aea001283";
const ALICE_SIGNER = "testnet-claucondor";
const ALICE_COA = "0x000000000000000000000002b7557ee5d4a32d06";
const ALICE_PKEY_PATH = "/home/oydual3/.flow/testnet-claucondor.pkey";

// SDK circuit artifacts
const SDK_DIR = join(PROJECT_ROOT, "node_modules/@openjanus/sdk");
const ENCRYPT_WASM = join(SDK_DIR, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = join(SDK_DIR, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = join(SDK_DIR, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = join(SDK_DIR, "circuits/setup/decrypt_open_final.zkey");
const DECRYPT_VKEY = join(SDK_DIR, "circuits/setup/decrypt_open_vkey.json");

// Cadence transactions (newly added for this test)
const TX_JF_WRAP = join(PROJECT_ROOT, "cadence/transactions/jf_wrap.cdc");
const TX_JF_UNWRAP = join(PROJECT_ROOT, "cadence/transactions/jf_unwrap.cdc");
const TX_JF_REGISTER = join(PROJECT_ROOT, "cadence/transactions/jf_register_pubkey.cdc");

const ABI = [
  "function SCALE() view returns (uint256)",
  "function hasPubkey(address) view returns (bool)",
  "function pubkeyOf(address) view returns (uint256 x, uint256 y)",
  "function slotOf(address) view returns (tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y))",
  "function nonce(address) view returns (uint256)",
  "function locked(address) view returns (uint256)",
  "function registerPubkey(uint256 x, uint256 y) external",
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

// Pack BigInt -> 32 bytes as UInt8 array (for Cadence ciphertext arg)
function bnToBytes32(n) {
  const hex = n.toString(16).padStart(64, "0");
  const out = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  const ok = (m) => console.log(`  PASS: ${m}`);
  const fail = (m) => { console.error(`  FAIL: ${m}`); failures++; };
  const info = (m) => console.log(`  INFO: ${m}`);

  const results = {
    test: "cadence-wrap-unwrap",
    startedAt: new Date().toISOString(),
    cadenceRouter: "0x5dcbeb41055ec57e",
    evmProxy: PROXY,
    alice: { flow: ALICE_FLOW, coa: ALICE_COA },
    txHashes: {},
    steps: {},
  };

  console.log("=".repeat(70));
  console.log("  test-cadence-wrap-unwrap — JanusFlow router → EVM proxy");
  console.log("  Cadence router: 0x5dcbeb41055ec57e");
  console.log("  EVM proxy:      ", PROXY);
  console.log("=".repeat(70));

  // ── 0. Verify SCALE ─────────────────────────────────────────────────────────
  console.log("\n--- Step 0: Verify SCALE on EVM proxy ---");
  const scale = await callView("SCALE");
  if (scale === 10n ** 18n) ok(`SCALE = ${scale}`);
  else { fail(`SCALE = ${scale}`); return 1; }

  // ── 1. Derive Alice keypair ─────────────────────────────────────────────────
  const aliceKeyHex = readFileSync(ALICE_PKEY_PATH, "utf-8").trim();
  const aliceKp = await deriveBabyJub(aliceKeyHex);
  info(`Alice pubkey.x = ${aliceKp.pubkey.x.toString().slice(0, 20)}...`);

  // ── 2. Register Alice's pubkey on EVM proxy if not present ─────────────────
  console.log("\n--- Step 2: Ensure Alice has pubkey on new EVM proxy ---");
  const hasPk = await callView("hasPubkey", ALICE_COA);
  if (hasPk) {
    const [onPkx, onPky] = await callView("pubkeyOf", ALICE_COA);
    if (BigInt(onPkx) !== aliceKp.pubkey.x || BigInt(onPky) !== aliceKp.pubkey.y) {
      fail(`Alice on-chain pubkey != derived; on-chain.x=${onPkx.toString().slice(0,15)} derived.x=${aliceKp.pubkey.x.toString().slice(0,15)}`);
      return 1;
    }
    ok("Alice pubkey already registered + matches derived");
  } else {
    info("Alice has no pubkey on new proxy — registering via Cadence JanusFlow router...");
    const registerCalldata = iface
      .encodeFunctionData("registerPubkey", [aliceKp.pubkey.x, aliceKp.pubkey.y])
      .slice(2);
    // 64-byte pubkey for the Cadence router (x || y, big-endian 32B each)
    const pubkeyBytes = [...bnToBytes32(aliceKp.pubkey.x), ...bnToBytes32(aliceKp.pubkey.y)];
    const regArgs = [
      { type: "Array", value: pubkeyBytes.map((b) => ({ type: "UInt8", value: b.toString() })) },
      { type: "String", value: registerCalldata },
    ];
    const regRes = flowTx(TX_JF_REGISTER, regArgs, ALICE_SIGNER);
    if (!regRes.ok) {
      fail(`Cadence registerPubkey failed: ${regRes.error.slice(0, 400)}`);
      return 1;
    }
    ok(`Alice pubkey registered via Cadence router: ${regRes.txId}`);
    results.txHashes.register = regRes.txId;
  }

  // ── 3. Snapshot pre-state ───────────────────────────────────────────────────
  console.log("\n--- Step 3: Snapshot pre-state ---");
  const aliceNonce0 = BigInt(await callView("nonce", ALICE_COA));
  const lockedPre = BigInt(await callView("locked", ALICE_COA));
  const slotPre = await callView("slotOf", ALICE_COA);
  const aliceCadBalPre = getCadenceBalance(ALICE_FLOW);
  const slotIsIdentity = (slotPre.C1x === 0n && slotPre.C1y === 1n && slotPre.C2x === 0n && slotPre.C2y === 1n);
  info(`Alice EVM nonce:       ${aliceNonce0}`);
  info(`Alice locked pre:      ${formatEther(lockedPre)} FLOW`);
  info(`Alice slot identity:   ${slotIsIdentity}`);
  info(`Alice Cadence bal:     ${(Number(aliceCadBalPre) / 1e8).toFixed(8)} FLOW`);
  if (!slotIsIdentity) {
    info("Alice slot is non-identity — accumulation will happen on top of existing balance");
  }

  // ── 4. Generate encrypt proof for Alice → Alice (self) ─────────────────────
  console.log("\n--- Step 4: Generate encrypt proof for 1 FLOW (Alice → Alice) ---");
  const { buildEncryptProof } = await import("@openjanus/sdk");
  const randomness = await randomBabyJubScalar();
  const enc = await buildEncryptProof(
    { value: 1n, randomness, recipientPubkey: aliceKp.pubkey },
    { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
  );
  const ct = enc.ciphertext;
  const proof8 = packProof(enc.rawProof);
  const pubInputs6 = enc.publicInputs.slice(0, 6);
  ok(`Encrypt proof generated (C1x=${ct.C1.x.toString().slice(0, 14)}...)`);

  // ── 5. Wrap via JanusFlow.wrap (Cadence router → EVM proxy) ────────────────
  console.log("\n--- Step 5: Wrap 1 FLOW via JanusFlow Cadence router ---");
  const wrapCalldata = iface
    .encodeFunctionData("wrap", [
      ALICE_COA,
      [ct.C1.x, ct.C1.y, ct.C2.x, ct.C2.y],
      aliceNonce0,
      pubInputs6,
      proof8,
    ])
    .slice(2);

  // ciphertext for Cadence router (128 bytes = 4 * 32 bytes)
  const ciphertextBytes = [
    ...bnToBytes32(ct.C1.x), ...bnToBytes32(ct.C1.y),
    ...bnToBytes32(ct.C2.x), ...bnToBytes32(ct.C2.y),
  ];

  const wrapArgs = [
    { type: "UFix64", value: "1.00000000" },
    { type: "Address", value: ALICE_FLOW },
    { type: "String", value: ALICE_COA },
    { type: "Array", value: ciphertextBytes.map((b) => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: aliceNonce0.toString() },
    { type: "String", value: wrapCalldata },
  ];
  const wrapRes = flowTx(TX_JF_WRAP, wrapArgs, ALICE_SIGNER);
  if (!wrapRes.ok) {
    fail(`JanusFlow.wrap failed: ${wrapRes.error.slice(0, 500)}`);
    return 1;
  }
  ok(`JanusFlow.wrap tx sealed: ${wrapRes.txId}`);
  results.txHashes.wrap = wrapRes.txId;

  // ── 6. Verify EVM slot updated ──────────────────────────────────────────────
  console.log("\n--- Step 6: Verify EVM slot updated by Cadence-mediated wrap ---");
  const lockedAfterWrap = BigInt(await callView("locked", ALICE_COA));
  const lockedDelta = lockedAfterWrap - lockedPre;
  const expectedDelta = 10n ** 18n;
  if (lockedDelta === expectedDelta) {
    ok(`EVM locked increased by exactly 1 FLOW (= ${expectedDelta} attoFLOW) via Cadence router`);
  } else {
    fail(`locked delta ${lockedDelta} != expected ${expectedDelta}`);
  }

  const slotAfter = await callView("slotOf", ALICE_COA);
  const slotChanged = !(slotAfter.C1x === slotPre.C1x && slotAfter.C1y === slotPre.C1y && slotAfter.C2x === slotPre.C2x && slotAfter.C2y === slotPre.C2y);
  if (slotChanged) ok("EVM slot ciphertext updated by Cadence router");
  else fail("EVM slot did not change");

  // ── 7. Decrypt + unwrap via JanusFlow.unwrap ───────────────────────────────
  console.log("\n--- Step 7: Generate decrypt_open proof for Alice's slot total ---");
  const total = await bsgsDecrypt(slotAfter.C1x, slotAfter.C1y, slotAfter.C2x, slotAfter.C2y, aliceKp.privkey, 10000n);
  if (total === null) { fail("BSGS could not decrypt Alice's slot"); return 1; }
  info(`BSGS total = ${total} units`);
  if (slotIsIdentity && total !== 1n) {
    fail(`Expected total=1, got ${total}`);
    return 1;
  }
  ok(`Decrypted Alice slot total = ${total}`);

  const decInput = {
    privkey: aliceKp.privkey.toString(),
    pubkey: [aliceKp.pubkey.x.toString(), aliceKp.pubkey.y.toString()],
    C1: [slotAfter.C1x.toString(), slotAfter.C1y.toString()],
    C2: [slotAfter.C2x.toString(), slotAfter.C2y.toString()],
    claimed_value: total.toString(),
  };
  const { proof: dProof, publicSignals: dPubs } = await snarkjs.groth16.fullProve(decInput, DECRYPT_WASM, DECRYPT_ZKEY);
  const vkey = JSON.parse(readFileSync(DECRYPT_VKEY, "utf-8"));
  const ocValid = await snarkjs.groth16.verify(vkey, dPubs, dProof);
  if (ocValid) ok("Off-chain decrypt verify = true");
  else { fail("Off-chain decrypt verify failed"); return 1; }

  console.log(`\n--- Step 8: Unwrap ${total} FLOW via JanusFlow Cadence router ---`);
  const dProof8 = packProof(dProof);
  const dPubs7 = dPubs.map((s) => BigInt(s));
  const unwrapCalldata = iface
    .encodeFunctionData("unwrap", [total, ALICE_COA, dPubs7, dProof8])
    .slice(2);

  const claimedAmountStr = total.toString() + ".00000000";
  const unwrapArgs = [
    { type: "UFix64", value: claimedAmountStr },
    { type: "Address", value: ALICE_FLOW },
    { type: "String", value: unwrapCalldata },
  ];
  const unwrapRes = flowTx(TX_JF_UNWRAP, unwrapArgs, ALICE_SIGNER);
  if (!unwrapRes.ok) {
    fail(`JanusFlow.unwrap failed: ${unwrapRes.error.slice(0, 500)}`);
    return 1;
  }
  ok(`JanusFlow.unwrap tx sealed: ${unwrapRes.txId}`);
  results.txHashes.unwrap = unwrapRes.txId;

  // ── 9. Verify recovery ──────────────────────────────────────────────────────
  console.log("\n--- Step 9: Verify EVM + Cadence side recovery ---");
  const lockedFinal = BigInt(await callView("locked", ALICE_COA));
  const slotFinal = await callView("slotOf", ALICE_COA);
  const aliceCadBalPost = getCadenceBalance(ALICE_FLOW);

  const lockedDecrease = lockedAfterWrap - lockedFinal;
  if (lockedDecrease === total * (10n ** 18n)) {
    ok(`EVM locked decreased by exactly ${total} FLOW`);
  } else {
    fail(`locked decrease ${lockedDecrease} != ${total * (10n ** 18n)}`);
  }

  const slotReset = (slotFinal.C1x === 0n && slotFinal.C1y === 1n && slotFinal.C2x === 0n && slotFinal.C2y === 1n);
  if (slotReset) ok("EVM slot reset to identity");
  else fail("EVM slot NOT reset");

  const cadDelta = aliceCadBalPost - aliceCadBalPre;
  const cadDeltaFlow = Number(cadDelta) / 1e8;
  info(`Alice Cadence pre:  ${(Number(aliceCadBalPre) / 1e8).toFixed(8)} FLOW`);
  info(`Alice Cadence post: ${(Number(aliceCadBalPost) / 1e8).toFixed(8)} FLOW`);
  info(`Alice delta:        ${cadDeltaFlow.toFixed(8)} FLOW`);
  // Alice wrapped 1 FLOW (Cadence vault → router vault), unwrapped 1 FLOW (router vault → alice vault)
  // Net Cadence: ~0 minus gas. EVM side proxies similarly.
  // Gate: delta should be > -1 FLOW (only gas burned, not a full wrap lost).
  if (cadDeltaFlow > -1) {
    ok(`Alice Cadence balance round-trip = ${cadDeltaFlow.toFixed(8)} FLOW (≈ -gas only)`);
  } else {
    fail(`Alice Cadence delta ${cadDeltaFlow.toFixed(8)} FLOW — pre-fix behavior?`);
  }

  results.steps.lockedDelta = lockedDelta.toString();
  results.steps.lockedDecrease = lockedDecrease.toString();
  results.steps.slotReset = slotReset;
  results.steps.cadDeltaFlow = cadDeltaFlow;
  results.failures = failures;
  results.verdict = failures === 0 ? "PASS" : "FAIL";
  results.endedAt = new Date().toISOString();

  writeFileSync(
    join(PROJECT_ROOT, "scripts/test-cadence-wrap-unwrap-results.json"),
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
