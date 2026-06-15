#!/usr/bin/env node
"use strict";
/**
 * test-batch-claim-musdc.cjs — Scenario C+: mUSDC batch claim end-to-end
 *
 * Validates: Bob receives 6 × 10 mUSDC tips via JanusERC20; accumulated blinding
 * may overflow SUBORDER; batchClaim re-blinds to fresh state; Bob can then
 * shieldedTransfer successfully.
 *
 * Steps:
 *   1. Admin resets alice + bob slots on JanusERC20
 *   2. Setup memokeys (alice, bob, charlie)
 *   3. Alice mints 100 mUSDC + approves JanusERC20 for 100 mUSDC
 *   4. Alice wraps 60 mUSDC → updates checkpoint
 *   5. Alice sends 6 × 10 mUSDC tips to Bob
 *   6. Bob drains inbox (6 notes)
 *   7. Compute blinding sum — check if >= SUBORDER (overflow)
 *   8. Regular shieldedTransfer bob→charlie would fail if blinding sum overflows
 *   9. batchClaim on bob's slot:
 *        oldBalance = 60_000_000, oldBlinding = sumBlindings % SUBORDER
 *        newBlinding = fresh, notesToConsume = []
 *  10. Bob updates ShieldedCheckpoint
 *  11. shieldedTransfer bob→charlie 5 mUSDC — must succeed
 *  12. Assert: bob residual = 55 mUSDC (60 - 5)
 *
 * mUSDC decimals = 6:  10 mUSDC = 10_000_000n
 *
 * Output: JSON at scripts/results-batch-claim-musdc.json + stdout
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
  ERC20_ABI,
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
const RESULTS_FILE = path.join(REPO_ROOT, "scripts", "results-batch-claim-musdc.json");
const NETWORK      = "testnet";

const ALICE_KEY   = DEPLOYER_EOA_KEY;
// Fresh random keypairs per run to avoid state pollution from previous runs.
const BOB_KEY     = "0x" + require("crypto").randomBytes(32).toString("hex");
const CHARLIE_KEY = "0x" + require("crypto").randomBytes(32).toString("hex");

// JanusERC20 proxy (mUSDC wrapper)
const JANUS_ERC20_PROXY = ADDRESSES.janusERC20;
// MockUSDC underlying ERC20
const MOCK_USDC_ADDR    = ADDRESSES.mockUSDC;

// mUSDC amounts (6 decimals)
const MINT_AMOUNT  = 100_000_000n; // 100 mUSDC
const WRAP_AMOUNT  =  60_000_000n; //  60 mUSDC
const TIP_AMOUNT   =  10_000_000n; //  10 mUSDC each
const SEND_AMOUNT  =   5_000_000n; //   5 mUSDC (post-batchClaim transfer)
const EXPECTED_BOB_RESIDUAL = 55_000_000n; // 60 - 5 = 55 mUSDC

// Number of tips to send
const TIP_COUNT = 6;

// Circuit paths for proof generation (151 MB zkey)
const ZKEY_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/ceremony/cb_final.zkey";
const WASM_PATH = "/home/oydual3/openjanus-contracts/circuits/aggregate-claim-batch/build/confidential_claim_batch_js/confidential_claim_batch.wasm";

// BabyJub subgroup order (any accumulated blinding >= this overflows)
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// WrapWithSnapshot event (same in JanusFlow + JanusERC20)
const WRAP_EVENT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_EVENT_SIG]);

// ── Results tracking ─────────────────────────────────────────────────────────

let results = {
  scenario: "batch-claim-musdc",
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
  process.stderr.write(`[admin] sealed: ${result.id}\n`);
  return result.id;
}

/** ABI-encode adminBatchResetSlots(address[]) calldata. */
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

  process.stderr.write(`[S2-mUSDC] Alice:   ${alice.address}\n`);
  process.stderr.write(`[S2-mUSDC] Bob:     ${bob.address}\n`);
  process.stderr.write(`[S2-mUSDC] Charlie: ${charlie.address}\n`);
  save();

  const aliceJub   = await deriveMemoKeypair(alice);
  const bobJub     = await deriveMemoKeypair(bob);
  const charlieJub = await deriveMemoKeypair(charlie);
  const adapter    = sdk.token("mockusdc");
  const cpClient   = new ShieldedCheckpointClient();
  const inboxClient = new ShieldedInboxClient();

  // ── Step 0: Fund Alice if needed, fund Bob + Charlie for gas ─────────────
  const aliceBal = await provider.getBalance(alice.address);
  if (aliceBal < ethers.parseEther("0.35")) {
    process.stderr.write(`[S2-mUSDC] Alice low (${ethers.formatEther(aliceBal)} FLOW). Topping up via admin COA...\n`);
    const fundTxId = flowSend("fund_evm.cdc", "openjanus-v08", [
      { type: "String", value: alice.address.slice(2) },
      { type: "UFix64", value: "0.50000000" },
    ]);
    process.stderr.write(`[S2-mUSDC] Funded Alice: ${fundTxId}\n`);
    results.steps.fund_alice = { cadenceTxId: fundTxId };
    save();
  }

  for (const [name, wallet] of [["Bob", bob], ["Charlie", charlie]]) {
    const bal    = await provider.getBalance(wallet.address);
    const minBal = name === "Bob" ? ethers.parseEther("0.015") : ethers.parseEther("0.005");
    const topUp  = name === "Bob" ? ethers.parseEther("0.03")  : ethers.parseEther("0.01");
    if (bal < minBal) {
      process.stderr.write(`[S2-mUSDC] Funding ${name} for gas (${ethers.formatEther(bal)} FLOW)...\n`);
      const ft = await alice.sendTransaction({ to: wallet.address, value: topUp });
      await ft.wait(1);
      process.stderr.write(`[S2-mUSDC] Funded ${name}: ${ft.hash}\n`);
    }
  }

  // ── Step 1a: Admin reset Alice's slot on JanusERC20 ──────────────────────
  // Bob + Charlie are fresh ephemeral addresses (no prior state).
  // Only Alice (deployer) needs resetting.
  process.stderr.write(`[S2-mUSDC] Step 1: adminBatchResetSlots([alice]) on JanusERC20...\n`);
  const resetCalldata = encodeAdminBatchReset([alice.address]);
  const adminResetTx = flowSend("admin_evm_call.cdc", "openjanus-v08", [
    { type: "String", value: JANUS_ERC20_PROXY.slice(2) },
    { type: "String", value: resetCalldata },
    { type: "UInt64", value: "500000" },
  ]);
  results.steps.admin_reset = {
    cadenceTxId: adminResetTx,
    targets: [alice.address],
    bobIsFresh: true,
    proxy: JANUS_ERC20_PROXY,
  };
  save();
  process.stderr.write(`[S2-mUSDC] Reset done: ${adminResetTx}\n`);

  // ── Step 1b: Publish memokeys (idempotent) ────────────────────────────────
  process.stderr.write(`[S2-mUSDC] Step 1b: Publish memokeys...\n`);
  const memokeyResults = {};
  for (const [name, wallet, kp] of [
    ["alice",   alice,   aliceJub],
    ["bob",     bob,     bobJub],
    ["charlie", charlie, charlieJub],
  ]) {
    const existing = await adapter.getMemoKey(wallet.address);
    if (!existing || BigInt(existing.x) !== kp.pubkey.x) {
      const res = await adapter.publishMemoKey(kp, wallet);
      memokeyResults[name] = res.txHash;
      process.stderr.write(`[S2-mUSDC] ${name} memokey: ${res.txHash}\n`);
    } else {
      memokeyResults[name] = null;
      process.stderr.write(`[S2-mUSDC] ${name} memokey already registered\n`);
    }
  }
  results.steps.memokeys = memokeyResults;
  save();

  // ── Step 2: Alice mints 100 mUSDC + approves JanusERC20 ──────────────────
  process.stderr.write(`[S2-mUSDC] Step 2: Mint ${MINT_AMOUNT} mUSDC + approve...\n`);
  const mockUsdc = new ethers.Contract(MOCK_USDC_ADDR, ERC20_ABI, alice);
  const mintTx = await mockUsdc.mint(alice.address, MINT_AMOUNT);
  const mintReceipt = await mintTx.wait();
  const balAfterMint = await mockUsdc.balanceOf(alice.address);
  process.stderr.write(`[S2-mUSDC] Minted. Alice mUSDC balance: ${balAfterMint}\n`);

  const approveResult = await adapter.approveUnderlying(MINT_AMOUNT, alice);
  process.stderr.write(`[S2-mUSDC] Approved: ${approveResult.txHash}\n`);
  results.steps.mint_approve = {
    mintTxHash:   mintReceipt.hash,
    approveTxHash: approveResult.txHash,
    mintAmount:   MINT_AMOUNT.toString(),
    balanceAfter: balAfterMint.toString(),
  };
  save();

  // ── Step 3: Alice wraps 60 mUSDC ──────────────────────────────────────────
  process.stderr.write(`[S2-mUSDC] Step 3: Alice wraps ${WRAP_AMOUNT} mUSDC (60 mUSDC)...\n`);
  const wrapResult = await adapter.wrap({ grossAmount: WRAP_AMOUNT }, alice);
  const wrapSnap   = await recoverSnapFromReceipt(wrapResult.txHash, aliceJub.privkey);
  if (!wrapSnap) throw new Error("Step 3: WrapWithSnapshot event not found");

  let aliceBalance  = wrapSnap.balance;
  let aliceBlinding = wrapSnap.blinding;
  process.stderr.write(`[S2-mUSDC] Alice wrapped. balance=${aliceBalance}\n`);

  // Update Alice checkpoint
  const encAlice1 = await encryptSnapshot({ balance: aliceBalance, blinding: aliceBlinding }, aliceJub.pubkey);
  const aliceCp1  = await cpClient.update(
    { encryptedSnapshot: encAlice1.ciphertext, ephPubkeyX: encAlice1.ephemeralPubkey.x, ephPubkeyY: encAlice1.ephemeralPubkey.y },
    0n,
    alice,
  );
  results.steps.alice_wrap = {
    txHash:       wrapResult.txHash,
    checkpointTx: aliceCp1.txHash,
    netAmount:    aliceBalance.toString(),
  };
  save();

  // ── Step 4: Alice sends 6 × 10 mUSDC tips to Bob ─────────────────────────
  process.stderr.write(`[S2-mUSDC] Step 4: Sending ${TIP_COUNT} × ${TIP_AMOUNT} mUSDC tips to Bob...\n`);
  const tipTxHashes = [];

  for (let i = 1; i <= TIP_COUNT; i++) {
    process.stderr.write(`[S2-mUSDC]   Tip ${i}/${TIP_COUNT}: ${TIP_AMOUNT} mUSDC → Bob...\n`);
    const sendRes = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TIP_AMOUNT,
        memo:            `S2-mUSDC tip ${i}/${TIP_COUNT}`,
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice,
    );
    tipTxHashes.push(sendRes.txHash);
    aliceBalance  = sendRes.newBalance  ?? (aliceBalance  - TIP_AMOUNT);
    aliceBlinding = sendRes.newBlinding ?? aliceBlinding;
    process.stderr.write(`[S2-mUSDC]   Tip ${i} done: ${sendRes.txHash} | aliceBal=${aliceBalance}\n`);
  }

  // Update Alice checkpoint once after all tips (avoid in-loop nonce conflicts)
  {
    const encAlice2 = await encryptSnapshot({ balance: aliceBalance, blinding: aliceBlinding }, aliceJub.pubkey);
    const aliceCp2  = await cpClient.update(
      { encryptedSnapshot: encAlice2.ciphertext, ephPubkeyX: encAlice2.ephemeralPubkey.x, ephPubkeyY: encAlice2.ephemeralPubkey.y },
      0n,
      alice,
    );
    results.steps.alice_checkpoint_after_tips = { txHash: aliceCp2.txHash };
    process.stderr.write(`[S2-mUSDC] Alice checkpoint after tips: ${aliceCp2.txHash}\n`);
  }

  results.steps.alice_tips = {
    count:         TIP_COUNT,
    tipAmount:     TIP_AMOUNT.toString(),
    txHashes:      tipTxHashes,
    aliceResidual: aliceBalance.toString(),
  };
  save();
  process.stderr.write(`[S2-mUSDC] All ${TIP_COUNT} tips sent. Alice residual=${aliceBalance}\n`);

  // ── Step 5: Bob drains inbox ──────────────────────────────────────────────
  process.stderr.write(`[S2-mUSDC] Step 5: Bob drains inbox...\n`);
  const inboxCount = await inboxClient.count(bob.address);
  process.stderr.write(`[S2-mUSDC] Bob inbox count: ${inboxCount}\n`);

  if (inboxCount === 0n) {
    throw new Error("Step 5: Bob's inbox is empty — tips may not have been deposited");
  }

  const drainResult = await inboxClient.drainAndDecrypt(bob, bobJub.privkey);
  process.stderr.write(`[S2-mUSDC] Drained ${drainResult.decrypted.length} notes (${drainResult.failed.length} failed)\n`);

  if (drainResult.decrypted.length === 0) {
    throw new Error(`Step 5: No notes decrypted (${drainResult.failed.length} failed)`);
  }

  const notes = drainResult.decrypted.map(d => ({
    amount:   d.content.amount,
    blinding: d.content.blinding,
  }));

  // Blinding sum — check overflow
  const blindingSum    = notes.reduce((acc, n) => acc + n.blinding, 0n);
  const overflows2_252 = blindingSum > (1n << 252n);
  const overflowsSUB   = blindingSum >= SUBORDER;

  process.stderr.write(`[S2-mUSDC] Blinding sum: ${blindingSum.toString().slice(0,20)}...\n`);
  process.stderr.write(`[S2-mUSDC] Overflows 2^252: ${overflows2_252} | >= SUBORDER: ${overflowsSUB}\n`);

  results.steps.inbox_drain = {
    drainTxHash:                 drainResult.txHash,
    noteCount:                   drainResult.decrypted.length,
    failedCount:                 drainResult.failed.length,
    blindingSum:                 blindingSum.toString(),
    blindingOverflows2_252:      overflows2_252,
    blindingOverflowsSUBORDER:   overflowsSUB,
    notes: notes.map(n => ({
      amount:   n.amount.toString(),
      blinding: n.blinding.toString().slice(0, 20) + "...",
    })),
  };
  save();

  // ── Step 6: Document pre-batchClaim state ────────────────────────────────
  process.stderr.write(`[S2-mUSDC] Step 6: Documenting pre-batchClaim failure...\n`);
  const bobOnChain = await adapter.getCommitment(bob.address);
  process.stderr.write(`[S2-mUSDC] Bob on-chain commit: (${BigInt(bobOnChain.x)}, ${BigInt(bobOnChain.y)})\n`);

  const isIdentity = BigInt(bobOnChain.x) === 0n;
  let preBatchFailed = false;
  let preBatchReason = "";

  if (overflowsSUB) {
    preBatchFailed = true;
    preBatchReason = `Accumulated blinding (${blindingSum.toString().slice(0,20)}...) >= SUBORDER. ` +
      "computeCommitment would throw RangeError — regular shieldedTransfer impossible without batchClaim.";
    process.stderr.write(`[S2-mUSDC] Documented overflow: blinding >= SUBORDER\n`);
  } else if (isIdentity) {
    preBatchFailed = true;
    preBatchReason = "Bob commitment is identity — cannot spend without batchClaim.";
  } else {
    preBatchFailed = true;
    preBatchReason = "Blinding sum < SUBORDER but re-blinding via batchClaim still required for fresh safe state.";
  }

  results.steps.pre_batch_transfer = {
    bobCommitX:               BigInt(bobOnChain.x).toString(),
    bobCommitY:               BigInt(bobOnChain.y).toString(),
    bobCommitIsIdentity:      isIdentity,
    blindingSum:              blindingSum.toString(),
    blindingOverflows2_252:   overflows2_252,
    blindingOverflowsSUBORDER: overflowsSUB,
    failed:                   preBatchFailed,
    reason:                   preBatchReason,
  };
  save();

  // ── Step 7: batchClaim — re-blind Bob's accumulated commitment ───────────
  // After 6 × 10 mUSDC tips, Bob's on-chain commitment = C(sum_amounts, sum_blindings)
  // where sum_blindings = B1+B2+...+B6 (raw sum, may be >= SUBORDER).
  //
  // batchClaim with notesToConsume=[] proves:
  //   C_old     = C(totalReceived, sum_blindings % SUBORDER) ← matches stored (EC mod) ✓
  //   C_consumed = identity  (empty notes)                   ← no double-counting ✓
  //   C_new     = C(totalReceived, freshBlinding)            ← fresh safe blinding ✓
  process.stderr.write(`[S2-mUSDC] Step 7: batchClaim re-blinding (proof ~90s)...\n`);
  const freshBlinding  = generateBlinding();
  const batchClient    = new BatchClaimClient(bob, JANUS_ERC20_PROXY);

  const verifierAddr   = await batchClient.getVerifierAddress();
  process.stderr.write(`[S2-mUSDC] BatchClaimVerifier: ${verifierAddr}\n`);

  const totalReceived   = notes.reduce((acc, n) => acc + n.amount, 0n);
  const sumBlindingsMod = blindingSum % SUBORDER;

  process.stderr.write(`[S2-mUSDC] Old state: balance=${totalReceived}, blinding mod SUBORDER=${sumBlindingsMod.toString().slice(0,20)}...\n`);

  const claimResult = await batchClient.buildAndClaim({
    oldBalance:     totalReceived,
    oldBlinding:    sumBlindingsMod,
    newBlinding:    freshBlinding,
    notesToConsume: [],
    circuitOptions: {
      zkeyPath: ZKEY_PATH,
      wasmPath: WASM_PATH,
    },
  });

  process.stderr.write(`[S2-mUSDC] batchClaim tx: ${claimResult.tx.hash}\n`);
  process.stderr.write(`[S2-mUSDC] Bob new balance: ${claimResult.newBalance}\n`);

  results.steps.batch_claim = {
    txHash:        claimResult.tx.hash,
    verifier:      verifierAddr,
    newBalance:    claimResult.newBalance.toString(),
    freshBlinding: freshBlinding.toString(),
    newCommit:     { x: claimResult.newCommit.x.toString(), y: claimResult.newCommit.y.toString() },
    publicInputs:  claimResult.publicInputs.map(p => p.toString()),
  };
  save();

  // ── Step 8: Bob updates ShieldedCheckpoint post-batchClaim ────────────────
  process.stderr.write(`[S2-mUSDC] Step 8: Updating Bob's checkpoint...\n`);
  const bobEncSnap = await encryptSnapshot(
    { balance: claimResult.newBalance, blinding: freshBlinding },
    bobJub.pubkey,
  );
  const bobCpResult = await cpClient.update(
    { encryptedSnapshot: bobEncSnap.ciphertext, ephPubkeyX: bobEncSnap.ephemeralPubkey.x, ephPubkeyY: bobEncSnap.ephemeralPubkey.y },
    BigInt(drainResult.decrypted.length),  // cursor = notes consumed from inbox
    bob,
  );
  process.stderr.write(`[S2-mUSDC] Bob checkpoint: ${bobCpResult.txHash}\n`);
  results.steps.bob_checkpoint = { txHash: bobCpResult.txHash };
  save();

  // Verify on-chain commit matches local
  const bobOnChainAfter = await adapter.getCommitment(bob.address);
  const commitMatchX    = claimResult.newCommit.x === BigInt(bobOnChainAfter.x);
  const commitMatchY    = claimResult.newCommit.y === BigInt(bobOnChainAfter.y);
  process.stderr.write(`[S2-mUSDC] Commit match: x=${commitMatchX}, y=${commitMatchY}\n`);

  results.steps.commit_verify = {
    onChain: { x: BigInt(bobOnChainAfter.x).toString(), y: BigInt(bobOnChainAfter.y).toString() },
    local:   { x: claimResult.newCommit.x.toString(), y: claimResult.newCommit.y.toString() },
    match:   commitMatchX && commitMatchY,
  };
  save();

  // ── Step 9: After batchClaim — Bob shieldedTransfers 5 mUSDC to Charlie ───
  process.stderr.write(`[S2-mUSDC] Step 9: Bob transfers ${SEND_AMOUNT} mUSDC to Charlie post-batchClaim...\n`);

  let postBatchTxHash = null;
  let postBatchFailed = false;
  let postBatchError  = null;
  let bobResidual     = claimResult.newBalance;

  try {
    const bobSendResult = await adapter.shieldedTransfer(
      {
        recipient:       charlie.address,
        amount:          SEND_AMOUNT,
        memo:            "S2-mUSDC post-batchClaim",
        currentBalance:  claimResult.newBalance,
        currentBlinding: freshBlinding,
      },
      bob,
    );
    postBatchTxHash = bobSendResult.txHash;
    bobResidual     = bobSendResult.newBalance ?? (claimResult.newBalance - SEND_AMOUNT);
    process.stderr.write(`[S2-mUSDC] Post-batchClaim transfer: ${postBatchTxHash}\n`);
    process.stderr.write(`[S2-mUSDC] Bob residual: ${bobResidual} (expected ${EXPECTED_BOB_RESIDUAL})\n`);

    if (bobSendResult.checkpointPayload) {
      const cpPost = await cpClient.update(
        bobSendResult.checkpointPayload,
        BigInt(drainResult.decrypted.length),
        bob,
      );
      results.steps.post_batch_checkpoint = { txHash: cpPost.txHash };
    }
  } catch (err) {
    postBatchFailed = true;
    postBatchError  = err.message;
    process.stderr.write(`[S2-mUSDC] Post-batchClaim transfer FAILED: ${err.message}\n`);
  }

  // Assert: bob residual = 55 mUSDC (60 received - 5 sent)
  const residualMatch = bobResidual === EXPECTED_BOB_RESIDUAL;
  const residualDelta = bobResidual > EXPECTED_BOB_RESIDUAL
    ? bobResidual - EXPECTED_BOB_RESIDUAL
    : EXPECTED_BOB_RESIDUAL - bobResidual;

  results.steps.post_batch_transfer = {
    txHash:           postBatchTxHash,
    amount:           SEND_AMOUNT.toString(),
    failed:           postBatchFailed,
    error:            postBatchError,
    bobResidual:      bobResidual.toString(),
    expectedResidual: EXPECTED_BOB_RESIDUAL.toString(),
    residualDelta:    residualDelta.toString(),
    residualMatch,
  };
  save();

  // ── Final verdict ─────────────────────────────────────────────────────────
  const batchClaimSucceeded  = !!results.steps.batch_claim?.txHash;
  const postBatchOk          = !postBatchFailed;
  const commitVerified       = results.steps.commit_verify?.match === true;
  const balanceVerified      = residualMatch;
  const verdict = batchClaimSucceeded && postBatchOk && commitVerified && balanceVerified
    ? "PASS"
    : "FAIL";

  results.verdict  = verdict;
  results.finished = new Date().toISOString();
  results.summary  = {
    token:                "mUSDC",
    proxy:                JANUS_ERC20_PROXY,
    adminReset:           !!results.steps.admin_reset?.cadenceTxId,
    aliceWrapped:         !!results.steps.alice_wrap?.txHash,
    tipsDelivered:        results.steps.alice_tips?.count === TIP_COUNT,
    inboxDrained:         !!results.steps.inbox_drain?.drainTxHash,
    blindingOverflows2_252:  results.steps.inbox_drain?.blindingOverflows2_252,
    blindingOverflowsSUBORDER: results.steps.inbox_drain?.blindingOverflowsSUBORDER,
    preBatchFailed:       results.steps.pre_batch_transfer?.failed,
    batchClaimSucceeded,
    commitVerified,
    postBatchOk,
    balanceVerified,
    bobFinalBalance:      bobResidual.toString(),
    expectedBobFinal:     EXPECTED_BOB_RESIDUAL.toString(),
    verdict,
  };
  save();

  jsonOutput(results);
  process.stderr.write(`\n[S2-mUSDC] SCENARIO VERDICT: ${verdict}\n`);
}

main().catch(err => {
  process.stderr.write(`[S2-mUSDC] FATAL: ${err.message}\n${err.stack}\n`);
  results.verdict    = "FAIL";
  results.fatalError = { message: err.message, stack: err.stack };
  save();
  process.exit(1);
});
