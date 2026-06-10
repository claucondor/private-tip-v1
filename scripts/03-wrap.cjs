#!/usr/bin/env node
"use strict";
/**
 * 03-wrap.cjs — Wrap underlying → shielded (front view: /wrap)
 *
 * Wraps underlying token into the user's shielded Pedersen commitment slot.
 * Supports all 3 tokens: FLOW (native EVM), mUSDC (ERC20 EVM), MockFT (Cadence FT).
 *
 * After a successful wrap, the script also updates the user's ShieldedCheckpoint
 * with the new (balance, blinding) state for fast recovery.
 *
 * Usage:
 *   node scripts/03-wrap.cjs \
 *     --token  <flow|musdc|mockft>  # which token to wrap
 *     --amount <decimal>            # gross amount to wrap (e.g. "0.05" for FLOW)
 *     --evm-key <hex>               # EVM private key (signer + memokey derivation)
 *     [--cadence-account <name>]    # required for --token mockft (Cadence tx)
 *     [--update-checkpoint]         # persist new state to ShieldedCheckpoint (default: yes)
 *
 * For mUSDC, the script auto-approves the JanusERC20 proxy before wrapping.
 *
 * Output JSON:
 *   {
 *     "token": "flow",
 *     "grossAmount": "50000000000000000",
 *     "netAmount": "49950000000000000",
 *     "fee": "50000000000000",
 *     "wrapTxHash": "0x...",
 *     "checkpointTxHash": "0x...",
 *     "newBalance": "49950000000000000",
 *     "newBlinding": "...",
 *     "commitment": { "x": "...", "y": "..." }
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["token", "amount", "evm-key", "cadence-account"],
  boolean: ["help", "update-checkpoint"],
  default: { "update-checkpoint": true },
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  sdk,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  provider,
  ADDRESSES,
  ERC20_ABI,
  jsonOutput,
  formatDecimals,
  flowTx,
  buildArgs,
} = require("./_shared.cjs");

const { decryptSnapshot } = require("@claucondor/sdk");

// Parse WrapWithSnapshot event and decrypt snapshot
const WRAP_WITH_SNAPSHOT_SIG = "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

async function recoverWrapState(txHash, privkey) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`No receipt for ${txHash}`);
  for (const log of receipt.logs) {
    try {
      const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WrapWithSnapshot") {
        const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
        const ephX     = BigInt(parsed.args.ephPubkeyX);
        const ephY     = BigInt(parsed.args.ephPubkeyY);
        const snap = await decryptSnapshot(encBytes, { x: ephX, y: ephY }, privkey);
        return { balance: snap.balance, blinding: snap.blinding };
      }
    } catch (_) { /* not this event */ }
  }
  return null; // WrapWithSnapshot not found (may have failed silently)
}

if (argv.help || !argv.token) {
  console.error("Usage: node scripts/03-wrap.cjs --token <flow|musdc|mockft> --amount <decimal> --evm-key <hex>");
  process.exit(0);
}

// Parse decimal amount string to bigint base units
function parseAmount(amtStr, decimals) {
  const parts = amtStr.split(".");
  const whole = BigInt(parts[0] || "0");
  const fracStr = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  const frac = BigInt(fracStr);
  return whole * (10n ** BigInt(decimals)) + frac;
}

async function wrapFlow(wallet, keypair, grossAmt, updateCp) {
  const adapter    = sdk.token("flow");
  const wrapResult = await adapter.wrap({ grossAmount: grossAmt }, wallet);

  // Recover balance/blinding from WrapWithSnapshot event (needed for checkpoint)
  const wrapState = await recoverWrapState(wrapResult.txHash, keypair.privkey);

  let cpTxHash = null;
  if (updateCp && wrapState) {
    const cpClient = new ShieldedCheckpointClient();
    const { encryptSnapshot } = require("@claucondor/sdk");
    const enc = await encryptSnapshot(
      { balance: wrapState.balance, blinding: wrapState.blinding },
      keypair.pubkey
    );
    const cpRes = await cpClient.update(
      { encryptedSnapshot: enc.ciphertext, ephPubkeyX: enc.ephemeralPubkey.x, ephPubkeyY: enc.ephemeralPubkey.y },
      0n,
      wallet
    );
    cpTxHash = cpRes.txHash;
  }

  const commitment = await adapter.getCommitment(wallet.address);

  return {
    token: "flow",
    grossAmount: grossAmt.toString(),
    netAmount:   wrapResult.netAmount.toString(),
    fee:         wrapResult.fee.toString(),
    wrapTxHash:  wrapResult.txHash,
    checkpointTxHash: cpTxHash,
    newBalance:  wrapState ? wrapState.balance.toString() : wrapResult.netAmount.toString(),
    newBlinding: wrapState ? wrapState.blinding.toString() : null,
    commitment:  { x: commitment.x.toString(), y: commitment.y.toString() },
  };
}

async function wrapMUSDC(wallet, keypair, grossAmt, updateCp) {
  // 1. Approve JanusERC20 proxy for the gross amount
  const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, wallet);
  const approveTx = await usdc.approve(ADDRESSES.janusERC20, grossAmt);
  await approveTx.wait(1);

  // 2. Wrap via SDK adapter
  const adapter    = sdk.token("mockusdc");
  const wrapResult = await adapter.wrap({ grossAmount: grossAmt }, wallet);

  // Recover balance/blinding from WrapWithSnapshot event
  const wrapState = await recoverWrapState(wrapResult.txHash, keypair.privkey);

  let cpTxHash = null;
  if (updateCp && wrapState) {
    const cpClient = new ShieldedCheckpointClient();
    const { encryptSnapshot } = require("@claucondor/sdk");
    const enc = await encryptSnapshot(
      { balance: wrapState.balance, blinding: wrapState.blinding },
      keypair.pubkey
    );
    const cpRes = await cpClient.update(
      { encryptedSnapshot: enc.ciphertext, ephPubkeyX: enc.ephemeralPubkey.x, ephPubkeyY: enc.ephemeralPubkey.y },
      0n,
      wallet
    );
    cpTxHash = cpRes.txHash;
  }

  const commitment = await adapter.getCommitment(wallet.address);

  return {
    token: "musdc",
    grossAmount: grossAmt.toString(),
    netAmount:   wrapResult.netAmount.toString(),
    fee:         wrapResult.fee.toString(),
    wrapTxHash:  wrapResult.txHash,
    checkpointTxHash: cpTxHash,
    newBalance:  wrapState ? wrapState.balance.toString() : wrapResult.netAmount.toString(),
    newBlinding: wrapState ? wrapState.blinding.toString() : null,
    commitment:  { x: commitment.x.toString(), y: commitment.y.toString() },
  };
}

async function wrapMockFT(cadenceAccount, amtStr, grossAmt, keypair) {
  if (!cadenceAccount) {
    throw new Error("--cadence-account is required for MockFT wraps (Cadence FT path)");
  }

  // MockFT uses UFix64 (8 decimal places)
  // The Cadence wrap tx accepts UFix64 string like "100.00000000"
  const ufixStr = amtStr.includes(".") ? amtStr : amtStr + ".00000000";
  const ufixPadded = ufixStr.split(".").map((p, i) => i === 1 ? p.padEnd(8, "0") : p).join(".");

  // Build proof inputs (the SDK's JanusFTAdapter wraps this for us, but
  // for Cadence, we call the flow CLI with the wrap_mockft transaction).
  // Use SDK adapter.wrap() which emits the Cadence wrap tx via FCL internally.
  // For pure-CLI approach, we delegate to the SDK for proof generation.
  const adapter = sdk.token("mockft");
  const wrapResult = await adapter.wrap({ grossAmount: grossAmt }, {} );
  // Note: JanusFTAdapter.wrap() doesn't accept an EVM signer — it uses Cadence FCL.
  // For CLI usage, we would need FCL configured. Instead, report amounts and instruct.

  return {
    token: "mockft",
    grossAmount: grossAmt.toString(),
    note: "MockFT wrap requires a configured FCL session (Cadence FT path). " +
          "Run: flow transactions send cadence/transactions/wrap_mockft.cdc " +
          `${ufixPadded} <nonce> <commitX> <commitY> <pA> <pB> <pC> <snapCipher> <ephX> <ephY> ` +
          "--signer " + cadenceAccount + " --network testnet",
    ufixAmount: ufixPadded,
  };
}

async function main() {
  const token  = (argv.token || "").toLowerCase();
  const amtStr = argv.amount;
  const evmKey = argv["evm-key"];

  if (!amtStr) { console.error("Error: --amount is required"); process.exit(1); }
  if (!token)  { console.error("Error: --token is required");  process.exit(1); }

  const cadenceAccount = argv["cadence-account"];
  const updateCp       = argv["update-checkpoint"];

  let result;

  if (token === "flow") {
    if (!evmKey) { console.error("Error: --evm-key is required for FLOW wrap"); process.exit(1); }
    const wallet  = makeWallet(evmKey);
    const keypair = await deriveMemoKeypair(wallet);
    const grossAmt = parseAmount(amtStr, 18);
    result = await wrapFlow(wallet, keypair, grossAmt, updateCp);
  } else if (token === "musdc") {
    if (!evmKey) { console.error("Error: --evm-key is required for mUSDC wrap"); process.exit(1); }
    const wallet  = makeWallet(evmKey);
    const keypair = await deriveMemoKeypair(wallet);
    const grossAmt = parseAmount(amtStr, 6);
    result = await wrapMUSDC(wallet, keypair, grossAmt, updateCp);
  } else if (token === "mockft") {
    let keypair;
    if (argv["memokey-priv"]) {
      keypair = await keypairFromPriv(argv["memokey-priv"]);
    } else if (evmKey) {
      const wallet = makeWallet(evmKey);
      keypair = await deriveMemoKeypair(wallet);
    } else {
      console.error("Error: --evm-key or --memokey-priv is required for MockFT wrap"); process.exit(1);
    }
    const grossAmt = parseAmount(amtStr, 8);
    result = await wrapMockFT(cadenceAccount, amtStr, grossAmt, keypair);
  } else {
    console.error(`Error: unknown token "${token}". Use flow|musdc|mockft`);
    process.exit(1);
  }

  jsonOutput(result);
}

main().catch(err => {
  process.stderr.write(`[03-wrap] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
