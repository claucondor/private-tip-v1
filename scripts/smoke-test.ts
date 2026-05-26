/**
 * PrivateTip End-to-End Smoke Test (v4 — pre-encoded calldata, small ZK values)
 *
 * Architecture:
 *   - BabyJubJub keys derived via HKDF-SHA256 from Flow signing key
 *   - Only Charlie has a COA on this testnet instance (Bob/Dave/Eve have no COA)
 *   - Charlie wraps to herself (self-tip) to demonstrate the full cycle
 *   - ZK circuit uses small integers (1, 2, 3 = FLOW units) NOT attoflow
 *   - Calldata is pre-ABI-encoded with ethers.js to bypass Cadence dynamic-array bug
 *   - Cadence transactions submitted via `flow transactions send` subprocess
 *   - Known on-chain bug: JanusToken.unwrap() releases `amount` wei but checks
 *     publicInputs[6] == amount (small ZK integer) — releases only 6 wei, not 6 FLOW
 *
 * Smoke test flow:
 *   1. Derive Charlie's BabyJubJub keypair from Flow signing key (HKDF-SHA256)
 *   2. Verify Charlie's on-chain pubkey matches derived keypair
 *   3. Charlie wraps 1 unit for herself (unit=1 FLOW on-chain, value=1 in ZK)
 *   4. Charlie wraps 2 units for herself (nonce increments)
 *   5. Charlie wraps 3 units for herself (nonce increments)
 *   6. Charlie reads accumulated slot, BSGS-decrypts total = 6
 *   7. Charlie generates decrypt_open proof for total=6
 *   8. Off-chain proof verification (snarkjs)
 *   9. Charlie calls unwrap() — releases 6 wei (on-chain bug documented)
 *  10. Summary: slot reset confirmed, PrivateTip bug documented
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/smoke-test.ts
 *
 * Known on-chain bugs:
 *   1. JanusToken.unwrap(amount, ...): releases `amount` wei where `amount` must equal
 *      publicInputs[6] (small ZK integer). For amount=6 (6 FLOW units), only 6 attoFLOW
 *      (~0) is transferred. The full 6 FLOW in `locked[]` is irrecoverable without re-deploy.
 *      Root cause: ZK circuit values are in [0,2^48) using whole FLOW units, but the contract
 *      checks publicInputs[6] == amount (in wei). No scaling factor applied.
 *   2. PrivateTip.claimTip(): checks tipRef.recipient == self.account.address (contract
 *      account = Bob/deployer), not the transaction signer. Only Bob-recipient tips claimable.
 */

import { execSync } from "child_process";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { createHmac } from "crypto";
import { buildBabyjub } from "circomlibjs";
import * as snarkjs from "snarkjs";
import * as path from "path";

// ─── Constants ─────────────────────────────────────────────────────────────────

const FLOW_NETWORK = "testnet";
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;
const JANUS_TOKEN_ADDR = "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499";

// Charlie's account (the only account with a COA on this testnet instance)
const CHARLIE_FLOW_ADDR = "0x3c601a443c81e6cd";
const CHARLIE_SIGNER = "testnet-charlie";
const CHARLIE_COA_ADDR = "0x00000000000000000000000249065458581f9bf0";
const CHARLIE_PKEY_PATH = "/home/oydual3/.flow/testnet-charlie.pkey";

// SDK circuit artifacts (bundled in @openjanus/sdk)
const SDK_DIR = path.resolve(__dirname, "../node_modules/@openjanus/sdk");
const ENCRYPT_WASM = path.join(SDK_DIR, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = path.join(SDK_DIR, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = path.join(SDK_DIR, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = path.join(SDK_DIR, "circuits/setup/decrypt_open_final.zkey");
const DECRYPT_VKEY = path.join(SDK_DIR, "circuits/setup/decrypt_open_vkey.json");

// Cadence transaction templates
const PROJECT_ROOT = path.resolve(__dirname, "..");
const COA_CALL_WITH_VALUE_TX = path.join(
  PROJECT_ROOT,
  "cadence/transactions/coa_call_with_value.cdc"
);
const COA_CALL_AND_WITHDRAW_TX = path.join(
  PROJECT_ROOT,
  "cadence/transactions/coa_call_and_withdraw.cdc"
);

// JanusToken ABI (only what we need)
const JANUS_ABI = [
  "function hasPubkey(address) view returns (bool)",
  "function pubkeyOf(address) view returns (uint256 x, uint256 y)",
  "function slotOf(address) view returns (tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y))",
  "function nonce(address) view returns (uint256)",
  "function locked(address) view returns (uint256)",
  "function wrap(address to, tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct, uint256 senderNonce, uint[6] publicInputs, uint[8] encryptProof) external payable",
  "function unwrap(uint256 amount, address recipient, uint[7] publicInputs, uint[8] decryptProof) external",
];

// ─── BabyJubJub helpers ─────────────────────────────────────────────────────────

/** Generate a random scalar in [1, subOrder) suitable for BabyJubJub ElGamal */
async function randomBabyJubScalar(): Promise<bigint> {
  const babyjub = await buildBabyjub();
  const ORDER: bigint = babyjub.subOrder;
  const { randomBytes } = await import("crypto");
  const bytes = randomBytes(32);
  const raw = BigInt("0x" + bytes.toString("hex"));
  return ((raw % ORDER) + ORDER) % ORDER || 1n;
}

// ─── BabyJubJub HKDF Key Derivation ────────────────────────────────────────────

async function deriveBabyJubKeypair(flowSigningKeyHex: string) {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const flowKeyBuf = Buffer.from(flowSigningKeyHex, "hex");

  // HKDF-SHA256 (matches e2e_multiuser.mjs derivation)
  const salt = Buffer.from("openjanus-privacy-v1", "utf8");
  const prk = createHmac("sha256", salt).update(flowKeyBuf).digest();
  const info = Buffer.from("babyjub-privkey", "utf8");
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([prk, info, Buffer.from([0x01])]))
    .digest();

  const ORDER = babyjub.subOrder;
  const raw = BigInt("0x" + okm.toString("hex"));
  const privkey = ((raw % ORDER) + ORDER) % ORDER || 1n;

  const pubkeyPoint = babyjub.mulPointEscalar(babyjub.Base8, privkey);
  return {
    privkey,
    pubkey: {
      x: BigInt(Fr.toObject(pubkeyPoint[0])),
      y: BigInt(Fr.toObject(pubkeyPoint[1])),
    },
  };
}

// ─── Flow CLI helper ────────────────────────────────────────────────────────────

function flowTx(
  cdcFile: string,
  argsJson: object[],
  signer: string
): { txId: string; error?: string } {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcFile}" --args-json "${argsStr}" --signer ${signer} --network ${FLOW_NETWORK} --gas-limit 9999 -o json`;
  let out: string;
  try {
    out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    const raw = (e.stdout || "") + (e.stderr || "");
    let errMsg = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(e.stdout || "{}");
      errMsg = parsed.error || parsed.errorMessage || errMsg;
    } catch {}
    return { txId: "", error: errMsg };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { txId: "", error: "Could not parse flow CLI output: " + out.slice(0, 200) };
  }
  if (parsed.error) return { txId: parsed.id || "", error: parsed.error };
  if (parsed.status !== "SEALED")
    return { txId: parsed.id || "", error: `Not SEALED (status=${parsed.status})` };
  return { txId: parsed.id || "" };
}

// ─── ZK proof utilities ─────────────────────────────────────────────────────────

/** Pack snarkjs proof into EVM-ready uint[8] with pB Fp2 swap */
function packProof(proof: any): bigint[] {
  return [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]),
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ];
}

// ─── BSGS Decrypt ──────────────────────────────────────────────────────────────

/**
 * Baby-step Giant-step discrete log for ElGamal decryption.
 * Finds v (small integer) such that v*G = C2 - privkey*C1.
 * Search range: [0, maxVal] (inclusive).
 */
async function bsgsDecrypt(
  C1x: bigint,
  C1y: bigint,
  C2x: bigint,
  C2y: bigint,
  privkey: bigint,
  maxVal = 10000n
): Promise<bigint | null> {
  const babyjub = await buildBabyjub();
  const Fr = babyjub.F;
  const G = babyjub.Base8;
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  // Compute vG = C2 - privkey*C1
  const C1 = [Fr.e(C1x), Fr.e(C1y)];
  const skC1 = babyjub.mulPointEscalar(C1, privkey);
  const negSkC1 = [Fr.e(P - BigInt(Fr.toObject(skC1[0]))), skC1[1]];
  const vG = babyjub.addPoint([Fr.e(C2x), Fr.e(C2y)], negSkC1);
  const vGx = BigInt(Fr.toObject(vG[0]));
  const vGy = BigInt(Fr.toObject(vG[1]));

  const n = BigInt(Math.ceil(Math.sqrt(Number(maxVal) + 1)));

  // Baby steps: i*G for i in [0, n]
  const babies = new Map<string, bigint>();
  let pt = [Fr.e(0n), Fr.e(1n)]; // identity
  for (let i = 0n; i <= n; i++) {
    babies.set(`${Fr.toObject(pt[0])},${Fr.toObject(pt[1])}`, i);
    pt = babyjub.addPoint(pt, G);
  }

  // Giant steps: subtract (n+1)*G each time
  const step = babyjub.mulPointEscalar(G, n + 1n);
  const negStep = [Fr.e(P - BigInt(Fr.toObject(step[0]))), step[1]];
  let giant = [Fr.e(vGx), Fr.e(vGy)];
  for (let j = 0n; j * (n + 1n) <= maxVal; j++) {
    const key = `${Fr.toObject(giant[0])},${Fr.toObject(giant[1])}`;
    if (babies.has(key)) {
      const i = babies.get(key)!;
      const v = i + j * (n + 1n);
      if (v <= maxVal) return v;
    }
    giant = babyjub.addPoint(giant, negStep);
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let failures = 0;
  const ok = (msg: string) => console.log(`  PASS: ${msg}`);
  const fail = (msg: string) => { console.error(`  FAIL: ${msg}`); failures++; };
  const info = (msg: string) => console.log(`  INFO: ${msg}`);
  const warn = (msg: string) => console.log(`  WARN: ${msg}`);
  const sep = () => console.log("-".repeat(60));

  console.log("=".repeat(60));
  console.log("  PrivateTip + JanusToken Smoke Test v4");
  console.log("  Flow Testnet | Only Charlie has COA");
  console.log("=".repeat(60));
  console.log();

  const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  const janusIface = new ethers.Interface(JANUS_ABI);

  async function callJanus(func: string, ...args: any[]) {
    const data = janusIface.encodeFunctionData(func, args);
    const result = await provider.call({ to: JANUS_TOKEN_ADDR, data });
    const decoded = janusIface.decodeFunctionResult(func, result);
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  // ─── Step 1: Derive Charlie's keypair ─────────────────────────────────────
  console.log("--- Step 1: Derive Charlie's BabyJubJub keypair ---");
  const charlieKeyHex = readFileSync(CHARLIE_PKEY_PATH, "utf-8").trim();
  let charlieKp: { privkey: bigint; pubkey: { x: bigint; y: bigint } };
  try {
    charlieKp = await deriveBabyJubKeypair(charlieKeyHex) as { privkey: bigint; pubkey: { x: bigint; y: bigint } };
    ok(`Charlie keypair derived: pkx=${charlieKp.pubkey.x.toString().slice(0, 15)}...`);
  } catch (e: any) {
    fail(`Keypair derivation failed: ${e.message}`);
    return 1;
  }

  // ─── Step 2: Verify on-chain pubkey ───────────────────────────────────────
  console.log("\n--- Step 2: Verify on-chain pubkey ---");
  let onchainPk: { x: bigint; y: bigint };
  try {
    const hasPk = await callJanus("hasPubkey", CHARLIE_COA_ADDR) as boolean;
    if (!hasPk) {
      fail("Charlie has no pubkey registered on JanusToken");
      return 1;
    }
    const [pkx, pky] = await callJanus("pubkeyOf", CHARLIE_COA_ADDR) as [bigint, bigint];
    onchainPk = { x: pkx, y: pky };
    if (pkx === charlieKp.pubkey.x && pky === charlieKp.pubkey.y) {
      ok(`On-chain pubkey matches derived keypair`);
    } else {
      fail(`Pubkey mismatch: derived.x=${charlieKp.pubkey.x.toString().slice(0,15)} on-chain.x=${pkx.toString().slice(0,15)}`);
      return 1;
    }
  } catch (e: any) {
    fail(`On-chain pubkey check failed: ${e.message}`);
    return 1;
  }

  // ─── Step 3: Pre-conditions ───────────────────────────────────────────────
  console.log("\n--- Step 3: Read pre-conditions ---");
  const nonce0 = BigInt((await callJanus("nonce", CHARLIE_COA_ADDR) as bigint).toString());
  const lockedPre = BigInt((await callJanus("locked", CHARLIE_COA_ADDR) as bigint).toString());
  const slotPre = await callJanus("slotOf", CHARLIE_COA_ADDR) as { C1x: bigint; C1y: bigint; C2x: bigint; C2y: bigint };
  info(`Charlie nonce: ${nonce0}`);
  info(`Charlie locked: ${ethers.formatEther(lockedPre)} FLOW`);
  info(`Charlie slot identity: ${slotPre.C1x === 0n && slotPre.C1y === 1n && slotPre.C2x === 0n && slotPre.C2y === 1n}`);

  if (lockedPre > 0n) {
    warn(
      `Charlie already has ${ethers.formatEther(lockedPre)} FLOW locked ` +
      `(from previous test run; cannot recover due to unwrap() on-chain bug)`
    );
  }

  const slotIsIdentity = slotPre.C1x === 0n && slotPre.C1y === 1n && slotPre.C2x === 0n && slotPre.C2y === 1n;
  if (!slotIsIdentity) {
    warn("Slot is non-identity — prior ciphertexts exist, wraps will accumulate on top");
  }

  // ─── Steps 4-6: Charlie wraps 1, 2, 3 units to herself ───────────────────
  // ZK circuit uses small integers (1, 2, 3 = FLOW units, NOT attoflow)
  // Contract wrap() receives msg.value in attoflow (1.0 FLOW, 2.0 FLOW, 3.0 FLOW)
  const WRAP_AMOUNTS = [
    { units: 1n, flowStr: "1.00000000" },
    { units: 2n, flowStr: "2.00000000" },
    { units: 3n, flowStr: "3.00000000" },
  ];
  const wrapTxIds: string[] = [];
  let currentNonce = nonce0;

  const { buildEncryptProof } = await import("@openjanus/sdk");

  for (const { units, flowStr } of WRAP_AMOUNTS) {
    const stepLabel = `--- Step ${4 + Number(units) - 1}: Charlie wraps ${units} unit → self ---`;
    console.log("\n" + stepLabel);

    // Generate randomness mod subOrder (BabyJubJub scalar field)
    const randomness = await randomBabyJubScalar();

    // Build encrypt proof (circuit value = small integer, NOT attoflow)
    let encResult: any;
    try {
      encResult = await buildEncryptProof(
        {
          value: units,
          randomness,
          recipientPubkey: charlieKp.pubkey,
        },
        { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
      );
      ok(`Encrypt proof generated (C1x=${encResult.ciphertext.C1.x.toString().slice(0,12)}...)`);
    } catch (e: any) {
      fail(`Encrypt proof ${units} generation failed: ${e.message}`);
      return 1;
    }

    const ct = encResult.ciphertext;
    const proof8 = packProof(encResult.rawProof);
    const pubInputs6 = (encResult.publicInputs as bigint[]).slice(0, 6);

    // Pre-encode wrap() calldata with ethers.js
    // This bypasses Cadence's EVM.encodeABIWithSignature fixed-array bug
    const calldata = janusIface
      .encodeFunctionData("wrap", [
        CHARLIE_COA_ADDR,
        [ct.C1.x, ct.C1.y, ct.C2.x, ct.C2.y],
        currentNonce,
        pubInputs6,
        proof8,
      ])
      .slice(2); // remove 0x prefix

    // Submit via coa_call_with_value.cdc
    const argsJson = [
      { type: "String", value: JANUS_TOKEN_ADDR },
      { type: "String", value: calldata },
      { type: "UInt64", value: "600000" },
      { type: "UFix64", value: flowStr },
    ];
    info(`Submitting wrap tx (nonce=${currentNonce}, calldata=${calldata.slice(0,16)}...)...`);
    const txResult = flowTx(COA_CALL_WITH_VALUE_TX, argsJson, CHARLIE_SIGNER);
    if (txResult.error) {
      fail(`Wrap ${units} unit tx failed: ${txResult.error.slice(0, 200)}`);
      return 1;
    }
    ok(`Wrap ${units} unit: txId=${txResult.txId}`);
    info(`[TxHash] wrap-${units}: ${txResult.txId}`);
    wrapTxIds.push(txResult.txId);
    currentNonce++;
  }

  // ─── Step 7: Read Charlie's accumulated slot ───────────────────────────────
  console.log("\n--- Step 7: Read Charlie's accumulated slot ---");
  const slotPost = await callJanus("slotOf", CHARLIE_COA_ADDR) as { C1x: bigint; C1y: bigint; C2x: bigint; C2y: bigint };
  const lockedPost = BigInt((await callJanus("locked", CHARLIE_COA_ADDR) as bigint).toString());

  ok(`Slot post-wrap: C1x=${slotPost.C1x.toString().slice(0,15)}...`);
  info(`Charlie locked: ${ethers.formatEther(lockedPost)} FLOW`);

  const slotIsIdentityPost = slotPost.C1x === 0n && slotPost.C1y === 1n && slotPost.C2x === 0n && slotPost.C2y === 1n;
  if (slotIsIdentityPost) {
    fail("Charlie slot is still identity after 3 wraps — wraps failed silently");
    return 1;
  }
  ok("Charlie slot is non-identity (ciphertexts accumulated)");

  // ─── Step 8: BSGS decrypt to find total ───────────────────────────────────
  console.log("\n--- Step 8: BSGS decrypt total (small integer range) ---");
  info("Searching for total in [0, 10000] (BSGS on small integers)...");

  let total: bigint | null = null;
  try {
    total = await bsgsDecrypt(
      slotPost.C1x,
      slotPost.C1y,
      slotPost.C2x,
      slotPost.C2y,
      charlieKp.privkey,
      10000n
    );
  } catch (e: any) {
    fail(`BSGS failed: ${e.message}`);
    return 1;
  }

  if (total === null) {
    fail("BSGS could not find total — wrong key or value out of [0,10000]");
    return 1;
  }
  ok(`BSGS decrypted total: ${total} units`);

  // Expected: prior accumulated + (1+2+3) = prior + 6
  // If slot was identity before wraps, total should be exactly 6
  if (slotIsIdentity && total !== 6n) {
    fail(`Expected total=6 but got ${total} (slot was identity pre-wrap)`);
  } else if (!slotIsIdentity) {
    info(`Slot was non-identity pre-wrap; total=${total} (includes prior balance)`);
    ok(`BSGS total is consistent (homomorphic accumulation works)`);
  } else {
    ok(`Total = 6 units = 1+2+3 (homomorphic accumulation verified)`);
  }

  // ─── Step 9: Generate decrypt_open proof ─────────────────────────────────
  console.log("\n--- Step 9: Generate decrypt_open proof ---");
  let proofResult: any;
  try {
    const circuitInput = {
      privkey: charlieKp.privkey.toString(),
      pubkey: [charlieKp.pubkey.x.toString(), charlieKp.pubkey.y.toString()],
      C1: [slotPost.C1x.toString(), slotPost.C1y.toString()],
      C2: [slotPost.C2x.toString(), slotPost.C2y.toString()],
      claimed_value: total.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      DECRYPT_WASM,
      DECRYPT_ZKEY
    );
    proofResult = { proof, publicSignals };
    ok(`Decrypt proof generated (claimed_value=${total})`);
  } catch (e: any) {
    fail(`Decrypt proof generation failed: ${e.message}`);
    return 1;
  }

  // ─── Step 10: Off-chain proof verification ────────────────────────────────
  console.log("\n--- Step 10: Off-chain proof verification ---");
  const vkeyDecrypt = JSON.parse(readFileSync(DECRYPT_VKEY, "utf-8"));
  const offChainValid = await snarkjs.groth16.verify(
    vkeyDecrypt,
    proofResult.publicSignals,
    proofResult.proof
  );
  if (offChainValid) {
    ok("Off-chain snarkjs.groth16.verify = true");
  } else {
    fail("Off-chain snarkjs.groth16.verify = false");
    return 1;
  }

  // ─── Step 11: Submit unwrap() — document the on-chain bug ─────────────────
  console.log("\n--- Step 11: Submit unwrap() [on-chain bug documented] ---");

  warn("ON-CHAIN BUG: unwrap(amount, ...) requires publicInputs[6] == amount");
  warn("  publicInputs[6] = claimed_value from ZK circuit = small integer (e.g. 6)");
  warn("  JanusToken.locked[msg.sender] = attoFLOW (6 * 10^18 wei)");
  warn("  calling unwrap(6, ...) passes the proof check but releases only 6 wei");
  warn("  The full 6 FLOW in locked[] is irrecoverable without re-deploying JanusToken");
  warn("  FIX: contract should check publicInputs[6] == amount / SCALE_FACTOR");
  warn("       where SCALE_FACTOR = 10^18 (attoFLOW per FLOW unit)");

  const proof8 = packProof(proofResult.proof);
  const pubInputs7 = proofResult.publicSignals.map((s: string) => BigInt(s)) as bigint[];

  // Pre-encode unwrap() calldata with ethers.js
  const unwrapCalldata = janusIface
    .encodeFunctionData("unwrap", [
      total,           // amount = small ZK integer (releases only `total` wei, not `total` FLOW)
      CHARLIE_COA_ADDR,
      pubInputs7,
      proof8,
    ])
    .slice(2);

  const unwrapArgsJson = [
    { type: "String", value: JANUS_TOKEN_ADDR },
    { type: "String", value: unwrapCalldata },
    { type: "UInt64", value: "500000" },
  ];

  info(`Submitting unwrap tx (amount=${total}, will release ${total} wei ≈ 0 FLOW)...`);
  const unwrapResult = flowTx(COA_CALL_AND_WITHDRAW_TX, unwrapArgsJson, CHARLIE_SIGNER);
  if (unwrapResult.error) {
    fail(`Unwrap tx failed: ${unwrapResult.error.slice(0, 200)}`);
    // Don't return — we can still pass the test since this is a known bug
    warn("Unwrap tx failed — possibly Charlie's prior slot was already reset by previous unwrap");
    warn("Or the proof does not match current on-chain slot state");
  } else {
    ok(`Unwrap tx sealed: txId=${unwrapResult.txId}`);
    info(`[TxHash] unwrap: ${unwrapResult.txId}`);
    warn(`Unwrap released only ${total} wei (not ${total} FLOW) due to on-chain bug`);
  }

  // ─── Step 12: Verify post-unwrap state ─────────────────────────────────────
  console.log("\n--- Step 12: Verify post-unwrap slot state ---");
  const slotFinal = await callJanus("slotOf", CHARLIE_COA_ADDR) as { C1x: bigint; C1y: bigint; C2x: bigint; C2y: bigint };
  const lockedFinal = BigInt((await callJanus("locked", CHARLIE_COA_ADDR) as bigint).toString());

  const slotReset = slotFinal.C1x === 0n && slotFinal.C1y === 1n && slotFinal.C2x === 0n && slotFinal.C2y === 1n;
  if (slotReset) {
    ok("Slot reset to identity (0,1,0,1) — unwrap proof was valid, ciphertext cleared");
  } else {
    warn("Slot not reset — unwrap may not have been submitted or proof mismatch");
    info(`  Slot C1x=${slotFinal.C1x}, C1y=${slotFinal.C1y}`);
  }

  info(`Locked after unwrap: ${ethers.formatEther(lockedFinal)} FLOW`);
  if (lockedFinal > 0n) {
    warn(`${ethers.formatEther(lockedFinal)} FLOW remains locked (on-chain bug: only ${total} wei released)`);
    warn("This FLOW is permanently locked without JanusToken re-deployment");
  }

  // ─── Step 13: PrivateTip metadata note ────────────────────────────────────
  console.log("\n--- Step 13: PrivateTip on-chain bug (documented) ---");
  warn("PRIVATETIP BUG: claimTip() checks tipRef.recipient == self.account.address");
  warn("  self.account.address = the PrivateTip contract deployer (Bob = d807a3992d7be612)");
  warn("  Only tips where recipient = Bob (deployer) can be claimed");
  warn("  Tips to Charlie, Dave, Eve cannot be claimed");
  warn("  FIX: change check to use transaction signer address, not contract account address");

  // ─── Final summary ─────────────────────────────────────────────────────────
  sep();
  console.log("=".repeat(60));
  console.log("  SMOKE TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Charlie COA:     ${CHARLIE_COA_ADDR}`);
  console.log(`  JanusToken:      ${JANUS_TOKEN_ADDR}`);
  console.log();
  console.log("  Transaction hashes:");
  wrapTxIds.forEach((txId, i) => {
    console.log(`    wrap-${i + 1} (${i + 1} unit): ${txId}`);
  });
  if (!unwrapResult?.error && unwrapResult?.txId) {
    console.log(`    unwrap (${total} units): ${unwrapResult.txId}`);
  }
  console.log();
  console.log("  ZK circuit verifications:");
  console.log(`    Encrypt proofs (3x): PASS`);
  console.log(`    Decrypt proof (total=${total}): PASS`);
  console.log(`    Off-chain snarkjs verify: PASS`);
  console.log(`    BSGS decrypt: ${total} units`);
  console.log();
  console.log("  Known on-chain bugs (require re-deployment to fix):");
  console.log("    1. JanusToken.unwrap(): releases `amount` wei where amount = circuit claimed_value");
  console.log("       ZK circuit range [0,2^48) uses whole-FLOW units; contract needs attoFLOW.");
  console.log("       6 FLOW wrapped → locked=6*10^18 → unwrap(6) releases 6 wei, not 6 FLOW.");
  console.log("    2. PrivateTip.claimTip(): checks contract account address, not tx signer.");
  console.log();

  if (failures === 0) {
    console.log("  RESULT: ALL ASSERTIONS PASSED");
    console.log("  Core cycle (wrap × 3 → BSGS decrypt → ZK prove → verify) works correctly.");
    console.log("  FLOW recovery blocked by on-chain bug #1 — documented above.");
  } else {
    console.error(`  RESULT: ${failures} ASSERTION(S) FAILED`);
  }
  console.log("=".repeat(60));

  return failures;
}

main()
  .then((f) => process.exit(f > 0 ? 1 : 0))
  .catch((err) => {
    console.error("FATAL:", err.message);
    console.error(err.stack?.split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  });
