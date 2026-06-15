#!/usr/bin/env node
"use strict";
/**
 * 08-status.cjs — Protocol health dashboard (front view: /status)
 *
 * Reads on-chain state across all deployed contracts:
 *   - Contract versions
 *   - Total tips recorded (PrivateTip)
 *   - Total locked per token (JanusFlow, JanusERC20)
 *   - Fee rates
 *
 * No arguments required. Read-only, no wallet needed.
 *
 * Usage:
 *   node scripts/08-status.cjs
 *
 * Output JSON:
 *   {
 *     "protocolVersion": "0.8.0",
 *     "chainId": 545,
 *     "contracts": {
 *       "janusFlow": { "address": "...", "version": "0.8.0", "totalLocked": "...", "feeBps": 10 },
 *       "janusERC20": { "address": "...", "version": "0.8.0", "totalLocked": "...", "feeBps": 10 },
 *       "janusFT": { "address": "...", "variant": "cadence" },
 *       "memoRegistry": { "address": "..." },
 *       "shieldedInbox": { "address": "..." },
 *       "shieldedCheckpoint": { "address": "..." },
 *       "privateTip": { "address": "...", "totalTips": "..." }
 *     },
 *     "network": { "rpc": "...", "blockNumber": "..." }
 *   }
 */

const { ethers } = require("ethers");
const {
  provider,
  ADDRESSES,
  JANUS_VIEW_ABI,
  jsonOutput,
  flowScript,
} = require("./_shared.cjs");

// Additional ABI entries not in JANUS_VIEW_ABI
const FULL_JANUS_ABI = [
  ...JANUS_VIEW_ABI,
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
];

async function readContractVersion(addr, abi) {
  try {
    const c = new ethers.Contract(addr, abi, provider);
    return await c.VERSION();
  } catch (_) {
    return null;
  }
}

async function readTotalLocked(addr) {
  try {
    const c = new ethers.Contract(addr, JANUS_VIEW_ABI, provider);
    return (await c.totalLocked()).toString();
  } catch (_) {
    return null;
  }
}

async function readFeeBps(addr) {
  try {
    const c = new ethers.Contract(addr, FULL_JANUS_ABI, provider);
    return Number(await c.feeBps());
  } catch (_) {
    return null;
  }
}

// Read PrivateTip total tips via Cadence script
function readTotalTips() {
  try {
    const raw = flowScript("cadence/scripts/get_total_tips.cdc");
    // flow output looks like: "Result: 5"
    const match = raw.match(/Result:\s*(\d+)/);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

async function main() {
  const blockNumber = await provider.getBlockNumber();
  const network     = await provider.getNetwork();

  // Parallel contract reads
  const [
    flowVersion, flowLocked, flowFee,
    erc20Version, erc20Locked, erc20Fee,
  ] = await Promise.all([
    readContractVersion(ADDRESSES.janusFlow, FULL_JANUS_ABI),
    readTotalLocked(ADDRESSES.janusFlow),
    readFeeBps(ADDRESSES.janusFlow),
    readContractVersion(ADDRESSES.janusERC20, FULL_JANUS_ABI),
    readTotalLocked(ADDRESSES.janusERC20),
    readFeeBps(ADDRESSES.janusERC20),
  ]);

  // PrivateTip total tips (Cadence script)
  const totalTips = readTotalTips();

  // Format locked amounts
  const flowLockedFmt  = flowLocked  ? `${(BigInt(flowLocked)  / 10n**15n).toString()}m FLOW` : null;
  const erc20LockedFmt = erc20Locked ? `${(BigInt(erc20Locked) / 10n**3n).toString()}m mUSDC` : null;

  jsonOutput({
    protocolVersion: "0.8.0",
    chainId: Number(network.chainId),
    contracts: {
      janusFlow: {
        address:     ADDRESSES.janusFlow,
        version:     flowVersion,
        totalLocked: flowLocked,
        totalLockedHuman: flowLockedFmt,
        feeBps:      flowFee,
      },
      janusERC20: {
        address:     ADDRESSES.janusERC20,
        version:     erc20Version,
        totalLocked: erc20Locked,
        totalLockedHuman: erc20LockedFmt,
        feeBps:      erc20Fee,
      },
      janusFT: {
        address:     ADDRESSES.cadenceDeployer,
        variant:     "cadence-ft",
        contractName:"JanusFT",
        note:        "Cadence-native; totalLocked via flow scripts",
      },
      mockUSDC: {
        address:     ADDRESSES.mockUSDC,
        note:        "Testnet ERC20 underlying for JanusERC20",
      },
      memoRegistry: {
        address:     ADDRESSES.memoRegistry,
      },
      shieldedInbox: {
        address:     ADDRESSES.shieldedInbox,
      },
      shieldedCheckpoint: {
        address:     ADDRESSES.shieldedCheckpoint,
      },
      privateTip: {
        address:     ADDRESSES.cadenceDeployer,
        contractName:"PrivateTip",
        totalTips:   totalTips,
      },
    },
    network: {
      rpc:         "https://testnet.evm.nodes.onflow.org",
      blockNumber: blockNumber.toString(),
    },
  });
}

main().catch(err => {
  process.stderr.write(`[08-status] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
