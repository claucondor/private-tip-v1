#!/usr/bin/env node
"use strict";
/**
 * 02-portfolio.cjs — Shielded portfolio reader (front view: /portfolio)
 *
 * Reads shielded balances across all 3 tokens for a given user:
 *   - FLOW  (JanusFlow EVM)
 *   - mUSDC (JanusERC20 EVM)
 *   - MockFT (JanusFT Cadence)
 *
 * Balance recovery strategy (v0.8):
 *   1. Read ShieldedCheckpoint (latest known balance/blinding for each token slot).
 *      Checkpoint is per-user (keyed by EVM address) but token-agnostic —
 *      each token adapter writes its own checkpoint entry.
 *   2. Check inbox for pending notes (undrained income since last checkpoint).
 *   3. Return a clear per-token breakdown.
 *
 * Usage:
 *   node scripts/02-portfolio.cjs \
 *     --evm-key 0x<hex>          # EVM private key (owner of checkpoint + inbox)
 *     [--memokey-priv <decimal>] # BabyJub privkey; if omitted, derived from --evm-key
 *
 * Output JSON:
 *   {
 *     "evmAddr": "0x...",
 *     "flow":   { "checkpointBalance": "...", "inboxPending": "<N notes>", "commitment": { "x": "...", "y": "..." } },
 *     "musdc":  { "checkpointBalance": "...", "inboxPending": "<N notes>", "commitment": { "x": "...", "y": "..." } },
 *     "mockft": { "checkpointBalance": null, "commitment": { "x": "...", "y": "..." } },
 *     "inboxTotal": <total pending notes across tokens>
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["evm-key", "memokey-priv"],
  boolean: ["help"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  sdk,
  ShieldedInboxClient,
  ShieldedCheckpointClient,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  provider,
  ADDRESSES,
  JANUS_VIEW_ABI,
  jsonOutput,
  formatDecimals,
} = require("./_shared.cjs");

if (argv.help) {
  console.error("Usage: node scripts/02-portfolio.cjs --evm-key <hex> [--memokey-priv <decimal>]");
  process.exit(0);
}

async function readCommitment(tokenId, evmAddr) {
  const adapter = sdk.token(tokenId);
  try {
    const commit = await adapter.getCommitment(evmAddr);
    return { x: commit.x.toString(), y: commit.y.toString() };
  } catch (_) {
    return { x: null, y: null };
  }
}

async function main() {
  const evmKey = argv["evm-key"];
  if (!evmKey) {
    console.error("Error: --evm-key is required");
    process.exit(1);
  }

  const wallet  = makeWallet(evmKey);
  const evmAddr = wallet.address;

  // Derive or use explicit BabyJub privkey
  let keypair;
  if (argv["memokey-priv"]) {
    keypair = await keypairFromPriv(argv["memokey-priv"]);
  } else {
    keypair = await deriveMemoKeypair(wallet);
  }

  // ── 1. Checkpoint state (balance/blinding per session) ────────────────────
  const cpClient = new ShieldedCheckpointClient();
  let checkpointSnap = null;
  try {
    checkpointSnap = await cpClient.readAndDecrypt(wallet, keypair.privkey);
  } catch (_) {
    // No checkpoint yet
  }

  // ── 2. On-chain commitments (public — no decryption needed) ───────────────
  const [flowCommit, musdcCommit, mockftCommit] = await Promise.all([
    readCommitment("flow",     evmAddr),
    readCommitment("mockusdc", evmAddr),
    readCommitment("mockft",   evmAddr),
  ]);

  // ── 3. Inbox pending count ─────────────────────────────────────────────────
  const inboxClient = new ShieldedInboxClient();
  const pendingCount = await inboxClient.count(evmAddr);

  // ── 4. Underlying (unshielded) balances ───────────────────────────────────
  let flowBalance   = null;
  let musdcBalance  = null;
  try {
    flowBalance  = await provider.getBalance(evmAddr);
  } catch (_) {}
  try {
    const erc20 = new ethers.Contract(ADDRESSES.mockUSDC,
      ["function balanceOf(address) view returns (uint256)"], provider);
    musdcBalance = await erc20.balanceOf(evmAddr);
  } catch (_) {}

  // ── 5. Checkpoint metadata (public, no decryption) ────────────────────────
  const cpMeta = await cpClient.metadata(evmAddr);

  // ── 6. Output ──────────────────────────────────────────────────────────────
  jsonOutput({
    evmAddr,
    checkpoint: checkpointSnap
      ? {
          balance:  checkpointSnap.balance.toString(),
          blinding: checkpointSnap.blinding.toString(),
          version:  cpMeta.version.toString(),
          lastUpdatedBlock: cpMeta.lastUpdatedBlock.toString(),
        }
      : {
          balance:  null,
          blinding: null,
          version:  "0",
          note:     "no checkpoint on-chain — wrap first to establish one",
        },
    flow: {
      commitment:        flowCommit,
      underlying:        flowBalance !== null ? formatDecimals(flowBalance, 18) : null,
    },
    musdc: {
      commitment:        musdcCommit,
      underlying:        musdcBalance !== null ? formatDecimals(musdcBalance, 6) : null,
    },
    mockft: {
      commitment:        mockftCommit,
      note:              "MockFT checkpoint is Cadence-native; use flow scripts for on-chain balance",
    },
    inbox: {
      pendingNotes: pendingCount.toString(),
      note: Number(pendingCount) > 0
        ? "run 05-tips-received to drain and decrypt incoming notes"
        : "inbox empty",
    },
  });
}

main().catch(err => {
  process.stderr.write(`[02-portfolio] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
