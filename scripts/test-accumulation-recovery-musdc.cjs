#!/usr/bin/env node
"use strict";
/**
 * test-accumulation-recovery-musdc.cjs — Scenario C+: mUSDC accumulation + recovery
 *
 * Validates: JanusERC20 (mUSDC) user can wrap multiple times, state recovery from
 * ShieldedCheckpoint always matches on-chain commitment. No C_old mismatch errors.
 *
 * Steps:
 *   1. Admin resets Alice's slot on JanusERC20
 *   2. Alice mints 100 mUSDC to herself (MockUSDC.mint as owner)
 *   3. Alice approves JanusERC20 to spend 100 mUSDC
 *   4. Alice publishes memokey (if not already done)
 *   5. Bob publishes memokey (tip recipient)
 *   6. Alice wraps 10 mUSDC → updates checkpoint → assert commit
 *   7. Alice wraps 5 mUSDC  → updates checkpoint → assert commit
 *   8. Alice wraps 3 mUSDC  → updates checkpoint → assert commit
 *   9. "Browser reopen": recover state ONLY via ShieldedCheckpoint.readAndDecrypt
 *  10. shieldedTransfer 5 mUSDC → Bob using recovered state
 *      → PASS if proof succeeds (no C_old mismatch)
 *  11. Assert: alice residual = 13 mUSDC (10+5+3-5 = 13)
 *
 * mUSDC has 6 decimals:  10 mUSDC = 10_000_000n
 *
 * Output: JSON at scripts/results-accumulation-recovery-musdc.json + stdout
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
  ERC20_ABI,
  jsonOutput,
  bigintReplacer,
} = require("./_shared.cjs");

const {
  decryptSnapshot,
  encryptSnapshot,
  generateBlinding,
} = require("@claucondor/sdk");

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT    = "/home/oydual3/zkapps/private-tip-v1";
const RESULTS_FILE = path.join(REPO_ROOT, "scripts", "results-accumulation-recovery-musdc.json");
const NETWORK      = "testnet";

const ALICE_KEY = DEPLOYER_EOA_KEY;
const BOB_KEY   = "0x98ce0bff00e393fa28b89bf60f4d463add1d914bd869f432dac191d2e3cb907b";

// JanusERC20 proxy (mUSDC wrapper)
const JANUS_ERC20_PROXY = ADDRESSES.janusERC20;

// BabyJub prime-order subgroup. Blinding must stay in [0, SUBORDER).
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
// MockUSDC underlying ERC20
const MOCK_USDC_ADDR    = ADDRESSES.mockUSDC;

// mUSDC amounts (6 decimals)
const WRAP1_AMOUNT = 10_000_000n;  // 10 mUSDC
const WRAP2_AMOUNT =  5_000_000n;  //  5 mUSDC
const WRAP3_AMOUNT =  3_000_000n;  //  3 mUSDC
const SEND_AMOUNT  =  5_000_000n;  //  5 mUSDC
const MINT_AMOUNT  = 100_000_000n; // 100 mUSDC

// Expected residual after 3 wraps minus 1 send: 10+5+3-5 = 13 mUSDC
const EXPECTED_RESIDUAL = 13_000_000n;

// WrapWithSnapshot event (same in JanusFlow + JanusERC20 — both extend JanusToken)
const WRAP_EVENT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_EVENT_SIG]);

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario: "accumulation-recovery-musdc",
  started:  new Date().toISOString(),
  steps:    {},
  verdict:  "RUNNING",
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

/** Parse WrapWithSnapshot event from receipt and decrypt snapshot. */
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

/** Encrypt + write ShieldedCheckpoint with current (balance, blinding) state. */
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
  const alice = makeWallet(ALICE_KEY);
  const bob   = makeWallet(BOB_KEY);

  process.stderr.write(`[S1-mUSDC] Alice: ${alice.address}\n`);
  process.stderr.write(`[S1-mUSDC] Bob:   ${bob.address}\n`);
  save();

  const aliceJub = await deriveMemoKeypair(alice);
  const bobJub   = await deriveMemoKeypair(bob);
  const adapter  = sdk.token("mockusdc");
  const cpClient = new ShieldedCheckpointClient();

  // ── Step 0: Fund Bob for gas if needed ───────────────────────────────────
  const bobBal = await provider.getBalance(bob.address);
  if (bobBal < ethers.parseEther("0.005")) {
    process.stderr.write(`[S1-mUSDC] Funding Bob for gas...\n`);
    const ft = await alice.sendTransaction({ to: bob.address, value: ethers.parseEther("0.01") });
    await ft.wait(1);
    process.stderr.write(`[S1-mUSDC] Funded Bob: ${ft.hash}\n`);
  }

  // ── Step 1: Admin reset Alice's slot on JanusERC20 ───────────────────────
  process.stderr.write(`[S1-mUSDC] Step 1: adminBatchResetSlots([alice]) on JanusERC20...\n`);
  const resetCalldata = encodeAdminBatchReset([alice.address]);
  const adminResetTx = flowSend("admin_evm_call.cdc", "openjanus-v08", [
    { type: "String", value: JANUS_ERC20_PROXY.slice(2) },
    { type: "String", value: resetCalldata },
    { type: "UInt64", value: "500000" },
  ]);
  results.steps.admin_reset = { cadenceTxId: adminResetTx, target: alice.address, proxy: JANUS_ERC20_PROXY };
  save();
  process.stderr.write(`[S1-mUSDC] Admin reset done: ${adminResetTx}\n`);

  // ── Step 2: Alice mints 100 mUSDC to herself ──────────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 2: Mint ${MINT_AMOUNT} mUSDC (100 mUSDC) to Alice...\n`);
  const mockUsdc = new ethers.Contract(MOCK_USDC_ADDR, ERC20_ABI, alice);
  const mintTx = await mockUsdc.mint(alice.address, MINT_AMOUNT);
  const mintReceipt = await mintTx.wait();
  const balAfterMint = await mockUsdc.balanceOf(alice.address);
  process.stderr.write(`[S1-mUSDC] Minted. Alice mUSDC balance: ${balAfterMint}\n`);
  results.steps.mint = {
    txHash:        mintReceipt.hash,
    mintAmount:    MINT_AMOUNT.toString(),
    balanceAfter:  balAfterMint.toString(),
  };
  save();

  // ── Step 3: Alice approves JanusERC20 to spend 100 mUSDC ─────────────────
  process.stderr.write(`[S1-mUSDC] Step 3: Approve JanusERC20 for ${MINT_AMOUNT} mUSDC...\n`);
  const approveResult = await adapter.approveUnderlying(MINT_AMOUNT, alice);
  process.stderr.write(`[S1-mUSDC] Approved: ${approveResult.txHash}\n`);
  results.steps.approve = { txHash: approveResult.txHash, amount: MINT_AMOUNT.toString() };
  save();

  // ── Step 4: Alice publishes memokey (idempotent) ──────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 4: Publish Alice memokey...\n`);
  const currentKey = await adapter.getMemoKey(alice.address);
  let memoKeyTx = null;
  if (!currentKey || BigInt(currentKey.x) !== aliceJub.pubkey.x) {
    const res = await adapter.publishMemoKey(aliceJub, alice);
    memoKeyTx = res.txHash;
    process.stderr.write(`[S1-mUSDC] MemoKey published: ${memoKeyTx}\n`);
  } else {
    process.stderr.write(`[S1-mUSDC] MemoKey already registered\n`);
  }
  results.steps.memokey = { txHash: memoKeyTx, pubkeyX: aliceJub.pubkey.x.toString() };
  save();

  // ── Step 5: Bob publishes memokey (tip recipient) ─────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 5: Publish Bob memokey...\n`);
  const bobKey = await adapter.getMemoKey(bob.address);
  let bobMemoTx = null;
  if (!bobKey || BigInt(bobKey.x) !== bobJub.pubkey.x) {
    const res = await adapter.publishMemoKey(bobJub, bob);
    bobMemoTx = res.txHash;
    process.stderr.write(`[S1-mUSDC] Bob MemoKey: ${bobMemoTx}\n`);
  } else {
    process.stderr.write(`[S1-mUSDC] Bob MemoKey already registered\n`);
  }
  results.steps.bob_memokey = { txHash: bobMemoTx };
  save();

  // Accumulated state — WrapWithSnapshot emits MARGINAL amount (not cumulative)
  let balance  = 0n;
  let blinding = 0n;

  // ── Step 6: Wrap #1 — 10 mUSDC ───────────────────────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 6: Wrap #1 (${WRAP1_AMOUNT} = 10 mUSDC)...\n`);
  const wrap1 = await adapter.wrap({ grossAmount: WRAP1_AMOUNT }, alice);
  const snap1 = await recoverSnapFromReceipt(wrap1.txHash, aliceJub.privkey);
  if (!snap1) throw new Error("Step 6: WrapWithSnapshot event not found");
  balance  += snap1.balance;
  blinding = (blinding + snap1.blinding) % SUBORDER;
  process.stderr.write(`[S1-mUSDC] Wrap1: cumBalance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp1      = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain1 = await adapter.getCommitment(alice.address);
  results.steps.wrap1 = {
    txHash:             wrap1.txHash,
    checkpointTx:       cp1.txHash,
    marginalBalance:    snap1.balance.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain1.x.toString(), y: onChain1.y.toString() },
  };
  save();
  process.stderr.write(`[S1-mUSDC] Wrap1 done: ${wrap1.txHash}\n`);

  // ── Step 7: Wrap #2 — 5 mUSDC ────────────────────────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 7: Wrap #2 (${WRAP2_AMOUNT} = 5 mUSDC)...\n`);
  const wrap2 = await adapter.wrap({ grossAmount: WRAP2_AMOUNT }, alice);
  const snap2 = await recoverSnapFromReceipt(wrap2.txHash, aliceJub.privkey);
  if (!snap2) throw new Error("Step 7: WrapWithSnapshot event not found");
  balance  += snap2.balance;
  blinding = (blinding + snap2.blinding) % SUBORDER;
  process.stderr.write(`[S1-mUSDC] Wrap2: cumBalance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp2      = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain2 = await adapter.getCommitment(alice.address);
  results.steps.wrap2 = {
    txHash:             wrap2.txHash,
    checkpointTx:       cp2.txHash,
    marginalBalance:    snap2.balance.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain2.x.toString(), y: onChain2.y.toString() },
  };
  save();
  process.stderr.write(`[S1-mUSDC] Wrap2 done: ${wrap2.txHash}\n`);

  // ── Step 8: Wrap #3 — 3 mUSDC ────────────────────────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 8: Wrap #3 (${WRAP3_AMOUNT} = 3 mUSDC)...\n`);
  const wrap3 = await adapter.wrap({ grossAmount: WRAP3_AMOUNT }, alice);
  const snap3 = await recoverSnapFromReceipt(wrap3.txHash, aliceJub.privkey);
  if (!snap3) throw new Error("Step 8: WrapWithSnapshot event not found");
  balance  += snap3.balance;
  blinding = (blinding + snap3.blinding) % SUBORDER;
  process.stderr.write(`[S1-mUSDC] Wrap3: cumBalance=${balance}, blinding=${blinding.toString().slice(0,12)}...\n`);

  const cp3      = await writeCheckpoint(cpClient, alice, aliceJub, balance, blinding);
  const onChain3 = await adapter.getCommitment(alice.address);
  results.steps.wrap3 = {
    txHash:             wrap3.txHash,
    checkpointTx:       cp3.txHash,
    marginalBalance:    snap3.balance.toString(),
    cumulativeBalance:  balance.toString(),
    cumulativeBlinding: blinding.toString(),
    onChainCommit:      { x: onChain3.x.toString(), y: onChain3.y.toString() },
  };
  save();
  process.stderr.write(`[S1-mUSDC] Wrap3 done: ${wrap3.txHash}\n`);

  // ── Step 9: "Browser reopen" — recover state ONLY from ShieldedCheckpoint ─
  process.stderr.write(`[S1-mUSDC] Step 9: Recovering state from ShieldedCheckpoint...\n`);
  const recoveredSnap = await cpClient.readAndDecrypt(alice, aliceJub.privkey);
  if (!recoveredSnap) throw new Error("Step 9: readAndDecrypt returned null — no checkpoint found");

  const recoveredBalance  = recoveredSnap.balance;
  const recoveredBlinding = recoveredSnap.blinding;
  const recoveryMatch = (recoveredBalance === balance) && (recoveredBlinding === blinding);

  process.stderr.write(`[S1-mUSDC] Recovery match: ${recoveryMatch}\n`);
  process.stderr.write(`[S1-mUSDC] Recovered balance=${recoveredBalance}, expected=${balance}\n`);

  results.steps.state_recovery = {
    recoveredBalance:  recoveredBalance.toString(),
    recoveredBlinding: recoveredBlinding.toString(),
    expectedBalance:   balance.toString(),
    expectedBlinding:  blinding.toString(),
    matchesLocal:      recoveryMatch,
  };
  save();

  // ── Step 10: shieldedTransfer 5 mUSDC → Bob using recovered state ─────────
  process.stderr.write(`[S1-mUSDC] Step 10: shieldedTransfer ${SEND_AMOUNT} mUSDC → Bob...\n`);

  let sendResult;
  let transferFailed = false;
  let transferError  = null;

  try {
    sendResult = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          SEND_AMOUNT,
        memo:            "S1-mUSDC recovery test",
        currentBalance:  recoveredBalance,
        currentBlinding: recoveredBlinding,
      },
      alice,
    );
    process.stderr.write(`[S1-mUSDC] Transfer succeeded: ${sendResult.txHash}\n`);
  } catch (err) {
    transferFailed = true;
    transferError  = err.message;
    process.stderr.write(`[S1-mUSDC] Transfer FAILED (C_old mismatch?): ${err.message}\n`);
  }

  if (!transferFailed && sendResult) {
    const newBal = sendResult.newBalance  ?? (recoveredBalance - SEND_AMOUNT);
    const newBld = sendResult.newBlinding ?? recoveredBlinding;
    if (sendResult.checkpointPayload) {
      const cpSend = await cpClient.update(sendResult.checkpointPayload, 0n, alice);
      results.steps.transfer = {
        txHash:        sendResult.txHash,
        amount:        SEND_AMOUNT.toString(),
        newBalance:    newBal.toString(),
        checkpointTx:  cpSend.txHash,
        couldMismatch: false,
      };
    } else {
      results.steps.transfer = {
        txHash:        sendResult.txHash,
        amount:        SEND_AMOUNT.toString(),
        newBalance:    newBal.toString(),
        couldMismatch: false,
      };
    }
    balance  = newBal;
    blinding = newBld;
  } else {
    results.steps.transfer = {
      txHash:        null,
      error:         transferError,
      couldMismatch: true,
    };
  }
  save();

  // ── Step 11: Final assertions ─────────────────────────────────────────────
  process.stderr.write(`[S1-mUSDC] Step 11: Final assertions...\n`);

  const onChainFinal = await adapter.getCommitment(alice.address);
  const cpFinal      = await cpClient.readAndDecrypt(alice, aliceJub.privkey);

  // Residual = 10+5+3-5 = 13 mUSDC = 13_000_000
  const residualMatch = balance === EXPECTED_RESIDUAL;
  process.stderr.write(`[S1-mUSDC] Residual: ${balance} (expected ${EXPECTED_RESIDUAL}) match=${residualMatch}\n`);

  results.steps.final = {
    onChainAfterWraps: { x: onChain3.x.toString(), y: onChain3.y.toString() },
    onChainFinalCommit: {
      x: BigInt(onChainFinal.x).toString(),
      y: BigInt(onChainFinal.y).toString(),
    },
    residualBalance:    balance.toString(),
    expectedResidual:   EXPECTED_RESIDUAL.toString(),
    residualMatch,
    checkpointBalance:  cpFinal ? cpFinal.balance.toString() : null,
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
    token:              "mUSDC",
    proxy:              JANUS_ERC20_PROXY,
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
  process.stderr.write(`\n[S1-mUSDC] SCENARIO VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S1-mUSDC] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict   = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
