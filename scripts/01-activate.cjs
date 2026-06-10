#!/usr/bin/env node
"use strict";
/**
 * 01-activate.cjs — Onboarding / Activation (front view: Activation page)
 *
 * Publishes the user's BabyJub memo key to MemoKeyRegistry, then installs
 * ShieldedInbox + ShieldedCheckpoint resources via the setup_user.cdc Cadence tx.
 *
 * All three steps are idempotent: safe to run multiple times.
 *
 * Usage (EVM+Cadence path — full PrivateTip native setup):
 *   node scripts/01-activate.cjs \
 *     --evm-key 0x<hex>          # EVM private key (used to derive BabyJub key + as direct EVM signer)
 *     --cadence-account <name>   # flow.json signer account (for Cadence setup_user tx)
 *     [--force-rotate]           # force rotate even if key already published
 *
 * Usage (EVM-only path — just register memo key on EVM, skip Cadence resources):
 *   node scripts/01-activate.cjs \
 *     --evm-key 0x<hex>          # EVM private key
 *     [--evm-only]               # skip Cadence inbox/checkpoint install
 *
 * Output JSON:
 *   {
 *     "cadenceAddr": "0x...",    // null if --evm-only
 *     "evmAddr": "0x...",
 *     "memokey": { "x": "...", "y": "...", "publishedAt": "..." },
 *     "inboxInstalled": true|false,
 *     "checkpointInstalled": true|false,
 *     "memoKeyTx": "0x..."       // EVM tx hash (or null if already published)
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["evm-key", "cadence-account"],
  boolean: ["evm-only", "force-rotate", "help"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  sdk,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  provider,
  ADDRESSES,
  MEMO_REGISTRY_ABI,
  jsonOutput,
  flowTx,
  buildArgs,
} = require("./_shared.cjs");

if (argv.help) {
  console.error("Usage: node scripts/01-activate.cjs --evm-key <hex> [--cadence-account <name>] [--evm-only]");
  process.exit(0);
}

async function main() {
  const evmKey = argv["evm-key"];
  if (!evmKey) {
    console.error("Error: --evm-key is required");
    process.exit(1);
  }

  const cadenceAccount = argv["cadence-account"];
  const evmOnly        = argv["evm-only"] || !cadenceAccount;
  const forceRotate    = argv["force-rotate"] || false;

  // ── 1. Build EVM wallet + derive BabyJub keypair ────────────────────────
  const wallet   = makeWallet(evmKey);
  const keypair  = await deriveMemoKeypair(wallet);
  const { pubkey } = keypair;

  // ── 2. Read current MemoKeyRegistry state ───────────────────────────────
  const registry    = new ethers.Contract(ADDRESSES.memoRegistry, MEMO_REGISTRY_ABI, provider);
  const currentKey  = await registry.getMemoKey(wallet.address);
  const publishedAt = BigInt(currentKey.publishedAt);
  const alreadySet  = publishedAt > 0n;
  const sameKey     = alreadySet
    && BigInt(currentKey.x) === pubkey.x
    && BigInt(currentKey.y) === pubkey.y;

  let memoKeyTx = null;

  // ── 3. Publish or rotate memo key ───────────────────────────────────────
  if (!alreadySet) {
    // First publication — use adapter.publishMemoKey (handles EVM tx)
    const flowAdapter = sdk.token("flow");
    const result = await flowAdapter.publishMemoKey(keypair, wallet);
    memoKeyTx = result.txHash;
  } else if (!sameKey || forceRotate) {
    // Key exists but different (or force rotate)
    const regWithSigner = new ethers.Contract(ADDRESSES.memoRegistry, MEMO_REGISTRY_ABI, wallet);
    const tx = await regWithSigner.rotateMemoKey(pubkey.x, pubkey.y);
    await tx.wait(1);
    memoKeyTx = tx.hash;
  } else {
    // Key already published and matches — idempotent skip
    memoKeyTx = null;
  }

  // Re-read the published key
  const confirmedKey = await registry.getMemoKey(wallet.address);

  // ── 4. Install Inbox + Checkpoint via Cadence setup_user tx ─────────────
  let inboxInstalled      = false;
  let checkpointInstalled = false;
  let cadenceAddr         = null;
  let cadenceTxId         = null;

  if (!evmOnly && cadenceAccount) {
    // Build calldata for MemoKeyRegistry.publishMemoKey — even if we already
    // published above, passing "" to setup_user.cdc skips the EVM call.
    // Here we always pass "" since we handled memo key registration above via EVM.
    const gasLimit = 100000;
    const calldata = ""; // skip re-registration from Cadence side (already done above)

    try {
      const result = flowTx(
        "cadence/transactions/setup_user.cdc",
        cadenceAccount,
        buildArgs([
          { type: "String", value: calldata },
          { type: "UInt64",  value: String(gasLimit) },
        ])
      );
      cadenceTxId    = result.txId;
      inboxInstalled      = true;
      checkpointInstalled = true;

      // Derive Cadence address from account name via flow.json lookup
      try {
        const { execSync } = require("child_process");
        const raw = execSync(
          `flow accounts get ${cadenceAccount} --network testnet 2>&1`,
          { cwd: "/home/oydual3/zkapps/private-tip-v1", encoding: "utf8" }
        );
        const match = raw.match(/Address\s+([0-9a-fx]+)/i);
        cadenceAddr = match ? match[1] : cadenceAccount;
      } catch (_) {
        cadenceAddr = cadenceAccount;
      }
    } catch (err) {
      // If it fails, report but don't throw — partial success is ok
      process.stderr.write(`[warn] Cadence setup_user failed: ${err.message}\n`);
    }
  }

  // ── 5. Output ─────────────────────────────────────────────────────────────
  jsonOutput({
    evmAddr:            wallet.address,
    cadenceAddr:        cadenceAddr,
    memokey: {
      x:           BigInt(confirmedKey.x).toString(),
      y:           BigInt(confirmedKey.y).toString(),
      publishedAt: BigInt(confirmedKey.publishedAt).toString(),
    },
    memoKeyTx:          memoKeyTx,
    inboxInstalled:     inboxInstalled,
    checkpointInstalled:checkpointInstalled,
    cadenceTxId:        cadenceTxId,
  });
}

main().catch(err => {
  process.stderr.write(`[01-activate] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
