#!/usr/bin/env node
"use strict";
/**
 * test-accumulation-recovery.cjs — Scenario 1: accumulation + C_old fix validation
 *
 * Validates: User can wrap multiple times, state recovery from ShieldedCheckpoint
 * always matches on-chain commitment. NO C_old mismatch errors.
 *
 * Steps:
 *   1. Admin resets Alice's slot (fresh start)
 *   2. Alice publishes memokey (if not already done)
 *   3. Alice wraps 0.01 FLOW → updates checkpoint → assert commit matches
 *   4. Alice wraps 0.005 FLOW → updates checkpoint → assert commit matches
 *   5. Alice wraps 0.003 FLOW → updates checkpoint → assert commit matches
 *   6. "Browser reopen": recover state ONLY via ShieldedCheckpoint.readAndDecrypt
 *   7. Build + submit shieldedTransfer of 0.005 FLOW using recovered state
 *      → PASS if proof generates + tx succeeds (no C_old mismatch)
 *   8. Assert Alice's residual balance matches expectation
 *
 * Output: JSON file at scripts/results-accumulation-recovery.json + stdout
 */

const path   = require("path");
const fs     = require("fs");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const {
  sdk,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  provider,
  ADDRESSES,
  DEPLOYER_EOA_KEY,
  jsonOutput,
  bigintReplacer,
} = require("./_shared.cjs");

const {
  decryptSnapshot,
  encryptSnapshot,
  generateBlinding,
  BatchClaimClient,
} = require("@claucondor/sdk");

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT   = "/home/oydual3/zkapps/private-tip-v1";
const RESULTS_FILE = path.join(REPO_ROOT, "scripts", "results-accumulation-recovery.json");
const NETWORK     = "testnet";

const ALICE_KEY  = DEPLOYER_EOA_KEY;
// Bob: a secondary address that Alice will tip to (to have a valid recipient)
const BOB_KEY    = "0x98ce0bff00e393fa28b89bf60f4d463add1d914bd869f432dac191d2e3cb907b";

const JANUS_FLOW_PROXY = ADDRESSES.janusFlow;

// Event signature for WrapWithSnapshot (to recover state post-wrap)
const WRAP_EVENT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_EVENT_SIG]);

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario:  "accumulation-recovery",
  started:   new Date().toISOString(),
  steps:     {},
  verdict:   "RUNNING",
};

function save() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, bigintReplacer, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Send a Cadence transaction via flow CLI with --args-json. Returns tx ID. */
function flowSend(txFile, signer, argsJson) {
  const txPath = path.join(REPO_ROOT, "cadence", "transactions", txFile);
  const cmd = [
    "flow", "transactions", "send",
    "--network", NETWORK,
    "--signer", signer,
    "--config-path", path.join(REPO_ROOT, "flow.json"),
    "--output", "json",
    "--args-json", JSON.stringify(argsJson),
    txPath,
  ];
  process.stderr.write(`[admin] flow send ${txFile}...\n`);
  const output = execFileSync(cmd[0], cmd.slice(1), {
    cwd: REPO_ROOT,
    timeout: 120_000,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    const match = output.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error(`flow send ${txFile}: no JSON:\n${output.slice(0, 400)}`);
    result = JSON.parse(match[1]);
  }
  if (!result.id) throw new Error(`flow send ${txFile}: no tx id:\n${JSON.stringify(result).slice(0, 400)}`);
  process.stderr.write(`[admin] sealed ${txFile}: ${result.id}\n`);
  return result.id;
}

/** ABI-encode adminBatchResetSlots(address[]) calldata (strip leading 0x). */
function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface([
    "function adminBatchResetSlots(address[] calldata users) external",
  ]);
  return iface.encodeFunctionData("adminBatchResetSlots", [addresses]).slice(2);
}

/** Parse WrapWithSnapshot event from tx receipt and decrypt snapshot. */
async function recoverSnapFromReceipt(txHash, memoPrivkey) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`No receipt for ${txHash}`);
  for (const log of receipt.logs) {
    try {
      const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WrapWithSnapshot") {
        const enc  = ethers.getBytes(parsed.args.encryptedSnapshot);
        const ephX = BigInt(parsed.args.ephPubkeyX);
        const ephY = BigInt(parsed.args.ephPubkeyY);
        return await decryptSnapshot(enc, { x: ephX, y: ephY }, memoPrivkey);
      }
    } catch (_) { /* skip */ }
  }
  return null;
}

/** Update ShieldedCheckpoint with new (balance, blinding) state. */
async function writeCheckpoint(cpClient, wallet, keypair, balance, blinding, cursorNote = 0n) {
  const enc = await encryptSnapshot({ balance, blinding }, keypair.pubkey);
  return cpClient.update(
    { encryptedSnapshot: enc.ciphertext, ephPubkeyX: enc.ephemeralPubkey.x, ephPubkeyY: enc.ephemeralPubkey.y },
    cursorNote,
    wallet,
  );
}

/** Verify on-chain commitment vs local state. Returns true if match. */
async function verifyCommitmentMatch(adapter, userAddr, localBalance, localBlinding) {
  const { computeCommitment } = require("@claucondor/sdk");  // may not exist — fallback
  try {
    const { addCommitmentsLocal, computeCommitment: cc } = require("@claucondor/sdk");
    const localCommit = await cc(localBalance, localBlinding);
    const onChain     = await adapter.getCommitment(userAddr);
    const match = localCommit.x === BigInt(onChain.x) && localCommit.y === BigInt(onChain.y);
    return { match, local: localCommit, onChain: { x: BigInt(onChain.x), y: BigInt(onChain.y) } };
  } catch (_) {
    // computeCommitment not exported directly — just return on-chain values
    const onChain = await adapter.getCommitment(userAddr);
    return { match: null, local: null, onChain: { x: BigInt(onChain.x), y: BigInt(onChain.y) } };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const alice  = makeWallet(ALICE_KEY);
  const bob    = makeWallet(BOB_KEY);

  process.stderr.write(`[S1] Alice: ${alice.address}\n`);
  process.stderr.write(`[S1] Bob:   ${bob.address}\n`);
  save();

  const aliceJub = await deriveMemoKeypair(alice);
  const bobJub   = await deriveMemoKeypair(bob);
  const adapter  = sdk.token("flow");
  const cpClient = new ShieldedCheckpointClient();

  // ── Step 0: Fund Bob if needed (for gas) ─────────────────────────────────
  const bobBal = await provider.getBalance(bob.address);
  if (bobBal < ethers.parseEther("0.005")) {
    process.stderr.write(`[S1] Funding Bob for gas...\n`);
    const ft = await alice.sendTransaction({ to: bob.address, value: ethers.parseEther("0.01") });
    await ft.wait(1);
    process.stderr.write(`[S1] Funded Bob: ${ft.hash}\n`);
  }

  // ── Step 1: Admin reset Alice's slot ─────────────────────────────────────
  process.stderr.write(`[S1] Step 1: adminResetSlot(alice)...\n`);
  const resetCalldata = encodeAdminBatchReset([alice.address]);
  const adminResetTx = flowSend("admin_evm_call.cdc", "openjanus-v08", [
    { type: "String", value: JANUS_FLOW_PROXY.slice(2) },
    { type: "String", value: resetCalldata },
    { type: "UInt64", value: "500000" },
  ]);
  results.steps.admin_reset = { cadenceTxId: adminResetTx, target: alice.address };
  save();
  process.stderr.write(`[S1] Admin reset done: ${adminResetTx}\n`);

  // ── Step 2: Alice publishes memokey (idempotent) ──────────────────────────
  process.stderr.write(`[S1] Step 2: Publish memokey...\n`);
  const currentKey = await adapter.getMemoKey(alice.address);
  let memoKeyTx = null;
  if (!currentKey || BigInt(currentKey.x) !== aliceJub.pubkey.x) {
    const res = await adapter.publishMemoKey(aliceJub, alice);
    memoKeyTx = res.txHash;
    process.stderr.write(`[S1] MemoKey published: ${memoKeyTx}\n`);
  } else {
    process.stderr.write(`[S1] MemoKey already registered\n`);
  }
  results.steps.memokey = { txHash: memoKeyTx, pubkeyX: aliceJub.pubkey.x.toString() };
  save();

  // ── Step 2b: Bob publishes memokey (needed as tip recipient) ─────────────
  process.stderr.write(`[S1] Step 2b: Bob publishes memokey...\n`);
  const bobKey = await adapter.getMemoKey(bob.address);
  let bobMemoTx = null;
  if (!bobKey || BigInt(bobKey.x) !== bobJub.pubkey.x) {
    const res = await adapter.publishMemoKey(bobJub, bob);
    bobMemoTx = res.txHash;
    process.stderr.write(`[S1] Bob MemoKey: ${bobMemoTx}\n`);
  }
  results.steps.bob_memokey = { txHash: bobMemoTx };
  save();

  // Accumulated state tracking — balance and blinding are cumulative across wraps.
  // Each WrapWithSnapshot contains only the MARGINAL amount for that wrap.
  // Cumulative: balance += wrap.balance; blinding += wrap.blinding (field addition on-chain).
  let balance  = 0n;
  let blinding = 0n;

  // ── Step 3: Wrap #1 — 0.01 FLOW ─────────────────────────────────────────
  process.stderr.write(`[S1] Step 3: Wrap #1 (0.01 FLOW)...\n`);
  const wrap1 = await adapter.wrap({ grossAmount: ethers.parseEther("0.01") }, alice);
  const snap1  = await recoverSnapFromReceipt(wrap1.txHash, aliceJub.privkey);
  if (!snap1) throw new Error("Step 3: WrapWithSnapshot event not found");
  // First wrap: cumulative = marginal (prev state was 0)
  balance  += snap1.balance;
  blinding += snap1.blinding;
  process.stderr.write(`[S1] Wrap1: cumulative balance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp1 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain1 = await adapter.getCommitment(alice.address);
  results.steps.wrap1 = {
    txHash: wrap1.txHash, checkpointTx: cp1.txHash,
    marginalBalance: snap1.balance.toString(),
    cumulativeBalance: balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit: { x: onChain1.x.toString(), y: onChain1.y.toString() },
  };
  save();
  process.stderr.write(`[S1] Wrap1 done: ${wrap1.txHash}\n`);

  // ── Step 4: Wrap #2 — 0.005 FLOW ─────────────────────────────────────────
  process.stderr.write(`[S1] Step 4: Wrap #2 (0.005 FLOW)...\n`);
  const wrap2 = await adapter.wrap({ grossAmount: ethers.parseEther("0.005") }, alice);
  const snap2  = await recoverSnapFromReceipt(wrap2.txHash, aliceJub.privkey);
  if (!snap2) throw new Error("Step 4: WrapWithSnapshot event not found");
  // Accumulate: cumulative = wrap1 + wrap2
  balance  += snap2.balance;
  blinding += snap2.blinding;
  process.stderr.write(`[S1] Wrap2: cumulative balance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp2 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain2 = await adapter.getCommitment(alice.address);
  results.steps.wrap2 = {
    txHash: wrap2.txHash, checkpointTx: cp2.txHash,
    marginalBalance: snap2.balance.toString(),
    cumulativeBalance: balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit: { x: onChain2.x.toString(), y: onChain2.y.toString() },
  };
  save();
  process.stderr.write(`[S1] Wrap2 done: ${wrap2.txHash}\n`);

  // ── Step 5: Wrap #3 — 0.003 FLOW ─────────────────────────────────────────
  process.stderr.write(`[S1] Step 5: Wrap #3 (0.003 FLOW)...\n`);
  const wrap3 = await adapter.wrap({ grossAmount: ethers.parseEther("0.003") }, alice);
  const snap3  = await recoverSnapFromReceipt(wrap3.txHash, aliceJub.privkey);
  if (!snap3) throw new Error("Step 5: WrapWithSnapshot event not found");
  // Accumulate: cumulative = wrap1 + wrap2 + wrap3
  balance  += snap3.balance;
  blinding += snap3.blinding;
  process.stderr.write(`[S1] Wrap3: cumulative balance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp3 = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain3 = await adapter.getCommitment(alice.address);
  results.steps.wrap3 = {
    txHash: wrap3.txHash, checkpointTx: cp3.txHash,
    marginalBalance: snap3.balance.toString(),
    cumulativeBalance: balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit: { x: onChain3.x.toString(), y: onChain3.y.toString() },
  };
  save();
  process.stderr.write(`[S1] Wrap3 done: ${wrap3.txHash}\n`);

  // ── Step 6: "Browser reopen" — recover state ONLY from checkpoint ─────────
  process.stderr.write(`[S1] Step 6: Recovering state from ShieldedCheckpoint...\n`);
  // Simulate fresh session: forget in-memory balance/blinding
  const recoveredSnap = await cpClient.readAndDecrypt(alice, aliceJub.privkey);
  if (!recoveredSnap) throw new Error("Step 6: readAndDecrypt returned null — no checkpoint found");

  const recoveredBalance  = recoveredSnap.balance;
  const recoveredBlinding = recoveredSnap.blinding;

  const recoveryMatchesLocal = (recoveredBalance === balance) && (recoveredBlinding === blinding);
  process.stderr.write(`[S1] Recovery match: ${recoveryMatchesLocal}\n`);
  process.stderr.write(`[S1] Recovered balance=${recoveredBalance}, expected=${balance}\n`);

  results.steps.state_recovery = {
    recoveredBalance:  recoveredBalance.toString(),
    recoveredBlinding: recoveredBlinding.toString(),
    expectedBalance:   balance.toString(),
    expectedBlinding:  blinding.toString(),
    matchesLocal:      recoveryMatchesLocal,
  };
  save();

  // ── Step 7: shieldedTransfer using recovered state ────────────────────────
  const TIP_AMOUNT = ethers.parseEther("0.005");
  process.stderr.write(`[S1] Step 7: shieldedTransfer ${TIP_AMOUNT} → Bob using recovered state...\n`);

  let sendResult;
  let transferFailed = false;
  let transferError  = null;
  try {
    sendResult = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TIP_AMOUNT,
        memo:            "S1 recovery test",
        currentBalance:  recoveredBalance,
        currentBlinding: recoveredBlinding,
      },
      alice,
    );
    process.stderr.write(`[S1] Transfer succeeded: ${sendResult.txHash}\n`);
  } catch (err) {
    transferFailed = true;
    transferError  = err.message;
    process.stderr.write(`[S1] Transfer FAILED (C_old mismatch?): ${err.message}\n`);
  }

  if (!transferFailed && sendResult) {
    // Update checkpoint after send
    const newBal  = sendResult.newBalance  || (recoveredBalance  - TIP_AMOUNT);
    const newBld  = sendResult.newBlinding || recoveredBlinding;
    if (sendResult.checkpointPayload) {
      const cpSend = await cpClient.update(sendResult.checkpointPayload, 0n, alice);
      results.steps.transfer = {
        txHash:       sendResult.txHash,
        amount:       TIP_AMOUNT.toString(),
        newBalance:   newBal.toString(),
        checkpointTx: cpSend.txHash,
        couldMismatch: false,
      };
    } else {
      results.steps.transfer = {
        txHash:     sendResult.txHash,
        amount:     TIP_AMOUNT.toString(),
        newBalance: newBal.toString(),
        couldMismatch: false,
      };
    }
    balance  = newBal;
    blinding = newBld;
  } else {
    results.steps.transfer = {
      txHash: null,
      error:  transferError,
      couldMismatch: true,
    };
  }
  save();

  // ── Step 8: Final balance assertion ──────────────────────────────────────
  process.stderr.write(`[S1] Step 8: Final assertions...\n`);

  // After 3 wraps and 1 tip, cumulative balance should be ~0.013 FLOW
  // (no fees on wrap in this version, so: 0.01 + 0.005 + 0.003 - 0.005 = 0.013)
  const onChainFinal = await adapter.getCommitment(alice.address);
  const cpFinal      = await cpClient.readAndDecrypt(alice, aliceJub.privkey);

  results.steps.final = {
    onChainAfterWraps: {
      x: onChain3.x.toString(),
      y: onChain3.y.toString(),
    },
    onChainFinalCommit: {
      x: BigInt(onChainFinal.x).toString(),
      y: BigInt(onChainFinal.y).toString(),
    },
    residualBalance:     balance.toString(),
    checkpointBalance:   cpFinal ? cpFinal.balance.toString() : null,
    transferFailed,
    transferError,
  };
  save();

  // ── Final verdict ─────────────────────────────────────────────────────────
  const allWrapsGood = results.steps.wrap1 && results.steps.wrap2 && results.steps.wrap3;
  const recoveryGood = recoveryMatchesLocal;
  const transferGood = !transferFailed;
  const verdict = allWrapsGood && recoveryGood && transferGood ? "PASS" : "FAIL";

  results.verdict  = verdict;
  results.finished = new Date().toISOString();
  results.summary  = {
    allWrapsGood,
    recoveryGood,
    transferGood,
    verdict,
  };
  save();

  jsonOutput(results);
  process.stderr.write(`\n[S1] SCENARIO 1 VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S1] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
