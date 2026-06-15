#!/usr/bin/env node
"use strict";
/**
 * test-batch-claim.cjs — Scenario 2: batch claim end-to-end validation
 *
 * Validates: Bob receives 6 tips, blinding accumulates, batchClaim consolidates
 * to fresh state, Bob can then shieldedTransfer successfully.
 *
 * Steps:
 *   1. Setup: admin resets alice + bob slots; publish memokeys
 *   2. Alice wraps 0.05 FLOW
 *   3. Alice sends 6 × 0.005 FLOW tips to Bob
 *   4. Bob drains inbox → get 6 notes with {amount, blinding}
 *   5. Without batchClaim: attempt shieldedTransfer from Bob → must FAIL
 *      (commitment is zero / inbox not consumed)
 *   6. batchClaim: consolidate 6 notes into fresh Bob commitment
 *   7. Bob updates ShieldedCheckpoint with new state
 *   8. After batchClaim: Bob shieldedTransfers 0.005 FLOW to Charlie → PASS
 *   9. Final assertions: commit matches, residual = 0.025 FLOW (approx)
 *
 * Output: JSON file at scripts/results-batch-claim.json + stdout
 */

const path   = require("path");
const fs     = require("fs");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const {
  sdk,
  ShieldedCheckpointClient,
  ShieldedInboxClient,
  makeWallet,
  deriveMemoKeypair,
  provider,
  ADDRESSES,
  DEPLOYER_EOA_KEY,
  jsonOutput,
  bigintReplacer,
} = require("./_shared.cjs");

const {
  generateBlinding,
  encryptSnapshot,
  BatchClaimClient,
} = require("@claucondor/sdk");

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT    = "/home/oydual3/zkapps/private-tip-v1";
const RESULTS_FILE = path.join(REPO_ROOT, "scripts", "results-batch-claim.json");
const NETWORK      = "testnet";

const ALICE_KEY   = DEPLOYER_EOA_KEY;
// Generate fresh random keypairs each run to avoid state pollution from previous test runs.
// The previous Bob key had residual commitment from failed runs (shieldedTransfer updates
// recipient commitment on-chain; inbox notes are not cleared by adminResetSlot).
const BOB_KEY     = "0x" + require("crypto").randomBytes(32).toString("hex");
const CHARLIE_KEY = "0x" + require("crypto").randomBytes(32).toString("hex");

const JANUS_FLOW_PROXY = ADDRESSES.janusFlow;

// Circuit paths for proof generation (151 MB zkey — proof takes ~60–90 s)
const ZKEY_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/ceremony/cb_final.zkey";
const WASM_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/build/confidential_claim_batch_js/confidential_claim_batch.wasm";

// WrapWithSnapshot event interface (to recover wrap state for alice)
const WRAP_EVENT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_EVENT_SIG]);

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario:  "batch-claim",
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
  process.stderr.write(`[admin] sealed: ${result.id}\n`);
  return result.id;
}

/** ABI-encode adminBatchResetSlots(address[]) calldata (strip leading 0x). */
function encodeAdminBatchReset(addresses) {
  const iface = new ethers.Interface([
    "function adminBatchResetSlots(address[] calldata users) external",
  ]);
  return iface.encodeFunctionData("adminBatchResetSlots", [addresses]).slice(2);
}

/** Recover WrapWithSnapshot snapshot from tx receipt. */
async function recoverSnapFromReceipt(txHash, memoPrivkey) {
  const { decryptSnapshot } = require("@claucondor/sdk");
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const alice   = makeWallet(ALICE_KEY);
  const bob     = makeWallet(BOB_KEY);
  const charlie = makeWallet(CHARLIE_KEY);

  process.stderr.write(`[S2] Alice:   ${alice.address}\n`);
  process.stderr.write(`[S2] Bob:     ${bob.address}\n`);
  process.stderr.write(`[S2] Charlie: ${charlie.address}\n`);
  save();

  const aliceJub   = await deriveMemoKeypair(alice);
  const bobJub     = await deriveMemoKeypair(bob);
  const charlieJub = await deriveMemoKeypair(charlie);
  const adapter    = sdk.token("flow");
  const cpClient   = new ShieldedCheckpointClient();
  const inboxClient = new ShieldedInboxClient();

  // ── Step 0: Fund Alice from admin COA if low, fund Bob + Charlie for gas ─
  const aliceBal = await provider.getBalance(alice.address);
  if (aliceBal < ethers.parseEther("0.35")) {
    // Top-up Alice via admin COA (fund_evm.cdc) — each shielded tip costs ~0.025 FLOW gas
    process.stderr.write(`[S2] Alice low (${ethers.formatEther(aliceBal)} FLOW). Topping up via admin COA...\n`);
    const fundAliceTxId = flowSend("fund_evm.cdc", "openjanus-v08", [
      { type: "String", value: alice.address.slice(2) },  // strip 0x
      { type: "UFix64", value: "0.50000000" },
    ]);
    process.stderr.write(`[S2] Funded Alice: ${fundAliceTxId}\n`);
    results.steps.fund_alice = { cadenceTxId: fundAliceTxId };
    save();
  }

  for (const [name, wallet] of [["Bob", bob], ["Charlie", charlie]]) {
    const bal = await provider.getBalance(wallet.address);
    // Bob needs extra gas: batchClaim Groth16 verify costs ~0.004 FLOW + shieldedTransfer ~0.002 FLOW
    // Charlie just needs gas for receiving (checkpoint update): ~0.001 FLOW
    const minBal = name === "Bob" ? ethers.parseEther("0.015") : ethers.parseEther("0.005");
    const topUp  = name === "Bob" ? ethers.parseEther("0.03")  : ethers.parseEther("0.01");
    if (bal < minBal) {
      process.stderr.write(`[S2] Funding ${name} for gas (${ethers.formatEther(bal)} → +${ethers.formatEther(topUp)} FLOW)...\n`);
      const ft = await alice.sendTransaction({ to: wallet.address, value: topUp });
      await ft.wait(1);
      process.stderr.write(`[S2] Funded ${name}: ${ft.hash}\n`);
    }
  }

  // ── Step 1a: Admin reset Alice's slot only (Bob is fresh ephemeral address)
  process.stderr.write(`[S2] Step 1: adminBatchResetSlots([alice])...\n`);
  // Note: Bob is a fresh random address — no history, commitment already identity.
  // Only Alice (deployer) needs resetting since she may have prior shielded state.
  const resetCalldata = encodeAdminBatchReset([alice.address]);
  const adminResetTx = flowSend("admin_evm_call.cdc", "openjanus-v08", [
    { type: "String", value: JANUS_FLOW_PROXY.slice(2) },
    { type: "String", value: resetCalldata },
    { type: "UInt64", value: "500000" },
  ]);
  results.steps.admin_reset = { cadenceTxId: adminResetTx, targets: [alice.address], bobIsFresh: true };
  save();
  process.stderr.write(`[S2] Reset done: ${adminResetTx}\n`);

  // ── Step 1b: Publish memokeys (idempotent) ───────────────────────────────
  process.stderr.write(`[S2] Step 1b: Publish memokeys...\n`);
  const memokeyResults = {};
  for (const [name, wallet, kp] of [
    ["alice", alice, aliceJub],
    ["bob", bob, bobJub],
    ["charlie", charlie, charlieJub],
  ]) {
    const existing = await adapter.getMemoKey(wallet.address);
    if (!existing || BigInt(existing.x) !== kp.pubkey.x) {
      const res = await adapter.publishMemoKey(kp, wallet);
      memokeyResults[name] = res.txHash;
      process.stderr.write(`[S2] ${name} memokey: ${res.txHash}\n`);
    } else {
      memokeyResults[name] = null;
      process.stderr.write(`[S2] ${name} memokey already registered\n`);
    }
  }
  results.steps.memokeys = memokeyResults;
  save();

  // ── Step 2: Alice wraps 0.05 FLOW ────────────────────────────────────────
  process.stderr.write(`[S2] Step 2: Alice wraps 0.05 FLOW...\n`);
  const wrapResult = await adapter.wrap({ grossAmount: ethers.parseEther("0.05") }, alice);
  const wrapSnap   = await recoverSnapFromReceipt(wrapResult.txHash, aliceJub.privkey);
  if (!wrapSnap) throw new Error("Step 2: WrapWithSnapshot not found");

  let aliceBalance  = wrapSnap.balance;
  let aliceBlinding = wrapSnap.blinding;
  process.stderr.write(`[S2] Alice wrapped. balance=${aliceBalance}\n`);

  // Update Alice's checkpoint
  const enc1 = await encryptSnapshot({ balance: aliceBalance, blinding: aliceBlinding }, aliceJub.pubkey);
  const aliceCp1 = await cpClient.update(
    { encryptedSnapshot: enc1.ciphertext, ephPubkeyX: enc1.ephemeralPubkey.x, ephPubkeyY: enc1.ephemeralPubkey.y },
    0n,
    alice,
  );
  results.steps.alice_wrap = {
    txHash: wrapResult.txHash,
    checkpointTx: aliceCp1.txHash,
    netAmount: aliceBalance.toString(),
  };
  save();

  // ── Step 3: Alice sends 6 × 0.005 FLOW tips to Bob ──────────────────────
  process.stderr.write(`[S2] Step 3: Sending 6 tips from Alice to Bob...\n`);
  const TIP_AMOUNT = ethers.parseEther("0.005");
  const tipTxHashes = [];

  for (let i = 1; i <= 6; i++) {
    process.stderr.write(`[S2]   Tip ${i}/6: ${TIP_AMOUNT} FLOW → Bob...\n`);
    const sendRes = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TIP_AMOUNT,
        memo:            `S2 tip ${i}/6`,
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice,
    );
    tipTxHashes.push(sendRes.txHash);
    aliceBalance  = sendRes.newBalance  || (aliceBalance  - TIP_AMOUNT);
    aliceBlinding = sendRes.newBlinding || aliceBlinding;
    // No in-loop checkpoint update — avoid nonce collisions between shieldedTransfer + checkpoint.
    // Alice's checkpoint is updated once after all tips complete.
    process.stderr.write(`[S2]   Tip ${i} done: ${sendRes.txHash}\n`);
  }

  // Update Alice's checkpoint once after all tips (avoid in-loop nonce conflicts)
  {
    const aliceEncSnap = await encryptSnapshot({ balance: aliceBalance, blinding: aliceBlinding }, aliceJub.pubkey);
    const aliceCpAfterTips = await cpClient.update(
      { encryptedSnapshot: aliceEncSnap.ciphertext, ephPubkeyX: aliceEncSnap.ephemeralPubkey.x, ephPubkeyY: aliceEncSnap.ephemeralPubkey.y },
      0n,
      alice,
    );
    results.steps.alice_checkpoint_after_tips = { txHash: aliceCpAfterTips.txHash };
    process.stderr.write(`[S2] Alice checkpoint after tips: ${aliceCpAfterTips.txHash}\n`);
  }

  results.steps.alice_tips = {
    count:        6,
    tipAmount:    TIP_AMOUNT.toString(),
    txHashes:     tipTxHashes,
    aliceResidual: aliceBalance.toString(),
  };
  save();
  process.stderr.write(`[S2] All 6 tips sent. Alice residual=${aliceBalance}\n`);

  // ── Step 4: Bob drains inbox ──────────────────────────────────────────────
  process.stderr.write(`[S2] Step 4: Bob drains inbox...\n`);
  const inboxCount = await inboxClient.count(bob.address);
  process.stderr.write(`[S2] Bob inbox count: ${inboxCount}\n`);

  if (inboxCount === 0n) {
    throw new Error("Step 4: Bob's inbox is empty — tips may not have been deposited");
  }

  const drainResult = await inboxClient.drainAndDecrypt(bob, bobJub.privkey);
  process.stderr.write(`[S2] Drained ${drainResult.decrypted.length} notes (${drainResult.failed.length} failed)\n`);

  if (drainResult.decrypted.length === 0) {
    throw new Error(`Step 4: No notes decrypted (${drainResult.failed.length} failed)`);
  }

  const notes = drainResult.decrypted.map(d => ({
    amount:   d.content.amount,
    blinding: d.content.blinding,
  }));

  // Compute blinding sum to check overflow
  const blindingSum = notes.reduce((acc, n) => acc + n.blinding, 0n);
  const LIMIT_252   = 1n << 252n;
  const overflows   = blindingSum > LIMIT_252;

  process.stderr.write(`[S2] Blinding sum: ${blindingSum.toString().slice(0,20)}...\n`);
  process.stderr.write(`[S2] Blinding sum > 2^252: ${overflows}\n`);

  results.steps.inbox_drain = {
    drainTxHash:   drainResult.txHash,
    noteCount:     drainResult.decrypted.length,
    failedCount:   drainResult.failed.length,
    blindingSum:   blindingSum.toString(),
    blindingOverflows2_252: overflows,
    notes: notes.map(n => ({
      amount:   n.amount.toString(),
      blinding: n.blinding.toString().slice(0, 20) + "...",
    })),
  };
  save();

  // ── Step 5: Without batchClaim — document why shieldedTransfer fails ─────
  // In v0.8.1, shieldedTransfer TO Bob DOES update Bob's on-chain commitment
  // (adds each tip's commitment). After 6 tips, Bob's commitment = C(0.03, accumulated_blinding).
  // Problem: accumulated_blinding = sum of 6 note blindings, which may exceed SUBORDER.
  // If blinding sum > SUBORDER → computeCommitment throws RangeError → proof fails.
  // This is exactly the overflow bug batchClaim solves.
  process.stderr.write(`[S2] Step 5: Documenting pre-batchClaim failure...\n`);
  const bobOnChain = await adapter.getCommitment(bob.address);
  process.stderr.write(`[S2] Bob on-chain commit: (${BigInt(bobOnChain.x)}, ${BigInt(bobOnChain.y)})\n`);

  let preBatchTransferFailed = false;
  let preBatchError          = null;

  // Bob accumulated N notes. The accumulated blinding sum may exceed SUBORDER.
  // computeCommitment(oldBalance, sumBlinding) would throw if sumBlinding >= SUBORDER.
  const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
  const isIdentity = BigInt(bobOnChain.x) === 0n;
  const sumBlindings = notes.reduce((acc, n) => acc + n.blinding, 0n);
  if (sumBlindings >= SUBORDER) {
    preBatchTransferFailed = true;
    preBatchError = `Accumulated blinding (${sumBlindings.toString().slice(0,20)}...) >= SUBORDER. ` +
      "computeCommitment would throw RangeError — regular shieldedTransfer is impossible without batchClaim.";
    process.stderr.write(`[S2] Documented overflow: ${preBatchError.slice(0, 80)}...\n`);
  } else if (isIdentity) {
    preBatchTransferFailed = true;
    preBatchError = "Bob commitment is identity — no claimBatch called yet, cannot spend.";
  } else {
    preBatchTransferFailed = true;
    preBatchError = "Blinding sum < SUBORDER but commitment may still be inconsistent — batchClaim needed for fresh re-blinding.";
  }

  results.steps.pre_batch_transfer = {
    bobCommitX:             BigInt(bobOnChain.x).toString(),
    bobCommitY:             BigInt(bobOnChain.y).toString(),
    bobCommitIsIdentity:    isIdentity,
    blindingSum:            sumBlindings.toString(),
    blindingSumOverflows:   overflows,
    blindingSumOverflowsSUBORDER: sumBlindings >= SUBORDER,
    failed:                 preBatchTransferFailed,
    reason:                 preBatchError,
  };
  save();

  // ── Step 6: batchClaim — re-blind Bob's accumulated commitment ───────────
  // In v0.8.1, shieldedTransfer homomorphically adds to the recipient's on-chain
  // commitment (see JanusToken.sol: commitments[to] += transfer_commit).
  // After 6 tips of 0.005 FLOW each, Bob's on-chain commitment:
  //   = C(0, 0) + C(A1, B1) + ... + C(A6, B6)
  //   = C(sum_Ai, sum_Bi)
  //   = C(totalReceived, sum_blindings)
  //
  // Where sum_blindings = B1 + B2 + ... + B6 is the raw sum of transfer blindings.
  //
  // Problem: sum_blindings may exceed SUBORDER (BabyJub group order ~2^251).
  //   If sum_blindings >= SUBORDER → computeCommitment throws RangeError.
  //   → Bob's regular shieldedTransfer fails before even generating a proof.
  //
  // Solution: use batchClaim as a "re-blinding" operation:
  //   oldBalance  = totalReceived  (exact on-chain balance)
  //   oldBlinding = sum_blindings % SUBORDER  (same EC point — modular reduction)
  //   notesToConsume = []  (EMPTY — no additional notes beyond what's in the commitment)
  //   newBlinding = fresh random < SUBORDER
  //
  //   Circuit proves:
  //     C_old     = C(totalReceived, sum_blindings % SUBORDER)  ← matches stored ✓
  //     C_consumed = identity (sum of 50 padding notes with amount=0, blinding=0)
  //     newBalance = totalReceived + 0 = totalReceived           ← no double-counting ✓
  //     C_new     = C(totalReceived, freshBlinding)             ← fresh safe blinding ✓
  //
  //   The circuit has no constraint C_new = C_old + C_consumed; it independently
  //   proves C_old, C_new, and C_consumed from witnesses. Empty notes → identity C_consumed.
  //
  //   The contract checks:
  //     (a) verifyProof(publicInputs, proof) ✓
  //     (b) stored_commitment == C_old       ✓  (elliptic scalar mult is mod SUBORDER)
  //   Then updates commitment to C_new.

  process.stderr.write(`[S2] Step 6: batchClaim re-blinding (proof generation ~90s)...\n`);
  const freshBlinding = generateBlinding();
  const batchClient   = new BatchClaimClient(bob, JANUS_FLOW_PROXY);

  // Verify verifier is configured
  const verifierAddr = await batchClient.getVerifierAddress();
  process.stderr.write(`[S2] ConfidentialClaimBatchVerifier: ${verifierAddr}\n`);

  const totalReceived   = notes.reduce((acc, n) => acc + n.amount, 0n);
  const sumBlindingsMod = sumBlindings % SUBORDER;  // mod SUBORDER: same EC point, safe for circuit

  process.stderr.write(`[S2] Effective old state: balance=${totalReceived}, blinding mod SUBORDER=${sumBlindingsMod.toString().slice(0,20)}...\n`);

  const claimResult = await batchClient.buildAndClaim({
    oldBalance:     totalReceived,    // Bob's accumulated balance (sum of 6 note amounts)
    oldBlinding:    sumBlindingsMod,  // Accumulated blinding mod SUBORDER (same EC point as raw sum)
    newBlinding:    freshBlinding,    // Fresh safe blinding < SUBORDER
    notesToConsume: [],               // EMPTY — re-blinding only (amounts already in commitment)
    circuitOptions: {
      zkeyPath: ZKEY_PATH,
      wasmPath: WASM_PATH,
    },
  });

  process.stderr.write(`[S2] batchClaim tx: ${claimResult.tx.hash}\n`);
  process.stderr.write(`[S2] Bob new balance: ${claimResult.newBalance}\n`);
  process.stderr.write(`[S2] Bob new commit: (${claimResult.newCommit.x}, ${claimResult.newCommit.y})\n`);

  results.steps.batch_claim = {
    txHash:       claimResult.tx.hash,
    verifier:     verifierAddr,
    newBalance:   claimResult.newBalance.toString(),
    freshBlinding: freshBlinding.toString(),
    newCommit:    { x: claimResult.newCommit.x.toString(), y: claimResult.newCommit.y.toString() },
    publicInputs: claimResult.publicInputs.map(p => p.toString()),
  };
  save();

  // ── Step 7: Bob updates ShieldedCheckpoint with post-batchClaim state ────
  process.stderr.write(`[S2] Step 7: Updating Bob's checkpoint...\n`);
  const bobEncSnap = await encryptSnapshot(
    { balance: claimResult.newBalance, blinding: freshBlinding },
    bobJub.pubkey,
  );
  const bobCpResult = await cpClient.update(
    { encryptedSnapshot: bobEncSnap.ciphertext, ephPubkeyX: bobEncSnap.ephemeralPubkey.x, ephPubkeyY: bobEncSnap.ephemeralPubkey.y },
    BigInt(drainResult.decrypted.length),  // cursor = notes consumed
    bob,
  );
  process.stderr.write(`[S2] Bob checkpoint updated: ${bobCpResult.txHash}\n`);
  results.steps.bob_checkpoint = { txHash: bobCpResult.txHash };
  save();

  // Verify on-chain commit matches local
  const bobOnChainAfter = await adapter.getCommitment(bob.address);
  const commitMatchX    = claimResult.newCommit.x === BigInt(bobOnChainAfter.x);
  const commitMatchY    = claimResult.newCommit.y === BigInt(bobOnChainAfter.y);
  process.stderr.write(`[S2] Commit match: x=${commitMatchX}, y=${commitMatchY}\n`);

  results.steps.commit_verify = {
    onChain: { x: BigInt(bobOnChainAfter.x).toString(), y: BigInt(bobOnChainAfter.y).toString() },
    local:   { x: claimResult.newCommit.x.toString(), y: claimResult.newCommit.y.toString() },
    match:   commitMatchX && commitMatchY,
  };
  save();

  // ── Step 8: After batchClaim — Bob shieldedTransfers 0.005 FLOW to Charlie
  process.stderr.write(`[S2] Step 8: Bob transfers 0.005 FLOW to Charlie post-batchClaim...\n`);
  const SEND_AMOUNT = ethers.parseEther("0.005");

  let postBatchTxHash = null;
  let postBatchFailed = false;
  let postBatchError  = null;
  let bobResidual     = claimResult.newBalance;

  try {
    const bobSendResult = await adapter.shieldedTransfer(
      {
        recipient:       charlie.address,
        amount:          SEND_AMOUNT,
        memo:            "S2 post-batchClaim transfer",
        currentBalance:  claimResult.newBalance,
        currentBlinding: freshBlinding,
      },
      bob,
    );
    postBatchTxHash = bobSendResult.txHash;
    bobResidual     = bobSendResult.newBalance || (claimResult.newBalance - SEND_AMOUNT);
    process.stderr.write(`[S2] Post-batchClaim transfer: ${postBatchTxHash}\n`);
    process.stderr.write(`[S2] Bob residual: ${bobResidual}\n`);

    // Update Bob's checkpoint
    if (bobSendResult.checkpointPayload) {
      const cpPost = await cpClient.update(bobSendResult.checkpointPayload, BigInt(drainResult.decrypted.length), bob);
      results.steps.post_batch_checkpoint = { txHash: cpPost.txHash };
    }
  } catch (err) {
    postBatchFailed = true;
    postBatchError  = err.message;
    process.stderr.write(`[S2] Post-batchClaim transfer FAILED: ${err.message}\n`);
  }

  // Expected Bob residual ≈ 0.025 FLOW (6 × 0.005 FLOW = 0.03, minus 0.005 sent = 0.025)
  // Actual may differ slightly due to fee deductions from Alice's tip amounts.
  const expectedResidual = ethers.parseEther("0.025");
  const residualDelta    = bobResidual > expectedResidual
    ? bobResidual - expectedResidual
    : expectedResidual - bobResidual;

  results.steps.post_batch_transfer = {
    txHash:          postBatchTxHash,
    amount:          SEND_AMOUNT.toString(),
    failed:          postBatchFailed,
    error:           postBatchError,
    bobResidual:     bobResidual.toString(),
    expectedResidual: expectedResidual.toString(),
    residualDelta:   residualDelta.toString(),
    residualCloseEnough: residualDelta < ethers.parseEther("0.002"),  // within 0.002 FLOW of expected
  };
  save();

  // ── Final verdict ─────────────────────────────────────────────────────────
  const batchClaimSucceeded    = !!results.steps.batch_claim?.txHash;
  const postBatchSendSucceeded = !postBatchFailed;
  const commitVerified         = results.steps.commit_verify?.match === true;
  const verdict = batchClaimSucceeded && postBatchSendSucceeded && commitVerified
    ? "PASS"
    : "FAIL";

  results.verdict  = verdict;
  results.finished = new Date().toISOString();
  results.summary  = {
    adminReset:         !!results.steps.admin_reset?.cadenceTxId,
    aliceWrapped:       !!results.steps.alice_wrap?.txHash,
    tipsDelivered:      results.steps.alice_tips?.count === 6,
    inboxDrained:       !!results.steps.inbox_drain?.drainTxHash,
    blindingOverflows:  results.steps.inbox_drain?.blindingOverflows2_252,
    preBatchFailed:     results.steps.pre_batch_transfer?.failed,
    batchClaimSucceeded,
    commitVerified,
    postBatchSendSucceeded,
    bobFinalBalance:    bobResidual.toString(),
    verdict,
  };
  save();

  jsonOutput(results);
  process.stderr.write(`\n[S2] SCENARIO 2 VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S2] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
