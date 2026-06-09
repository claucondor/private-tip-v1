/**
 * v0_5_2-recovery-smoke.mjs — Recovery flow end-to-end validation (v0.5.2).
 *
 * Tests the full snapshot-based state recovery flow on Flow testnet:
 *
 *   1. Alice publishes MemoKey via setup_memo_key.cdc (idempotent).
 *   2. Alice wraps 5 FLOW with snapshot emitted (post-wrap: 5 FLOW, blinding_1).
 *   3. Alice sends 1 FLOW to Bob with snapshot emitted (post-send residual:
 *      4 FLOW, blinding_2).
 *   4. Device-switch simulation: derive fresh MemoKey from same material
 *      (sign-derive replay), ignore any in-memory state from steps 2-3.
 *   5. Recover via SDK:
 *      - scanJanusFlowSnapshots(aliceCoaEvm, provider)
 *      - decryptSnapshot for each raw blob
 *      - readJanusFlowCommitment(aliceCoaEvm, provider)
 *      - reconstructFromSnapshots({ snapshots, incomingDeltas: [], onChainCommit })
 *   6. Assert: recovered balance = 4 FLOW in wei, Pedersen validation passes.
 *   7. Unwrap using recovered state — proves the recovered blinding is correct.
 *   8. Print summary with tx hashes and timing.
 *
 * If recovery.reconstructFromSnapshots throws RecoveryDesyncError, that is a
 * real v0.5.2 bug — the error message is captured and the script reports FAIL.
 *
 * Usage: node scripts/v0_5_2-recovery-smoke.mjs
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { JsonRpcProvider, Interface } from "ethers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  generateBlinding,
  flowToWei,
  generateBabyJubKeypair,
} from "@openjanus/sdk/crypto";
import {
  JANUS_FLOW_EVM_ADDRESS,
  buildWrapCalldata,
  buildShieldedTransferCalldata,
  buildUnwrapCalldata,
} from "@openjanus/sdk/tokens";
import { recovery } from "@openjanus/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ─── Constants ────────────────────────────────────────────────────────────────

const RPC_URL = "https://testnet.evm.nodes.onflow.org";
const CHAIN_ID = 545;

const ALICE_FLOW = "0x7599043aea001283";
const ALICE_SIGNER = "testnet-claucondor";
const ALICE_COA = "0x000000000000000000000002b7557ee5d4a32d06";

const BOB_COA = "0x00000000000000000000000250d93efba617e0bf";

const TX_RESET_SLOT = "/home/oydual3/openjanus-contracts/packages/janus-token/transactions/admin_reset_slot.cdc";
const TX_SETUP_MEMO_KEY = join(PROJECT_ROOT, "cadence/transactions/setup_memo_key.cdc");
const TX_WRAP = join(PROJECT_ROOT, "cadence/transactions/jf_wrap.cdc");
const TX_SEND_TIP = join(PROJECT_ROOT, "cadence/transactions/send_shielded_tip.cdc");
const TX_UNWRAP_TO_VAULT = join(PROJECT_ROOT, "cadence/transactions/jf_unwrap_to_vault.cdc");

// v0.5.1 circuits — 128-bit range, matches on-chain verifiers.
const SDK_DIR = join(PROJECT_ROOT, "node_modules/@openjanus/sdk/circuits/v0.5.1");
const AMOUNT_WASM = join(SDK_DIR, "amount_disclose.wasm");
const AMOUNT_ZKEY = join(SDK_DIR, "amount_disclose_final.zkey");
const TRANSFER_WASM = join(SDK_DIR, "confidential_transfer.wasm");
const TRANSFER_ZKEY = join(SDK_DIR, "confidential_transfer_final.zkey");

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    return { ok: false, txId: "", error: raw.slice(0, 2000) };
  }
}

// flowTxCwd: same as flowTx but with explicit working directory.
function flowTxCwd(cdcPath, argsJson, signer, cwd) {
  const argsStr = JSON.stringify(argsJson).replace(/"/g, '\\"');
  const cmd = `flow transactions send "${cdcPath}" --args-json "${argsStr}" --signer ${signer} --network testnet --gas-limit 9999 -o json`;
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      cwd,
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

function arrUInt256(arr) {
  return {
    type: "Array",
    value: arr.map((v) => ({ type: "UInt256", value: BigInt(v).toString() })),
  };
}

function arrUInt8(arr) {
  const plain = Array.from(arr);
  return {
    type: "Array",
    value: plain.map((v) => ({ type: "UInt8", value: Number(v).toString() })),
  };
}

function logStep(label) { console.log(`\n=== ${label} ===`); }
function pass(m) { console.log(`  PASS: ${m}`); }
function fail(m) { console.error(`  FAIL: ${m}`); }
function info(m) { console.log(`  INFO: ${m}`); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  let failures = 0;
  let assertionsPassed = 0;
  const txHashes = {};
  const details = [];

  console.log("=".repeat(72));
  console.log("  v0.5.2 Recovery Smoke — end-to-end snapshot recovery validation");
  console.log(`  Alice: ${ALICE_FLOW} / ${ALICE_COA}`);
  console.log(`  JanusFlow proxy: ${JANUS_FLOW_EVM_ADDRESS}`);
  console.log("=".repeat(72));

  // ── Step 0: Reset Alice's slot (clean slate for predictable balance) ──────
  logStep("Step 0: Reset Alice's EVM slot via adminResetSlot");
  const resetTx = flowTxCwd(
    TX_RESET_SLOT,
    [{ type: "Address", value: ALICE_FLOW }],
    "openjanus-flow",
    "/home/oydual3/openjanus-contracts/packages/janus-token"
  );
  txHashes.resetSlot = resetTx.txId || null;
  if (!resetTx.ok) {
    fail(`adminResetSlot failed: ${resetTx.error.slice(0, 300)}`);
    failures++;
    details.push(`resetSlot FAIL: ${resetTx.error.slice(0, 200)}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }
  pass(`Alice slot reset — tx ${resetTx.txId}`);
  assertionsPassed++;
  details.push(`resetSlot OK: ${resetTx.txId}`);

  // ── Step 1: Alice publishes MemoKey (idempotent) ──────────────────────────
  logStep("Step 1: Alice publishes MemoKey via setup_memo_key.cdc");
  const aliceKp = await generateBabyJubKeypair();
  info(`Alice BabyJub pubkey X: ${aliceKp.pubkey.x.toString().slice(0, 20)}...`);

  const setupTx = flowTx(
    TX_SETUP_MEMO_KEY,
    [
      { type: "UInt256", value: aliceKp.pubkey.x.toString() },
      { type: "UInt256", value: aliceKp.pubkey.y.toString() },
    ],
    ALICE_SIGNER
  );
  txHashes.setupMemoKey = setupTx.txId || null;
  // NOTE: setup_memo_key.cdc may fail if the account already has a PrivateTip.MemoKey
  // resource at the path (type mismatch with JanusFlow.MemoKey — migration gap in v0.5.2).
  // We treat this as a known warning rather than a hard fail — the EVM pubkey can still
  // be read from memoKeyPubX/Y if it was published in a prior session.
  const setupFailed = !setupTx.ok;
  if (setupFailed) {
    const errMsg = setupTx.error.slice(0, 300);
    if (errMsg.includes("stored value type mismatch") && errMsg.includes("PrivateTip.MemoKey")) {
      info(`setup_memo_key: PrivateTip.MemoKey type mismatch at storage path.`);
      info(`KNOWN ISSUE: account has old PrivateTip.MemoKey, needs migration to JanusFlow.MemoKey.`);
      info(`Continuing — EVM publishMemoKey may have run in a prior session.`);
      details.push("setup_memo_key: PrivateTip.MemoKey type mismatch (known migration gap)");
    } else {
      fail(`setup_memo_key failed unexpectedly: ${errMsg}`);
      failures++;
      details.push(`setup_memo_key FAIL: ${errMsg}`);
    }
  } else {
    pass(`setup_memo_key sealed — tx ${setupTx.txId}`);
    assertionsPassed++;
    details.push(`setup_memo_key OK: ${setupTx.txId}`);
  }

  // Verify the pubkey was registered on-chain via EVM read.
  // If setup failed, we use the on-chain pubkey for snapshot encrypt so we
  // can still run the recovery flow against existing snapshots from this session.
  let memoKeyForEncrypt = aliceKp.pubkey;
  try {
    const memoKeyIface = new Interface([
      "function memoKeyPubX(address) view returns (uint256)",
      "function memoKeyPubY(address) view returns (uint256)",
    ]);
    const xData = memoKeyIface.encodeFunctionData("memoKeyPubX", [ALICE_COA]);
    const yData = memoKeyIface.encodeFunctionData("memoKeyPubY", [ALICE_COA]);
    const [xResult, yResult] = await Promise.all([
      provider.call({ to: JANUS_FLOW_EVM_ADDRESS, data: xData }),
      provider.call({ to: JANUS_FLOW_EVM_ADDRESS, data: yData }),
    ]);
    const [onChainX] = memoKeyIface.decodeFunctionResult("memoKeyPubX", xResult);
    const [onChainY] = memoKeyIface.decodeFunctionResult("memoKeyPubY", yResult);
    const onChainXBig = BigInt(onChainX);
    const onChainYBig = BigInt(onChainY);
    if (onChainXBig === 0n && onChainYBig === 0n) {
      info("EVM memoKeyPubX/Y is (0,0) — no pubkey registered on EVM yet.");
      info("Snapshots will be encrypted to the freshly generated keypair.");
      info("Recovery will only work if the same privkey is used to decrypt.");
    } else if (onChainXBig === aliceKp.pubkey.x && onChainYBig === aliceKp.pubkey.y) {
      pass("On-chain MemoKey pubkey matches this session's generated pubkey");
      assertionsPassed++;
    } else {
      // On-chain pubkey differs from this session's keypair (prior session or prior setup_account).
      // For accurate recovery testing, encrypt snapshots to the on-chain pubkey and use the
      // locally-held privkey to decrypt. Since this is a fresh keypair each run, we cannot
      // decrypt snapshots encrypted to a different on-chain pubkey.
      // Solution: use the fresh keypair for this run's snapshots. Recovery will work for
      // snapshots emitted in THIS run (encrypted to aliceKp.pubkey).
      info(`On-chain pubkey differs from this session (prior key). Using this session's keypair for wrap/send snapshots.`);
      info(`Recovery will only work for snapshots emitted in this run.`);
    }
    memoKeyForEncrypt = aliceKp.pubkey; // always use session key for this run's snapshots
  } catch (err) {
    info(`EVM MemoKey read warning: ${err.message}`);
  }

  // ── Step 2: Alice wraps 5 FLOW with snapshot ──────────────────────────────
  logStep("Step 2: Alice wraps 5 FLOW (with WrapWithSnapshot event)");
  const wrapAmountWei = flowToWei(5n);
  const blinding1 = generateBlinding();
  info(`blinding_1 = ${blinding1.toString().slice(0, 20)}...`);

  const wrapProof = await buildAmountDiscloseProof(
    { amount: wrapAmountWei, blinding: blinding1 },
    { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
  );
  const wrapSnapshot = await recovery.encryptSnapshotToSelf(
    { balance: wrapAmountWei, blinding: blinding1 },
    memoKeyForEncrypt
  );
  info(`Wrap snapshot ciphertext: ${wrapSnapshot.ciphertext.length} bytes`);

  const wrapCalldata = await buildWrapCalldata(
    wrapProof.txCommit,
    wrapProof.proof,
    wrapSnapshot.ciphertext,
    wrapSnapshot.ephPubkey.x,
    wrapSnapshot.ephPubkey.y
  );

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
  txHashes.wrap = wrapTx.txId || null;
  if (!wrapTx.ok) {
    fail(`Wrap failed: ${wrapTx.error.slice(0, 500)}`);
    failures++;
    details.push(`wrap FAIL: ${wrapTx.error.slice(0, 300)}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }
  pass(`Wrap sealed — tx ${wrapTx.txId}`);
  assertionsPassed++;
  details.push(`wrap OK: ${wrapTx.txId}`);

  // ── Step 3: Alice sends 1 FLOW to Bob (with snapshot for residual) ────────
  logStep("Step 3: Alice sends 1 FLOW to Bob (with ShieldedTransferWithSnapshot)");
  const sendAmountWei = flowToWei(1n);
  const blinding2 = generateBlinding();     // Alice's new residual blinding
  const transferBlinding = generateBlinding(); // blinding for the tx commitment

  const sendProof = await buildShieldedTransferProof(
    {
      oldBalance: wrapAmountWei,
      oldBlinding: blinding1,
      transferAmount: sendAmountWei,
      transferBlinding,
      newBlinding: blinding2,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );
  info(`blinding_2 = ${blinding2.toString().slice(0, 20)}...`);

  // Alice's residual after send: 4 FLOW, blinding_2.
  const aliceResidualWei = wrapAmountWei - sendAmountWei; // 4 FLOW
  const sendSnapshot = await recovery.encryptSnapshotToSelf(
    { balance: aliceResidualWei, blinding: blinding2 },
    memoKeyForEncrypt
  );
  info(`Send snapshot ciphertext: ${sendSnapshot.ciphertext.length} bytes`);

  // Build calldata using buildShieldedTransferCalldata with snapshot params.
  const sendCalldata = await buildShieldedTransferCalldata(
    BOB_COA,
    sendProof.publicInputs,
    sendProof.proof,
    sendSnapshot.ciphertext,
    sendSnapshot.ephPubkey.x,
    sendSnapshot.ephPubkey.y
  );

  // NOTE: send_shielded_tip.cdc takes the memo blob separately (PrivateTip
  // sends the memo as a Cadence-native field). Use a dummy memo since this
  // test focuses on snapshot recovery, not PrivateTip memo semantics.
  const { encryptText } = await import("@openjanus/sdk/crypto");
  const bobKpDummy = await generateBabyJubKeypair();
  const dummyMemo = await encryptText("recovery-smoke-v052", bobKpDummy.pubkey);

  const sendTx = flowTx(
    TX_SEND_TIP,
    [
      // Bob's Flow address and COA — PrivateTip.send_shielded_tip args
      { type: "Address", value: "0xd807a3992d7be612" }, // Bob flow addr
      { type: "String", value: BOB_COA },
      arrUInt256(sendProof.publicInputs),
      arrUInt256(sendProof.proof),
      { type: "String", value: sendCalldata },
      arrUInt8(dummyMemo.ciphertext),
      { type: "UInt256", value: dummyMemo.ephemeralPubkey.x.toString() },
      { type: "UInt256", value: dummyMemo.ephemeralPubkey.y.toString() },
    ],
    ALICE_SIGNER
  );
  txHashes.send = sendTx.txId || null;
  if (!sendTx.ok) {
    fail(`Send failed: ${sendTx.error.slice(0, 500)}`);
    failures++;
    details.push(`send FAIL: ${sendTx.error.slice(0, 300)}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }
  pass(`Send sealed — tx ${sendTx.txId}`);
  assertionsPassed++;
  details.push(`send OK: ${sendTx.txId}`);

  // ── Step 4: Simulate device switch ────────────────────────────────────────
  logStep("Step 4: Device switch simulation");
  info("Generating fresh MemoKey from same keypair (sign-derive replay)...");
  // In a real app, the user would sign "openjanus-memo-key-v1" with their
  // Flow key and HKDF-derive the privkey. Here we just use the same keypair
  // object (same privkey material). This simulates successful sign-derive replay.
  const aliceKpRecovered = { ...aliceKp }; // Same privkey
  // Discard any local state that would have come from "localStorage".
  let recoveredBalance = null;
  let recoveredBlinding = null;
  info("Local state discarded — recovering purely from on-chain snapshots.");

  // ── Step 5: Recovery via SDK ──────────────────────────────────────────────
  logStep("Step 5: Recover shielded state from on-chain snapshot events");

  // 5a. Scan for snapshot events.
  // Flow EVM testnet limits eth_getLogs to 10,000 block range. Use a
  // 9,000-block window starting ~9,500 blocks before the current block
  // (conservative — gives enough headroom for this session's txs which
  // all land within the last ~1,000 blocks).
  info("Scanning for WrapWithSnapshot / ShieldedTransferWithSnapshot events...");
  let rawSnapshots;
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 9000);
    info(`Scanning blocks ${fromBlock} to latest (current=${currentBlock})`);
    rawSnapshots = await recovery.scanJanusFlowSnapshots(ALICE_COA, provider, { fromBlock });
    info(`Found ${rawSnapshots.length} raw snapshot event(s) for Alice`);
    for (const r of rawSnapshots) {
      info(`  block=${r.blockNumber} txHash=${r.txHash.slice(0, 20)}... cipherLen=${r.ciphertext.length}B`);
    }
  } catch (err) {
    fail(`scanJanusFlowSnapshots threw: ${err.message}`);
    failures++;
    details.push(`scan FAIL: ${err.message}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }

  if (rawSnapshots.length === 0) {
    fail("No snapshot events found — either events were not emitted or scan fromBlock is wrong");
    failures++;
    details.push("scan found 0 events");
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }
  assertionsPassed++;

  // 5b. Decrypt each snapshot with Alice's memo privkey.
  const decryptedSnapshots = [];
  for (const raw of rawSnapshots) {
    try {
      const decoded = await recovery.decryptSnapshot(
        raw.ciphertext,
        raw.ephPubkey,
        aliceKpRecovered.privkey
      );
      if (decoded) {
        decryptedSnapshots.push({
          balance: decoded.balance,
          blinding: decoded.blinding,
          timestamp: raw.timestamp,
          txHash: raw.txHash,
        });
        info(`  Decrypted: balance=${decoded.balance / flowToWei(1n)} FLOW block=${raw.timestamp}`);
      } else {
        info(`  Block ${raw.blockNumber}: decryptSnapshot returned null (wrong key or unrelated event)`);
      }
    } catch (err) {
      info(`  Block ${raw.blockNumber}: decryptSnapshot threw (skipping): ${err.message}`);
    }
  }

  info(`Decrypted ${decryptedSnapshots.length} of ${rawSnapshots.length} snapshots`);
  if (decryptedSnapshots.length === 0) {
    fail("Could not decrypt any snapshots — MemoKey mismatch or events emitted with empty snapshot");
    failures++;
    details.push("0 snapshots decrypted");
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }
  assertionsPassed++;

  // 5c. Read on-chain commitment.
  let onChainCommit;
  try {
    onChainCommit = await recovery.readJanusFlowCommitment(ALICE_COA, provider);
    info(`On-chain commit: x=${onChainCommit.x.toString().slice(0, 20)}... y=${onChainCommit.y.toString().slice(0, 20)}...`);
    if (onChainCommit.x === 0n && onChainCommit.y === 0n) {
      fail("On-chain commitment is zero — Alice's slot appears empty (wrap may not have landed)");
      failures++;
      details.push("on-chain commit is zero");
      return await finalize(txHashes, failures, assertionsPassed, details, startMs);
    }
    assertionsPassed++;
  } catch (err) {
    fail(`readJanusFlowCommitment threw: ${err.message}`);
    failures++;
    details.push(`readCommit FAIL: ${err.message}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }

  // 5d. Reconstruct + validate.
  let recoveredState;
  try {
    recoveredState = await recovery.reconstructFromSnapshots({
      snapshots: decryptedSnapshots,
      incomingDeltas: [],  // Alice has no incoming shielded transfers to herself
      onChainCommit,
    });
    info(`Reconstructed: balanceWei=${recoveredState.balanceWei} blinding=${recoveredState.blinding.toString().slice(0, 20)}...`);
    recoveredBalance = recoveredState.balanceWei;
    recoveredBlinding = recoveredState.blinding;
  } catch (err) {
    if (err.name === "RecoveryDesyncError" || err.constructor?.name === "RecoveryDesyncError") {
      fail(`RecoveryDesyncError (real v0.5.2 bug): ${err.message}`);
      failures++;
      details.push(`RecoveryDesyncError: ${err.message}`);
      return await finalize(txHashes, failures, assertionsPassed, details, startMs);
    }
    fail(`reconstructFromSnapshots threw unexpectedly: ${err.message}`);
    failures++;
    details.push(`reconstruct FAIL: ${err.message}`);
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }

  // ── Step 6: Assert recovered state ────────────────────────────────────────
  logStep("Step 6: Assert recovered balance = 4 FLOW");
  const expectedBalanceWei = flowToWei(4n); // 5 wrap - 1 send

  if (recoveredBalance === expectedBalanceWei) {
    pass(`Recovered balance = ${recoveredBalance / flowToWei(1n)} FLOW (CORRECT: expected 4 FLOW)`);
    assertionsPassed++;
  } else {
    fail(
      `Recovered balance mismatch: got ${recoveredBalance} (= ${recoveredBalance / flowToWei(1n)} FLOW), ` +
      `expected ${expectedBalanceWei} (= 4 FLOW)`
    );
    failures++;
    details.push(
      `balance mismatch: got ${recoveredBalance}, expected ${expectedBalanceWei}`
    );
  }

  // Pedersen validation is done inside reconstructFromSnapshots — if it returned
  // without throwing RecoveryDesyncError, the Pedersen check passed.
  pass("Pedersen(recoveredBalance, recoveredBlinding) == onChainCommit (validated in reconstructFromSnapshots)");
  assertionsPassed++;
  details.push("Pedersen validation passed");

  // ── Step 7: Unwrap using recovered state ──────────────────────────────────
  logStep("Step 7: Unwrap 4 FLOW using recovered (balance, blinding)");
  if (recoveredBalance === null || recoveredBlinding === null) {
    fail("Cannot unwrap — recovery did not produce a valid state");
    failures++;
    return await finalize(txHashes, failures, assertionsPassed, details, startMs);
  }

  const unwrapAmountWei = recoveredBalance; // unwrap everything
  const unwrapTxBlinding = generateBlinding();
  const residualBlinding = generateBlinding(); // 0 residual, but need a blinding

  const amountProofUnwrap = await buildAmountDiscloseProof(
    { amount: unwrapAmountWei, blinding: unwrapTxBlinding },
    { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
  );
  const transferProofUnwrap = await buildShieldedTransferProof(
    {
      oldBalance: recoveredBalance,
      oldBlinding: recoveredBlinding,
      transferAmount: unwrapAmountWei,
      transferBlinding: unwrapTxBlinding,
      newBlinding: residualBlinding,
    },
    { wasmPath: TRANSFER_WASM, zkeyPath: TRANSFER_ZKEY }
  );

  // Residual after full unwrap: 0 FLOW.
  const unwrapSnapshot = await recovery.encryptSnapshotToSelf(
    { balance: 0n, blinding: residualBlinding },
    memoKeyForEncrypt
  );

  const claimedAmountUFix = (unwrapAmountWei / flowToWei(1n)).toString() + ".00000000";
  const unwrapCalldata = await buildUnwrapCalldata(
    unwrapAmountWei,
    ALICE_COA,
    amountProofUnwrap.txCommit,
    amountProofUnwrap.proof,
    transferProofUnwrap.publicInputs,
    transferProofUnwrap.proof,
    unwrapSnapshot.ciphertext,
    unwrapSnapshot.ephPubkey.x,
    unwrapSnapshot.ephPubkey.y
  );

  const unwrapTx = flowTx(
    TX_UNWRAP_TO_VAULT,
    [
      { type: "UFix64", value: claimedAmountUFix },
      arrUInt256(amountProofUnwrap.txCommit),
      arrUInt256(amountProofUnwrap.proof),
      arrUInt256(transferProofUnwrap.publicInputs),
      arrUInt256(transferProofUnwrap.proof),
      { type: "String", value: unwrapCalldata },
    ],
    ALICE_SIGNER
  );
  txHashes.unwrap = unwrapTx.txId || null;
  if (!unwrapTx.ok) {
    fail(`Unwrap with recovered state FAILED: ${unwrapTx.error.slice(0, 500)}`);
    fail("This proves the recovered blinding is INCORRECT — recovery module bug.");
    failures++;
    details.push(`unwrap-recovered FAIL: ${unwrapTx.error.slice(0, 300)}`);
  } else {
    pass(`Unwrap with recovered state succeeded — tx ${unwrapTx.txId}`);
    pass("Recovered blinding is CORRECT (unwrap ZK proof verified on-chain).");
    assertionsPassed++;
    details.push(`unwrap-recovered OK: ${unwrapTx.txId}`);
  }

  return await finalize(txHashes, failures, assertionsPassed, details, startMs);
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

async function finalize(txHashes, failures, assertionsPassed, details, startMs) {
  const durationMs = Date.now() - startMs;
  const status = failures === 0 ? "PASS" : "FAIL";

  console.log("\n" + "=".repeat(72));
  console.log(`  VERDICT: ${status}`);
  console.log(`  Assertions passed: ${assertionsPassed}`);
  console.log(`  Failures: ${failures}`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log("  TX hashes:");
  for (const [k, v] of Object.entries(txHashes)) {
    console.log(`    ${k.padEnd(18)} ${v ?? "(none)"}`);
  }
  console.log("=".repeat(72));

  // Append to results file.
  const resultsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "v0_5_2-smoke-results.json"
  );
  let existing = [];
  try {
    if (existsSync(resultsPath)) {
      const raw = readFileSync(resultsPath, "utf-8");
      existing = JSON.parse(raw);
      if (!Array.isArray(existing)) existing = [existing];
    }
  } catch {
    existing = [];
  }
  existing.push({
    timestamp: new Date().toISOString(),
    sdk_version: "0.5.2",
    scripts: {
      "v0_5_2-recovery-smoke": {
        status,
        duration_ms: durationMs,
        tx_hashes: Object.values(txHashes).filter(Boolean),
        assertions_passed: assertionsPassed,
        details: details.join("; "),
      },
    },
  });
  writeFileSync(resultsPath, JSON.stringify(existing, null, 2));
  console.log(`\nResults appended to ${resultsPath}`);

  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err.message);
    console.error(err.stack?.split("\n").slice(0, 10).join("\n"));
    process.exit(2);
  });
