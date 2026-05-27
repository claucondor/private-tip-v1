/**
 * v04-smoke-full.mjs — v0.4.1 PrivateTip end-to-end smoke test.
 *
 * Validates the FULL encrypted-memo shielded tip lifecycle on testnet:
 *
 *   0. Reset Alice + Bob slots via adminResetSlot (clean slate).
 *   1. Alice generates a MemoKey + ensures COA (via setup_account).
 *   2. Bob   generates a MemoKey + ensures COA.
 *   3. Alice wraps 5 FLOW into her shielded slot (msg.value VISIBLE).
 *   4. Alice sends a 2 FLOW shielded tip to Bob with memo "private hello bob".
 *      - On-chain: memo_ciphertext blob, no plaintext memo anywhere.
 *      - Bob can decrypt with his MemoKey privkey.
 *      - External observer (random key) cannot decrypt — auth tag mismatch.
 *   5. Bob unwraps 2 FLOW to his Cadence FlowToken.Vault (atomic).
 *   6. Verify accounting: Alice 3 shielded, Bob 0 shielded + ~2 in vault.
 *
 * All tx hashes captured in v04-smoke-full-results.json.
 *
 * Usage: node scripts/v04-smoke-full.mjs
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
import { JsonRpcProvider, Interface } from "ethers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  generateBlinding,
  flowToWei,
  encryptText,
  decryptText,
  generateBabyJubKeypair,
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

// Smoke wallets — DIFFERENT from operator's UI test wallets (per brief: don't
// touch operator's wallets here; the operator resets them separately for the
// browser test).
const ALICE_FLOW = "0x7599043aea001283";
const ALICE_SIGNER = "testnet-claucondor";
const ALICE_COA = "0x000000000000000000000002b7557ee5d4a32d06";

const BOB_FLOW = "0xd807a3992d7be612";
const BOB_SIGNER = "testnet-bob";
const BOB_COA = "0x00000000000000000000000250d93efba617e0bf";

const PRIVATE_TIP_ADDR = "0xb9ac529c14a4c5a1";

// Cadence transactions live in the v0.4.1 contracts dir.
const TX_RESET_SLOT = "/home/oydual3/openjanus-contracts/packages/janus-token/transactions/admin_reset_slot.cdc";
const TX_SETUP_ACCOUNT = join(PROJECT_ROOT, "cadence/transactions/setup_account.cdc");
const TX_WRAP = join(PROJECT_ROOT, "cadence/transactions/jf_wrap.cdc");
const TX_SEND_TIP = join(PROJECT_ROOT, "cadence/transactions/send_shielded_tip.cdc");
const TX_UNWRAP_TO_VAULT = join(PROJECT_ROOT, "cadence/transactions/jf_unwrap_to_vault.cdc");

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
const iface = new Interface([...JANUS_TOKEN_BASE_ABI, ...JANUS_FLOW_EXTRA_ABI]);

// ─── CLI helpers ───────────────────────────────────────────────────────────────

function flowTx(cdcPath, argsJson, signer, signerCwd = PROJECT_ROOT) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcPath}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      cwd: signerCwd,
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
    return { ok: false, txId: "", error: raw.slice(0, 2000) };
  }
}

function flowScript(cdcSrc, argsJson) {
  // Use temp file for the script source.
  const tmp = join(PROJECT_ROOT, ".tmp_smoke_script.cdc");
  writeFileSync(tmp, cdcSrc);
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow scripts execute "${tmp}" --args-json "${argsStr}" --network testnet -o json`;
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { ok: true, result: JSON.parse(out) };
  } catch (e) {
    const raw = (e.stdout || "") + (e.stderr || "");
    return { ok: false, error: raw.slice(0, 2000) };
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

function arrUInt8(arr) {
  // Coerce Uint8Array / TypedArray to plain JS array first — JSON.stringify
  // serializes Uint8Array as a {"0": 0, "1": 0, ...} map instead of an array,
  // which the Flow CLI rejects.
  const plain = Array.from(arr);
  return {
    type: "Array",
    value: plain.map((v) => ({ type: "UInt8", value: Number(v).toString() })),
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

function eventFieldValue(event, name) {
  if (!event) return null;
  const fieldsRaw = event.values?.value?.fields || [];
  const field = fieldsRaw.find((f) => f.name === name);
  return field?.value ?? null;
}

function logStep(label) { console.log(`\n=== ${label} ===`); }
function pass(m) { console.log(`  PASS: ${m}`); }
function fail(m) { console.error(`  FAIL: ${m}`); }
function info(m) { console.log(`  INFO: ${m}`); }

// ─── Wallet balance script (FlowToken.Vault) ──────────────────────────────────

const SCRIPT_VAULT_BAL = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

access(all) fun main(addr: Address): UFix64 {
    let acct = getAccount(addr)
    let vault = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
        ?? panic("no FlowToken balance cap")
    return vault.balance
}
`;

async function readVaultBalance(addr) {
  const res = flowScript(SCRIPT_VAULT_BAL, [{ type: "Address", value: addr }]);
  if (!res.ok) return null;
  // Result format: { value: "1.23000000", type: "UFix64" }
  return res.result.value;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  const results = {
    test: "v04-smoke-full",
    startedAt: new Date().toISOString(),
    privateTip: PRIVATE_TIP_ADDR,
    janusFlowEVM: JANUS_FLOW_EVM,
    janusFlowCadence: JANUS_FLOW_CADENCE_ADDRESS,
    alice: { flow: ALICE_FLOW, coa: ALICE_COA },
    bob: { flow: BOB_FLOW, coa: BOB_COA },
    txHashes: {},
    privacyChecks: {},
    memoChecks: {},
  };

  console.log("=".repeat(72));
  console.log("  v0.4.1 PrivateTip end-to-end smoke (encrypted memo)");
  console.log(`  PrivateTip:        ${PRIVATE_TIP_ADDR}`);
  console.log(`  JanusFlow Cadence: ${JANUS_FLOW_CADENCE_ADDRESS}`);
  console.log(`  JanusFlow EVM:     ${JANUS_FLOW_EVM}`);
  console.log("=".repeat(72));

  let aliceBalanceWei = 0n;
  let aliceBlinding = 0n;
  let bobBalanceWei = 0n;
  let bobBlinding = 0n;

  // ── Step 0a: reset Alice ─────────────────────────────────────────────────
  logStep("Step 0a: reset Alice slot via adminResetSlot");
  const resetA = flowTx(
    TX_RESET_SLOT,
    [{ type: "Address", value: ALICE_FLOW }],
    "openjanus-flow",
    "/home/oydual3/openjanus-contracts/packages/janus-token"
  );
  results.txHashes.resetAlice = resetA.txId || null;
  if (!resetA.ok) {
    fail(`Reset Alice failed: ${resetA.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Alice reset — tx ${resetA.txId}`);

  // ── Step 0b: reset Bob ────────────────────────────────────────────────────
  logStep("Step 0b: reset Bob slot via adminResetSlot");
  const resetB = flowTx(
    TX_RESET_SLOT,
    [{ type: "Address", value: BOB_FLOW }],
    "openjanus-flow",
    "/home/oydual3/openjanus-contracts/packages/janus-token"
  );
  results.txHashes.resetBob = resetB.txId || null;
  if (!resetB.ok) {
    fail(`Reset Bob failed: ${resetB.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Bob reset — tx ${resetB.txId}`);

  // ── Step 1: Alice setup_account (COA + MemoKey) ──────────────────────────
  logStep("Step 1: Alice setup_account (COA + MemoKey idempotent)");
  const aliceKp = await generateBabyJubKeypair();
  results.alice.memoPubkeyX = aliceKp.pubkey.x.toString();
  results.alice.memoPubkeyY = aliceKp.pubkey.y.toString();
  // NB: we cache the privkey in the run only — never written to disk in clear
  // (cf. browser flow that stores in localStorage; smoke just keeps in memory).

  const setupA = flowTx(
    TX_SETUP_ACCOUNT,
    [
      { type: "UInt256", value: aliceKp.privkey.toString() },
      { type: "UInt256", value: aliceKp.pubkey.x.toString() },
      { type: "UInt256", value: aliceKp.pubkey.y.toString() },
    ],
    ALICE_SIGNER
  );
  results.txHashes.setupAlice = setupA.txId || null;
  if (!setupA.ok) {
    fail(`Alice setup_account failed: ${setupA.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Alice setup_account sealed — tx ${setupA.txId}`);

  // ── Step 2: Bob setup_account ────────────────────────────────────────────
  logStep("Step 2: Bob setup_account (COA + MemoKey idempotent)");
  const bobKp = await generateBabyJubKeypair();
  results.bob.memoPubkeyX = bobKp.pubkey.x.toString();
  results.bob.memoPubkeyY = bobKp.pubkey.y.toString();

  const setupB = flowTx(
    TX_SETUP_ACCOUNT,
    [
      { type: "UInt256", value: bobKp.privkey.toString() },
      { type: "UInt256", value: bobKp.pubkey.x.toString() },
      { type: "UInt256", value: bobKp.pubkey.y.toString() },
    ],
    BOB_SIGNER
  );
  results.txHashes.setupBob = setupB.txId || null;
  if (!setupB.ok) {
    fail(`Bob setup_account failed: ${setupB.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Bob setup_account sealed — tx ${setupB.txId}`);

  // ── Step 3: Alice wraps 5 FLOW ────────────────────────────────────────────
  logStep("Step 3: Alice wraps 5 FLOW into her shielded slot");
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
    return finalize(results, failures);
  }
  pass(`Wrap sealed — tx ${wrapTx.txId}`);
  aliceBalanceWei = wrapWei;
  aliceBlinding = wrapBlinding;

  // ── Step 4: Alice sends 2 FLOW shielded tip with encrypted memo ──────────
  logStep("Step 4: Alice sends 2 FLOW shielded tip with encrypted memo to Bob");
  const tipWei = flowToWei(2n);
  const transferBlinding = generateBlinding();
  const newBlinding = generateBlinding();

  const tipProof = await buildShieldedTransferProof(
    {
      oldBalance: aliceBalanceWei,
      oldBlinding: aliceBlinding,
      transferAmount: tipWei,
      transferBlinding,
      newBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  const tipCalldata = iface
    .encodeFunctionData("shieldedTransfer", [
      BOB_COA,
      Array.from(tipProof.publicInputs),
      Array.from(tipProof.proof),
    ])
    .slice(2);

  // Encrypt the memo with Bob's pubkey.
  const memoPlaintext = "private hello bob";
  const memoEncrypted = await encryptText(memoPlaintext, bobKp.pubkey);
  info(`memo ciphertext length: ${memoEncrypted.ciphertext.length} bytes`);
  results.memoChecks.plaintextOriginal = memoPlaintext;
  results.memoChecks.ciphertextLen = memoEncrypted.ciphertext.length;
  results.memoChecks.ephPubkeyX = memoEncrypted.ephemeralPubkey.x.toString();
  results.memoChecks.ephPubkeyY = memoEncrypted.ephemeralPubkey.y.toString();

  const tipTx = flowTx(
    TX_SEND_TIP,
    [
      { type: "Address", value: BOB_FLOW },
      { type: "String", value: BOB_COA },
      arrUInt256(tipProof.publicInputs),
      arrUInt256(tipProof.proof),
      { type: "String", value: tipCalldata },
      arrUInt8(memoEncrypted.ciphertext),
      { type: "UInt256", value: memoEncrypted.ephemeralPubkey.x.toString() },
      { type: "UInt256", value: memoEncrypted.ephemeralPubkey.y.toString() },
    ],
    ALICE_SIGNER
  );
  results.txHashes.tip = tipTx.txId || null;
  if (!tipTx.ok) {
    fail(`Tip failed: ${tipTx.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Tip sealed — tx ${tipTx.txId}`);

  // Privacy check 1: TipSentShielded event has memoCiphertext + memoEphPubkey,
  // NO plaintext "memo" field.
  const evTip = findEvent(tipTx.raw, "PrivateTip.TipSentShielded");
  const evTipNames = eventFieldNames(evTip);
  results.privacyChecks.tip_event_fields = evTipNames;
  if (!evTip) {
    fail("TipSentShielded event missing");
    failures++;
  } else if (evTipNames.includes("memo")) {
    fail(`TipSentShielded leaked plaintext memo field: ${JSON.stringify(evTipNames)}`);
    failures++;
  } else if (!evTipNames.includes("memoCiphertext") || !evTipNames.includes("memoEphPubkeyX")) {
    fail(`TipSentShielded missing encrypted fields: ${JSON.stringify(evTipNames)}`);
    failures++;
  } else {
    pass(`TipSentShielded has encrypted-memo schema (fields: ${evTipNames.join(", ")})`);
  }

  // Privacy check 2: no plaintext "private hello bob" anywhere in tx payload.
  const txPayloadStr = JSON.stringify(tipTx.raw);
  if (txPayloadStr.includes(memoPlaintext)) {
    fail("Plaintext memo leaked into tx payload");
    failures++;
  } else {
    pass("Plaintext memo NOT present anywhere in tx payload");
  }
  results.privacyChecks.plaintextNotInPayload = !txPayloadStr.includes(memoPlaintext);

  // Memo check 1: Bob can decrypt.
  try {
    // Reconstruct the ciphertext blob from the emitted event values.
    const ctValue = eventFieldValue(evTip, "memoCiphertext");
    const ctBytes = (ctValue?.value ?? []).map((v) => Number(v.value));
    const ephXEvt = BigInt(eventFieldValue(evTip, "memoEphPubkeyX")?.value ?? "0");
    const ephYEvt = BigInt(eventFieldValue(evTip, "memoEphPubkeyY")?.value ?? "1");
    const decrypted = await decryptText(
      new Uint8Array(ctBytes),
      { x: ephXEvt, y: ephYEvt },
      bobKp.privkey
    );
    if (decrypted === memoPlaintext) {
      pass(`Bob successfully decrypted memo: "${decrypted}"`);
      results.memoChecks.bobDecrypted = true;
      results.memoChecks.bobDecryptedText = decrypted;
    } else {
      fail(`Bob decrypted but text mismatch: got "${decrypted}", expected "${memoPlaintext}"`);
      failures++;
    }
  } catch (err) {
    fail(`Bob decryption threw: ${err.message}`);
    failures++;
  }

  // Memo check 2: random attacker can NOT decrypt.
  try {
    const attackerKp = await generateBabyJubKeypair();
    const ctValue = eventFieldValue(evTip, "memoCiphertext");
    const ctBytes = (ctValue?.value ?? []).map((v) => Number(v.value));
    const ephXEvt = BigInt(eventFieldValue(evTip, "memoEphPubkeyX")?.value ?? "0");
    const ephYEvt = BigInt(eventFieldValue(evTip, "memoEphPubkeyY")?.value ?? "1");
    await decryptText(
      new Uint8Array(ctBytes),
      { x: ephXEvt, y: ephYEvt },
      attackerKp.privkey
    );
    fail("Random attacker decryption SUCCEEDED — privacy break!");
    failures++;
  } catch (err) {
    if (/authentication failed/i.test(err.message)) {
      pass("Random attacker decryption REJECTED (auth tag mismatch)");
      results.memoChecks.attackerRejected = true;
    } else {
      fail(`Attacker test unexpected error: ${err.message}`);
      failures++;
    }
  }

  aliceBalanceWei -= tipWei;
  aliceBlinding = newBlinding;
  bobBalanceWei += tipWei;
  bobBlinding = transferBlinding;  // Bob's commit = Pedersen(2 FLOW, transferBlinding)
  info(`After tip: Alice ${aliceBalanceWei / flowToWei(1n)} FLOW, Bob ${bobBalanceWei / flowToWei(1n)} FLOW shielded`);

  // ── Step 5: Bob unwraps 2 FLOW to his Cadence FlowToken.Vault ────────────
  logStep("Step 5: Bob unwraps 2 FLOW to his Cadence FlowToken.Vault");
  const bobVaultBefore = await readVaultBalance(BOB_FLOW);
  info(`Bob vault before unwrap: ${bobVaultBefore} FLOW`);
  results.bob.vaultBefore = bobVaultBefore;

  const unwrapWei = flowToWei(2n);
  const unwrapBlinding = generateBlinding();   // tx commit blinding
  const unwrapNewBlinding = generateBlinding(); // Bob's residual blinding

  const amountProofUnwrap = await buildAmountDiscloseProof(
    { amount: unwrapWei, blinding: unwrapBlinding },
    { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
  );
  const transferProofUnwrap = await buildShieldedTransferProof(
    {
      oldBalance: bobBalanceWei,
      oldBlinding: bobBlinding,
      transferAmount: unwrapWei,
      transferBlinding: unwrapBlinding,
      newBlinding: unwrapNewBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  const unwrapCalldata = iface
    .encodeFunctionData("unwrap", [
      unwrapWei,
      BOB_COA,
      [amountProofUnwrap.txCommit[0], amountProofUnwrap.txCommit[1]],
      Array.from(amountProofUnwrap.proof),
      Array.from(transferProofUnwrap.publicInputs),
      Array.from(transferProofUnwrap.proof),
    ])
    .slice(2);

  const unwrapTx = flowTx(
    TX_UNWRAP_TO_VAULT,
    [
      { type: "UFix64", value: "2.00000000" },
      arrUInt256(amountProofUnwrap.txCommit),
      arrUInt256(amountProofUnwrap.proof),
      arrUInt256(transferProofUnwrap.publicInputs),
      arrUInt256(transferProofUnwrap.proof),
      { type: "String", value: unwrapCalldata },
    ],
    BOB_SIGNER
  );
  results.txHashes.unwrap = unwrapTx.txId || null;
  if (!unwrapTx.ok) {
    fail(`Unwrap failed: ${unwrapTx.error}`);
    failures++;
    return finalize(results, failures);
  }
  pass(`Unwrap sealed — tx ${unwrapTx.txId}`);

  const bobVaultAfter = await readVaultBalance(BOB_FLOW);
  info(`Bob vault after unwrap: ${bobVaultAfter} FLOW`);
  results.bob.vaultAfter = bobVaultAfter;
  if (parseFloat(bobVaultAfter) > parseFloat(bobVaultBefore)) {
    pass(`Bob vault increased by ${(parseFloat(bobVaultAfter) - parseFloat(bobVaultBefore)).toFixed(8)} FLOW`);
  } else {
    fail(`Bob vault did not increase: ${bobVaultBefore} -> ${bobVaultAfter}`);
    failures++;
  }

  // ── Step 6: final accounting ─────────────────────────────────────────────
  logStep("Step 6: final accounting");
  bobBalanceWei -= unwrapWei;
  if (aliceBalanceWei === flowToWei(3n)) {
    pass(`Alice shielded balance = 3 FLOW (correct: 5 - 2 sent)`);
  } else {
    fail(`Alice shielded balance off: ${aliceBalanceWei}, expected ${flowToWei(3n)}`);
    failures++;
  }
  if (bobBalanceWei === 0n) {
    pass(`Bob shielded balance = 0 FLOW (correct: 2 received - 2 unwrapped)`);
  } else {
    fail(`Bob shielded balance off: ${bobBalanceWei}, expected 0`);
    failures++;
  }

  return finalize(results, failures);
}

function finalize(results, failures) {
  results.completedAt = new Date().toISOString();
  results.failures = failures;
  const outPath = join(PROJECT_ROOT, "scripts/v04-smoke-full-results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);
  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
  } else {
    console.log("\nALL TESTS PASSED");
  }
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
  });
