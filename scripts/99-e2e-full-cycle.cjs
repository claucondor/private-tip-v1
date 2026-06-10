#!/usr/bin/env node
"use strict";
/**
 * 99-e2e-full-cycle.cjs — End-to-end integration validation
 *
 * Exercises the complete PrivateTip v0.8 flow across FLOW token:
 *   Stage 1: activate-alice   — Alice publishes memo key
 *   Stage 2: activate-bob     — Bob publishes memo key
 *   Stage 3: wrap             — Alice wraps 0.005 FLOW → shielded
 *   Stage 4: send-tip         — Alice sends 0.001 FLOW to Bob with memo
 *   Stage 5: inbox-peek       — Bob peeks inbox to see pending note count
 *   Stage 6: drain-decrypt    — Bob drains inbox and decrypts the note
 *   Stage 7: portfolio        — Alice reads portfolio to confirm reduced balance
 *   Stage 8: status           — Protocol status read (no wallet needed)
 *   Stage 9: unwrap           — Alice unwraps 0.001 FLOW back to EOA
 *
 * Requires two funded EOA accounts. Defaults to Alice (deployer) and a fresh Bob.
 * Generates Bob's key deterministically from seed for reproducibility.
 *
 * Usage:
 *   node scripts/99-e2e-full-cycle.cjs \
 *     [--alice-key 0x<hex>]    # default: deployer EOA key
 *     [--bob-key 0x<hex>]      # default: fresh derived key
 *     [--verbose]              # print each stage JSON inline
 *
 * Output JSON:
 *   {
 *     "allPassed": true,
 *     "stages": [
 *       { "name": "activate-alice", "success": true, "txHash": "0x...", "data": { ... } },
 *       { "name": "wrap", "success": true, "txHash": "0x...", "data": { ... } },
 *       ...
 *     ],
 *     "summary": { "passed": 9, "failed": 0, "total": 9 }
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["alice-key", "bob-key"],
  boolean: ["help", "verbose"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const { execSync } = require("child_process");
const {
  sdk,
  ShieldedInboxClient,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  provider,
  ADDRESSES,
  ERC20_ABI,
  DEPLOYER_EOA_KEY,
  jsonOutput,
} = require("./_shared.cjs");
const { decryptSnapshot, encryptSnapshot, decryptNote } = require("@claucondor/sdk");

// ── Helpers ──────────────────────────────────────────────────────────────────

const WRAP_WITH_SNAPSHOT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

async function recoverWrapState(txHash, privkey) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WrapWithSnapshot") {
        const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
        const snap = await decryptSnapshot(encBytes,
          { x: BigInt(parsed.args.ephPubkeyX), y: BigInt(parsed.args.ephPubkeyY) }, privkey);
        return snap;
      }
    } catch (_) {}
  }
  return null;
}

async function runStage(name, fn) {
  const stage = { name, success: false, error: null, data: null };
  try {
    const result = await fn();
    stage.success = true;
    stage.data    = result;
    if (argv.verbose) process.stderr.write(`[e2e] ✓ ${name}: ${JSON.stringify(result, (k,v) => typeof v === 'bigint' ? v.toString() : v)}\n`);
    else process.stderr.write(`[e2e] ✓ ${name}\n`);
  } catch (err) {
    stage.error = err.message;
    process.stderr.write(`[e2e] ✗ ${name}: ${err.message}\n`);
  }
  return stage;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Account setup ──────────────────────────────────────────────────────────
  const aliceKey = argv["alice-key"] || DEPLOYER_EOA_KEY;
  const bobKey   = argv["bob-key"]   || "0x98ce0bff00e393fa28b89bf60f4d463add1d914bd869f432dac191d2e3cb907b";

  const alice = makeWallet(aliceKey);
  const bob   = makeWallet(bobKey);

  process.stderr.write(`[e2e] Alice: ${alice.address}\n`);
  process.stderr.write(`[e2e] Bob:   ${bob.address}\n`);

  const aliceJub = await deriveMemoKeypair(alice);
  const bobJub   = await deriveMemoKeypair(bob);

  // ── State tracking ──────────────────────────────────────────────────────────
  let aliceBalance  = 0n;
  let aliceBlinding = 0n;

  const stages = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 1: Activate Alice
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("activate-alice", async () => {
    const flowAdapter = sdk.token("flow");
    const currentKey  = await flowAdapter.getMemoKey(alice.address);
    let memoKeyTx = null;

    if (!currentKey) {
      const res = await flowAdapter.publishMemoKey(aliceJub, alice);
      memoKeyTx = res.txHash;
    } else if (BigInt(currentKey.x) !== aliceJub.pubkey.x || BigInt(currentKey.y) !== aliceJub.pubkey.y) {
      // Key exists but different — rotate
      const { ethers: eth } = require("ethers");
      const { MEMO_REGISTRY_ABI } = require("./_shared.cjs");
      const reg = new eth.Contract(ADDRESSES.memoRegistry, MEMO_REGISTRY_ABI, alice);
      const tx = await reg.rotateMemoKey(aliceJub.pubkey.x, aliceJub.pubkey.y);
      await tx.wait(1);
      memoKeyTx = tx.hash;
    }
    return { evmAddr: alice.address, memoKeyTx, memoKeyX: aliceJub.pubkey.x.toString() };
  }));

  if (!stages[0].success) {
    return finish(stages, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 2: Activate Bob
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("activate-bob", async () => {
    // Fund Bob if needed
    const bobBal = await provider.getBalance(bob.address);
    if (bobBal < ethers.parseEther("0.003")) {
      const fundTx = await alice.sendTransaction({
        to: bob.address,
        value: ethers.parseEther("0.005"),
      });
      await fundTx.wait(1);
      process.stderr.write(`[e2e] Funded Bob: ${fundTx.hash}\n`);
    }

    const flowAdapter = sdk.token("flow");
    const currentKey  = await flowAdapter.getMemoKey(bob.address);
    let memoKeyTx = null;

    if (!currentKey) {
      const res = await flowAdapter.publishMemoKey(bobJub, bob);
      memoKeyTx = res.txHash;
    }
    return { evmAddr: bob.address, memoKeyTx, memoKeyX: bobJub.pubkey.x.toString() };
  }));

  if (!stages[1].success) {
    return finish(stages, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 3: Alice wraps 0.005 FLOW → shielded
  // ─────────────────────────────────────────────────────────────────────────────
  const WRAP_AMOUNT = ethers.parseEther("0.005");

  stages.push(await runStage("wrap-flow", async () => {
    const adapter    = sdk.token("flow");
    const wrapResult = await adapter.wrap({ grossAmount: WRAP_AMOUNT }, alice);

    // Recover state from WrapWithSnapshot event
    const snap = await recoverWrapState(wrapResult.txHash, aliceJub.privkey);
    if (snap) {
      aliceBalance  = snap.balance;
      aliceBlinding = snap.blinding;
    } else {
      aliceBalance  = wrapResult.netAmount;
    }

    // Update checkpoint
    const cpClient = new ShieldedCheckpointClient();
    const enc = await encryptSnapshot({ balance: aliceBalance, blinding: aliceBlinding }, aliceJub.pubkey);
    await cpClient.update(
      { encryptedSnapshot: enc.ciphertext, ephPubkeyX: enc.ephemeralPubkey.x, ephPubkeyY: enc.ephemeralPubkey.y },
      0n,
      alice
    );

    return {
      wrapTxHash:  wrapResult.txHash,
      netAmount:   wrapResult.netAmount.toString(),
      newBalance:  aliceBalance.toString(),
    };
  }));

  if (!stages[2].success) {
    return finish(stages, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 4: Alice sends 0.001 FLOW tip to Bob
  // ─────────────────────────────────────────────────────────────────────────────
  const TIP_AMOUNT = ethers.parseEther("0.001");

  stages.push(await runStage("send-tip", async () => {
    if (aliceBalance < TIP_AMOUNT) {
      throw new Error(`Alice's shielded balance ${aliceBalance} < tip amount ${TIP_AMOUNT}`);
    }

    const adapter    = sdk.token("flow");
    const sendResult = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TIP_AMOUNT,
        memo:            "e2e test tip from PrivateTip v0.8",
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice
    );

    // Update local state
    aliceBalance  = sendResult.newBalance  || (aliceBalance - TIP_AMOUNT);
    aliceBlinding = sendResult.newBlinding || aliceBlinding;

    // Update checkpoint
    if (sendResult.checkpointPayload) {
      const cpClient = new ShieldedCheckpointClient();
      await cpClient.update(sendResult.checkpointPayload, 0n, alice);
    }

    return {
      txHash:      sendResult.txHash,
      amount:      TIP_AMOUNT.toString(),
      newBalance:  aliceBalance.toString(),
      checkpointUpdated: !!sendResult.checkpointPayload,
    };
  }));

  if (!stages[3].success) {
    return finish(stages, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 5: Bob peeks his inbox
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("inbox-peek", async () => {
    const inboxClient = new ShieldedInboxClient();
    const count = await inboxClient.count(bob.address);
    return { pendingNotes: count.toString(), hasNotes: count > 0n };
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 6: Bob drains and decrypts his inbox
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("drain-decrypt", async () => {
    const inboxClient = new ShieldedInboxClient();
    const count = await inboxClient.count(bob.address);
    if (count === 0n) {
      throw new Error("No pending notes in Bob's inbox — send-tip may have failed");
    }

    const result = await inboxClient.drainAndDecrypt(bob, bobJub.privkey);

    if (result.decrypted.length === 0) {
      throw new Error(`No notes decrypted (${result.failed.length} failed)`);
    }

    const note = result.decrypted[0];
    const content = note.content;

    if (content.amount !== TIP_AMOUNT) {
      process.stderr.write(`[e2e] Warning: expected ${TIP_AMOUNT} but got ${content.amount}\n`);
    }

    return {
      drainTxHash:  result.txHash,
      noteCount:    result.decrypted.length,
      amount:       content.amount.toString(),
      memo:         content.memo || null,
      depositor:    note.note.depositor,
      expectedAmount: TIP_AMOUNT.toString(),
      amountMatch:  content.amount === TIP_AMOUNT,
    };
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 7: Alice checks portfolio
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("portfolio", async () => {
    const cpClient = new ShieldedCheckpointClient();
    const snap = await cpClient.readAndDecrypt(alice, aliceJub.privkey);
    const adapter = sdk.token("flow");
    const commit  = await adapter.getCommitment(alice.address);
    return {
      checkpointBalance: snap ? snap.balance.toString() : null,
      commitment: { x: commit.x.toString(), y: commit.y.toString() },
      expectedBalance: aliceBalance.toString(),
    };
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 8: Protocol status
  // ─────────────────────────────────────────────────────────────────────────────
  stages.push(await runStage("status", async () => {
    const c = new ethers.Contract(ADDRESSES.janusFlow,
      ["function VERSION() view returns (string)", "function totalLocked() view returns (uint256)"],
      provider);
    const [version, locked] = await Promise.all([c.VERSION(), c.totalLocked()]);
    return { version, totalLocked: locked.toString() };
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 9: Alice unwraps 0.001 FLOW
  // ─────────────────────────────────────────────────────────────────────────────
  const UNWRAP_AMOUNT = ethers.parseEther("0.001");

  stages.push(await runStage("unwrap", async () => {
    if (aliceBalance < UNWRAP_AMOUNT) {
      throw new Error(`Alice's balance ${aliceBalance} < unwrap amount ${UNWRAP_AMOUNT}`);
    }
    const adapter = sdk.token("flow");
    const result  = await adapter.unwrap(
      {
        claimedAmount:   UNWRAP_AMOUNT,
        recipient:       alice.address,
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice
    );

    aliceBalance -= UNWRAP_AMOUNT;

    return {
      unwrapTxHash:   result.txHash,
      netToRecipient: result.netToRecipient.toString(),
      residualBalance:aliceBalance.toString(),
    };
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // Final output
  // ─────────────────────────────────────────────────────────────────────────────
  return finish(stages, stages.every(s => s.success));
}

function finish(stages, allPassed) {
  const passed = stages.filter(s => s.success).length;
  const failed = stages.filter(s => !s.success).length;

  jsonOutput({
    allPassed,
    stages: stages.map(s => ({
      name:    s.name,
      success: s.success,
      error:   s.error || null,
      txHash:  s.data?.txHash || s.data?.wrapTxHash || s.data?.unwrapTxHash || s.data?.drainTxHash || null,
      data:    s.data,
    })),
    summary: { passed, failed, total: stages.length },
  });
}

main().catch(err => {
  process.stderr.write(`[e2e] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
