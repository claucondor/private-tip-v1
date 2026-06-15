#!/usr/bin/env node
"use strict";
/**
 * 06-tips-sent.cjs — Tips sent viewer (front view: /tips Sent tab)
 *
 * Lists tips sent by the user, combining:
 *   - PrivateTip on-chain metadata (tipID, recipient, token, timestamp)
 *   - Sender checkpoint state (latest balance/blinding — amounts NOT per-tx)
 *
 * Note on amounts: PrivateTip does NOT store amounts (privacy by design).
 * The encrypted notes go to the recipient's inbox, not recorded publicly.
 * Amounts from the checkpoint reflect the CURRENT residual balance, not per-tx.
 *
 * Usage:
 *   node scripts/06-tips-sent.cjs \
 *     --sender-cadence <0x...>   # Cadence address of the sender
 *     [--evm-key <hex>]          # EVM key for checkpoint read
 *     [--memokey-priv <decimal>] # BabyJub privkey; derived from --evm-key if omitted
 *
 * Output JSON:
 *   {
 *     "senderCadence": "0x...",
 *     "tipsSent": [
 *       {
 *         "tipId": "1",
 *         "recipient": "0x...",
 *         "tokenSymbol": "FLOW",
 *         "tokenContract": "0x...",
 *         "timestamp": "1748000000"
 *       }
 *     ],
 *     "totalSent": "3",
 *     "currentShieldedState": {
 *       "balance": "...",
 *       "blinding": "..."
 *     }
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["sender-cadence", "evm-key", "memokey-priv"],
  boolean: ["help"],
  alias: { h: "help" },
});

const {
  sdk,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  jsonOutput,
  flowScript,
} = require("./_shared.cjs");

if (argv.help) {
  console.error("Usage: node scripts/06-tips-sent.cjs --sender-cadence <0x...> [--evm-key <hex>]");
  process.exit(0);
}

// Parse flow CLI script output for TipMetadata array
// flow returns: "Result: [A.4b6bc58bc8bf5dcc.PrivateTip.TipMetadata(...), ...]"
function parseTipMetadataOutput(raw) {
  const tips = [];
  if (!raw) return tips;

  // Match TipMetadata struct fields
  const tipPattern = /TipMetadata\(id:\s*(\d+),\s*sender:\s*([\w.]+),\s*recipient:\s*([\w.]+),\s*tokenContract:\s*"([^"]+)",\s*tokenSymbol:\s*"([^"]+)",\s*timestamp:\s*(\d+)\)/g;
  let match;
  while ((match = tipPattern.exec(raw)) !== null) {
    tips.push({
      tipId:         match[1],
      sender:        match[2],
      recipient:     match[3],
      tokenContract: match[4],
      tokenSymbol:   match[5],
      timestamp:     match[6],
    });
  }

  // Empty result is valid — no tips sent yet
  return tips;
}

async function main() {
  const senderCadence = argv["sender-cadence"];
  const evmKey        = argv["evm-key"];

  if (!senderCadence) {
    console.error("Error: --sender-cadence is required");
    process.exit(1);
  }

  // ── 1. Query PrivateTip.getTipsBySender ──────────────────────────────────
  let tipsSent = [];
  try {
    const raw = flowScript(
      "cadence/scripts/get_tips_by_sender.cdc",
      senderCadence
    );
    tipsSent = parseTipMetadataOutput(raw);
  } catch (err) {
    process.stderr.write(`[06-tips-sent] Warning: PrivateTip query failed: ${err.message}\n`);
  }

  // ── 2. Read current ShieldedCheckpoint (optional) ────────────────────────
  let currentState = null;
  if (evmKey) {
    const wallet  = makeWallet(evmKey);
    const keypair = argv["memokey-priv"]
      ? await keypairFromPriv(argv["memokey-priv"])
      : await deriveMemoKeypair(wallet);
    const cpClient = new ShieldedCheckpointClient();
    try {
      const snap = await cpClient.readAndDecrypt(wallet, keypair.privkey);
      if (snap) {
        currentState = {
          balance:  snap.balance.toString(),
          blinding: snap.blinding.toString(),
          note: "Residual sender balance after all transfers. Per-tx amounts are encrypted in recipient inboxes.",
        };
      }
    } catch (_) {
      currentState = { note: "Checkpoint not found or decryption failed" };
    }
  }

  // ── 3. Output ─────────────────────────────────────────────────────────────
  jsonOutput({
    senderCadence,
    tipsSent,
    totalSent: tipsSent.filter(t => !t.raw).length.toString(),
    currentShieldedState: currentState,
    privacyNote: "Tip amounts are encrypted in recipient inboxes; only token type is public.",
  });
}

main().catch(err => {
  process.stderr.write(`[06-tips-sent] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
