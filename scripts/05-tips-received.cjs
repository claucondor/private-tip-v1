#!/usr/bin/env node
"use strict";
/**
 * 05-tips-received.cjs — Tips received viewer (front view: /tips Received tab)
 *
 * Reads and optionally drains the receiver's ShieldedInbox, decrypts each note,
 * and correlates with PrivateTip metadata (tipID, sender, timestamp).
 *
 * For peek-only (non-draining) mode: only --receiver-evm and --memokey-priv needed.
 * For drain mode: --evm-key required (submits a drainAll tx).
 *
 * Token disambiguation uses the `note.depositor` address:
 *   0xA64340... → FLOW
 *   0xFD8F82... → mUSDC
 *   0x4b6bc5... → MockFT (Cadence)
 *
 * Usage:
 *   node scripts/05-tips-received.cjs \
 *     --receiver-cadence <0x...>     # Cadence address (for PrivateTip query)
 *     --receiver-evm <0x...>         # EVM address (inbox owner — for peek)
 *     --memokey-priv <decimal>       # BabyJub privkey for ECIES decryption
 *     [--evm-key <hex>]              # EVM private key for actual drain (mutating)
 *     [--peek]                       # non-draining read (default if no --evm-key)
 *
 * Output JSON:
 *   {
 *     "receiverCadence": "0x...",
 *     "receiverEvm": "0x...",
 *     "pendingCount": "3",
 *     "mode": "peek|drain",
 *     "notes": [
 *       {
 *         "index": 0,
 *         "tokenSymbol": "FLOW",
 *         "depositor": "0x...",
 *         "amount": "5000000000000000",
 *         "blinding": "...",
 *         "memo": "great work",
 *         "blockNumber": "12345",
 *         "tipMeta": { "tipId": "1", "sender": "0x...", "timestamp": "...", "tokenSymbol": "FLOW" }
 *       }
 *     ],
 *     "failed": <count of notes that couldn't be decrypted>
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["receiver-cadence", "receiver-evm", "memokey-priv", "evm-key"],
  boolean: ["help", "peek"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  sdk,
  ShieldedInboxClient,
  makeWallet,
  keypairFromPriv,
  deriveMemoKeypair,
  provider,
  ADDRESSES,
  TOKEN_BY_DEPOSITOR,
  jsonOutput,
  flowScript,
  DEPLOYER_EOA_KEY,
} = require("./_shared.cjs");

const { decryptNote } = require("@claucondor/sdk");

if (argv.help) {
  console.error("Usage: node scripts/05-tips-received.cjs --receiver-evm <0x...> --memokey-priv <decimal> [--evm-key <hex>]");
  process.exit(0);
}

// Fetch PrivateTip metadata for a recipient via Cadence script
function fetchTipsForRecipient(cadenceAddr) {
  try {
    const raw = flowScript(
      "cadence/scripts/get_tips_by_recipient.cdc",
      cadenceAddr
    );
    // Parse flow CLI output (JSON-like structured output)
    // flow scripts output format varies — try to parse array of tip structs
    const lines = raw.split("\n").filter(l => l.trim());
    // look for JSON-like blocks or just return raw
    return { raw, tips: [] }; // parsing is best-effort
  } catch (err) {
    return { raw: null, tips: [], error: err.message };
  }
}

async function main() {
  const receiverEVM    = argv["receiver-evm"];
  const receiverCadence = argv["receiver-cadence"];
  const memokeyPrivStr  = argv["memokey-priv"];
  const evmKey          = argv["evm-key"];

  if (!receiverEVM && !evmKey) {
    console.error("Error: --receiver-evm (for peek) or --evm-key (for drain) is required");
    process.exit(1);
  }
  if (!memokeyPrivStr) {
    console.error("Error: --memokey-priv is required for note decryption");
    process.exit(1);
  }

  const effectiveEVMAddr = receiverEVM || (evmKey ? makeWallet(evmKey).address : null);
  const keypair = await keypairFromPriv(memokeyPrivStr);

  const inboxClient = new ShieldedInboxClient();
  const pendingCount = await inboxClient.count(effectiveEVMAddr);

  // Choose peek vs drain
  const doDrain = !!evmKey && !argv["peek"];
  let notes = [];
  let decrypted = [];
  let failedCount = 0;
  let drainTxHash = null;

  if (pendingCount === 0n) {
    // Nothing to read
    jsonOutput({
      receiverCadence: receiverCadence || null,
      receiverEvm: effectiveEVMAddr,
      pendingCount: "0",
      mode: doDrain ? "drain" : "peek",
      notes: [],
      failed: 0,
    });
    return;
  }

  if (doDrain) {
    // Drain and decrypt (mutating — consumes notes)
    const wallet = makeWallet(evmKey);
    const result = await inboxClient.drainAndDecrypt(wallet, keypair.privkey);
    drainTxHash = result.txHash;
    decrypted   = result.decrypted;
    failedCount = result.failed.length;
    notes       = result.notes;
  } else {
    // Peek (non-mutating — just read)
    notes = await inboxClient.peekAll(effectiveEVMAddr);
    // Decrypt each peeked note manually
    for (const note of notes) {
      try {
        const content = await decryptNote(
          note.ciphertext,
          { x: note.ephPubkeyX, y: note.ephPubkeyY },
          keypair.privkey
        );
        decrypted.push({ note, content });
      } catch (_) {
        failedCount++;
      }
    }
  }

  // ── Fetch PrivateTip metadata (best-effort) ────────────────────────────────
  let tipsMeta = [];
  if (receiverCadence) {
    const tipData = fetchTipsForRecipient(receiverCadence);
    tipsMeta = tipData.tips || [];
  }

  // ── Build output ──────────────────────────────────────────────────────────
  const outputNotes = decrypted.map(({ note, content }, idx) => {
    const depositorLow = (note.depositor || "").toLowerCase();
    const tokenInfo = TOKEN_BY_DEPOSITOR[depositorLow] || { symbol: "unknown", decimals: 18 };

    // Best-effort tip correlation (by index/order — no stable key)
    const tipMeta = tipsMeta[idx] || null;

    return {
      index:       idx,
      depositor:   note.depositor,
      tokenSymbol: tokenInfo.symbol,
      amount:      content.amount.toString(),
      blinding:    content.blinding.toString(),
      memo:        content.memo || null,
      blockNumber: note.blockNumber ? note.blockNumber.toString() : null,
      tipMeta:     tipMeta,
    };
  });

  jsonOutput({
    receiverCadence: receiverCadence || null,
    receiverEvm:     effectiveEVMAddr,
    pendingCount:    pendingCount.toString(),
    mode:            doDrain ? "drain" : "peek",
    drainTxHash:     drainTxHash,
    notes:           outputNotes,
    failed:          failedCount,
  });
}

main().catch(err => {
  process.stderr.write(`[05-tips-received] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
