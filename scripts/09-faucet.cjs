#!/usr/bin/env node
"use strict";
/**
 * 09-faucet.cjs — Testnet faucet (front view: /faucet)
 *
 * Mints MockUSDC (ERC20) and/or MockFT (Cadence FT) to a target address.
 * Uses the deployer (Alice) EOA key which has mint authority on MockUSDC.
 * MockFT minting requires the Cadence deployer account (openjanus-v08).
 *
 * Note: FLOW itself is funded via the Flow testnet faucet (faucet.flow.com);
 * this script cannot mint native FLOW.
 *
 * Usage:
 *   node scripts/09-faucet.cjs \
 *     --to-evm <0x...>           # recipient EVM address (for mUSDC)
 *     [--to-cadence <0x...>]     # recipient Cadence address (for MockFT)
 *     [--musdc-amount <N>]       # mUSDC amount in human units (e.g. 100 = 100 mUSDC)
 *     [--mockft-amount <N>]      # MockFT amount in UFix64 string (e.g. "50.0")
 *     [--admin-key <hex>]        # override deployer key (default: Alice's key)
 *     [--cadence-account <name>] # flow.json account for MockFT mint (default: openjanus-v08)
 *
 * Output JSON:
 *   {
 *     "toEvm": "0x...",
 *     "toCadence": "0x...",
 *     "musdc": { "amount": "100", "txHash": "0x..." },
 *     "mockft": { "amount": "50.0", "txId": "...", "note": "..." }
 *   }
 */

const argv = require("minimist")(process.argv.slice(2), {
  string: ["to-evm", "to-cadence", "musdc-amount", "mockft-amount", "admin-key", "cadence-account"],
  boolean: ["help"],
  alias: { h: "help" },
});

const { ethers } = require("ethers");
const {
  makeWallet,
  provider,
  ADDRESSES,
  ERC20_ABI,
  DEPLOYER_EOA_KEY,
  jsonOutput,
  flowTx,
  buildArgs,
} = require("./_shared.cjs");

if (argv.help) {
  console.error("Usage: node scripts/09-faucet.cjs --to-evm <0x...> [--musdc-amount <N>] [--to-cadence <0x...>] [--mockft-amount <N>]");
  process.exit(0);
}

// Mint MockUSDC via ERC20 mint(address, uint256) — deployer must be owner
async function mintMUSDC(adminWallet, toAddr, amount) {
  const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, adminWallet);
  const decimals = 6;
  const rawAmt = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));
  const tx = await usdc.mint(toAddr, rawAmt);
  await tx.wait(1);
  return { txHash: tx.hash, rawAmount: rawAmt.toString() };
}

async function main() {
  const toEVM      = argv["to-evm"];
  const toCadence  = argv["to-cadence"];
  const musdcAmt   = argv["musdc-amount"];
  const mockftAmt  = argv["mockft-amount"];
  const adminKey   = argv["admin-key"] || DEPLOYER_EOA_KEY;
  const cadenceAcc = argv["cadence-account"] || "openjanus-v08";

  if (!toEVM && !toCadence) {
    console.error("Error: at least one of --to-evm or --to-cadence is required");
    process.exit(1);
  }

  const result = {
    toEvm:     toEVM     || null,
    toCadence: toCadence || null,
    musdc:     null,
    mockft:    null,
  };

  // ── Mint mUSDC (EVM ERC20) ────────────────────────────────────────────────
  if (toEVM && musdcAmt) {
    const adminWallet = makeWallet(adminKey);
    process.stderr.write(`[09-faucet] Minting ${musdcAmt} mUSDC to ${toEVM}\n`);
    const mintResult = await mintMUSDC(adminWallet, toEVM, musdcAmt);
    result.musdc = {
      amount:    musdcAmt,
      rawAmount: mintResult.rawAmount,
      txHash:    mintResult.txHash,
    };
  }

  // ── Mint MockFT (Cadence FT) ───────────────────────────────────────────────
  // MockFT is minted via a Cadence transaction that calls the Minter resource.
  // The admin (openjanus-v08) holds the Minter resource.
  if (toCadence && mockftAmt) {
    process.stderr.write(`[09-faucet] Minting ${mockftAmt} MockFT to Cadence ${toCadence}\n`);
    // Check if a mint_mockft.cdc transaction exists
    const { existsSync } = require("fs");
    const mintTxPath = "admin-transactions/mint_mockft.cdc";
    const fullPath   = `/home/oydual3/zkapps/private-tip-v1/${mintTxPath}`;

    if (existsSync(fullPath)) {
      try {
        const ufixAmt  = mockftAmt.includes(".") ? mockftAmt : mockftAmt + ".00000000";
        const txResult = flowTx(
          mintTxPath,
          cadenceAcc,
          buildArgs([
            { type: "Address", value: toCadence },
            { type: "UFix64",  value: ufixAmt },
          ])
        );
        result.mockft = {
          amount: mockftAmt,
          txId:   txResult.txId,
        };
      } catch (err) {
        result.mockft = { error: err.message };
      }
    } else {
      // No mint tx available — provide instructions
      result.mockft = {
        note: `MockFT mint tx not found at ${mintTxPath}. ` +
              `To mint MockFT, the deployer must run a Cadence tx that borrows the Minter resource ` +
              `from /storage/mockFTMinter and calls mint(amount: ${mockftAmt}). ` +
              `The resulting vault must be deposited to the recipient's MockFT receiver.`,
        amount: mockftAmt,
        toCadence,
      };
    }
  }

  // Check balances after minting
  if (toEVM) {
    try {
      const usdc = new ethers.Contract(ADDRESSES.mockUSDC,
        ["function balanceOf(address) view returns (uint256)"], provider);
      const bal = await usdc.balanceOf(toEVM);
      result.musdcBalanceAfter = (bal / 10n ** 6n).toString() + " mUSDC";
    } catch (_) {}
  }

  jsonOutput(result);
}

main().catch(err => {
  process.stderr.write(`[09-faucet] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
