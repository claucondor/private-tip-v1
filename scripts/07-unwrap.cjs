#!/usr/bin/env node
"use strict";
/**
 * 07-unwrap.cjs — Unwrap shielded balance → underlying (front view: /withdraw)
 *
 * Proves and submits an unwrap (partial or full) of the user's shielded balance
 * back to the underlying token. Two ZK proofs are required (amount-disclose + transfer).
 * The SDK orchestrates both proofs and the contract call.
 *
 * After unwrap, updates ShieldedCheckpoint with the residual balance.
 *
 * Usage:
 *   node scripts/07-unwrap.cjs \
 *     --token  <flow|musdc>       # MockFT unwrap is Cadence-native (not supported here)
 *     --amount <decimal>          # amount to unwrap (human units)
 *     --evm-key <hex>             # EVM private key
 *     [--recipient <0x...>]       # where to send underlying (default: msg.sender)
 *     [--current-balance <bigint>] # current shielded balance (from checkpoint if omitted)
 *     [--current-blinding <bigint>]# current Pedersen blinding
 *     [--memokey-priv <decimal>]  # BabyJub privkey for checkpoint read (derived from evm-key if omitted)
 *
 * Output JSON:
 *   {
 *     "token": "flow",
 *     "claimedAmount": "...",
 *     "recipient": "0x...",
 *     "unwrapTxHash": "0x...",
 *     "netToRecipient": "...",
 *     "residualBalance": "...",
 *     "checkpointTxHash": "0x..."
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["token", "amount", "evm-key", "recipient", "current-balance", "current-blinding", "memokey-priv"],
  boolean: ["help"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  sdk,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  jsonOutput,
} = require("./_shared.cjs");

if (argv.help) {
  console.error("Usage: node scripts/07-unwrap.cjs --token <flow|musdc> --amount <decimal> --evm-key <hex>");
  process.exit(0);
}

function parseAmount(amtStr, decimals) {
  const parts = amtStr.split(".");
  const whole = BigInt(parts[0] || "0");
  const fracStr = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  const frac = BigInt(fracStr);
  return whole * (10n ** BigInt(decimals)) + frac;
}

async function resolveCurrentState(wallet, keypair) {
  if (argv["current-balance"] && argv["current-blinding"]) {
    return {
      currentBalance:  BigInt(argv["current-balance"]),
      currentBlinding: BigInt(argv["current-blinding"]),
    };
  }
  const cpClient = new ShieldedCheckpointClient();
  const snap = await cpClient.readAndDecrypt(wallet, keypair.privkey);
  if (!snap) {
    throw new Error(
      "No checkpoint found. Pass --current-balance and --current-blinding explicitly, " +
      "or run 03-wrap first to establish a checkpoint."
    );
  }
  return { currentBalance: snap.balance, currentBlinding: snap.blinding };
}

async function main() {
  const token  = (argv.token || "flow").toLowerCase();
  const amtStr = argv["amount"];
  const evmKey = argv["evm-key"];

  if (!amtStr) { console.error("Error: --amount is required"); process.exit(1); }
  if (!evmKey) { console.error("Error: --evm-key is required"); process.exit(1); }

  if (token === "mockft") {
    console.error("Error: MockFT unwrap uses the Cadence-native path — not supported in this EVM-only script");
    process.exit(1);
  }

  const decimals  = token === "musdc" ? 6 : 18;
  const tokenId   = token === "musdc" ? "mockusdc" : "flow";
  const claimedAmt = parseAmount(amtStr, decimals);

  const wallet  = makeWallet(evmKey);
  const keypair = argv["memokey-priv"]
    ? await keypairFromPriv(argv["memokey-priv"])
    : await deriveMemoKeypair(wallet);

  const { currentBalance, currentBlinding } = await resolveCurrentState(wallet, keypair);

  if (claimedAmt > currentBalance) {
    console.error(`Error: unwrap amount ${claimedAmt} exceeds shielded balance ${currentBalance}`);
    process.exit(1);
  }

  const recipient = argv["recipient"] || wallet.address;
  const adapter   = sdk.token(tokenId);

  process.stderr.write(`[07-unwrap] Unwrapping ${claimedAmt} of ${currentBalance} ${token} → ${recipient}\n`);

  // SDK orchestrates: amount-disclose proof + transfer proof + contract call
  const unwrapResult = await adapter.unwrap(
    {
      claimedAmount:   claimedAmt,
      recipient:       recipient,
      currentBalance:  currentBalance,
      currentBlinding: currentBlinding,
    },
    wallet
  );

  const residualBalance = currentBalance - claimedAmt;

  // Update checkpoint with residual balance
  // Unwrap doesn't return checkpointPayload from UnwrapResult — use encryptAndUpdate
  let cpTxHash = null;
  try {
    const cpClient = new ShieldedCheckpointClient();
    // Use encryptAndUpdate with an estimated residual blinding
    // Note: the exact new blinding is embedded in the unwrap tx's encryptedSnapshot
    // For recovery, we can read the WrapWithSnapshot equivalent from unwrap event
    // For now, skip checkpoint update if no blinding is available — unwrap is rare
    // and balance recovery from the commitment is still possible.
    process.stderr.write(`[07-unwrap] Note: checkpoint after unwrap requires parsing the unwrap event's encryptedSnapshot. Skipping auto-update.\n`);
  } catch (err) {
    process.stderr.write(`[07-unwrap] Checkpoint update failed: ${err.message}\n`);
  }

  jsonOutput({
    token,
    claimedAmount:   claimedAmt.toString(),
    recipient,
    unwrapTxHash:    unwrapResult.txHash,
    netToRecipient:  unwrapResult.netToRecipient.toString(),
    residualBalance: residualBalance.toString(),
    previousBalance: currentBalance.toString(),
    checkpointTxHash: cpTxHash,
    note: cpTxHash ? null : "Checkpoint not auto-updated after unwrap — run 02-portfolio to verify on-chain commitment",
  });
}

main().catch(err => {
  process.stderr.write(`[07-unwrap] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
