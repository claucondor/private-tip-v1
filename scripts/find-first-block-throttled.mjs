#!/usr/bin/env node
/// Throttled backwards scan to find earliest JanusFlow EVM event for a COA.
/// Sequential (one filter at a time) with 50ms delay → ~20 req/sec << 40/sec cap.

import { ethers } from "ethers";

const COA = process.argv[2];
if (!COA || !COA.startsWith("0x") || COA.length !== 42) {
  console.error("Usage: node find-first-block-throttled.mjs <coa_evm_addr_0x...>");
  process.exit(1);
}

const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const JANUS_FLOW = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

const EVENTS_ABI = [
  "event Wrapped(address indexed user, uint256 amount)",
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferred(address indexed sender, address indexed recipient)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event Unwrapped(address indexed user, address recipient, uint256 amount)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getLogsWithRetry(provider, params, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await provider.getLogs(params);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes("request limit reached") || msg.includes("rate") || msg.includes("429")) {
        const wait = 1500 * (i + 1);
        process.stdout.write(` [rate-limit, retry in ${wait}ms]`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error("max retries exceeded");
}

async function main() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const latest = await provider.getBlockNumber();
  const iface = new ethers.Interface(EVENTS_ABI);
  const userTopic = ethers.zeroPadValue(COA.toLowerCase(), 32);

  console.log(`COA EVM:       ${COA}`);
  console.log(`Latest block:  ${latest}`);
  console.log(`Scanning...`);
  console.log("");

  const eventNames = [
    "Wrapped",
    "WrapWithSnapshot",
    "ShieldedTransferred",
    "ShieldedTransferWithSnapshot",
    "Unwrapped",
    "UnwrapWithSnapshot",
  ];

  // Build filter specs: topic[0] = eventHash, topic[1] = userTopic (or null+topic[2] for recipient match)
  const filterSpecs = [
    ...eventNames.map(name => ({
      label: `${name}[user]`,
      topics: [iface.getEvent(name).topicHash, userTopic],
    })),
    {
      label: "ShieldedTransferred[recipient]",
      topics: [iface.getEvent("ShieldedTransferred").topicHash, null, userTopic],
    },
    {
      label: "ShieldedTransferWithSnapshot[recipient]",
      topics: [iface.getEvent("ShieldedTransferWithSnapshot").topicHash, null, userTopic],
    },
  ];

  const CHUNK = 9000;
  const MAX_CHUNKS = 300; // ~2.7M blocks ≈ 30 days at 1 sec/block

  let earliestBlock = null;
  let earliestInfo = null;
  let totalFound = 0;
  let chunkCount = 0;

  for (let end = latest; end >= 0 && chunkCount < MAX_CHUNKS; end -= CHUNK) {
    chunkCount++;
    const start = Math.max(0, end - CHUNK + 1);
    process.stdout.write(`Chunk ${chunkCount.toString().padStart(3)}: blocks ${start}-${end} `);

    let chunkLogs = [];
    let chunkErrors = 0;

    for (const spec of filterSpecs) {
      try {
        const logs = await getLogsWithRetry(provider, {
          address: JANUS_FLOW,
          fromBlock: start,
          toBlock: end,
          topics: spec.topics,
        });
        chunkLogs.push(...logs.map(l => ({ ...l, _eventLabel: spec.label })));
      } catch (e) {
        chunkErrors++;
      }
      await sleep(55); // throttle to ~18 req/sec
    }

    if (chunkErrors > 0) {
      process.stdout.write(` [${chunkErrors} filters errored]`);
    }

    if (chunkLogs.length > 0) {
      chunkLogs.sort((a, b) => a.blockNumber - b.blockNumber);
      const chunkEarliest = chunkLogs[0];
      process.stdout.write(` → FOUND ${chunkLogs.length} events, earliest at block ${chunkEarliest.blockNumber} (${chunkEarliest._eventLabel})\n`);
      if (earliestBlock === null || chunkEarliest.blockNumber < earliestBlock) {
        earliestBlock = chunkEarliest.blockNumber;
        earliestInfo = {
          event: chunkEarliest._eventLabel,
          block: chunkEarliest.blockNumber,
          txHash: chunkEarliest.transactionHash,
        };
      }
      totalFound += chunkLogs.length;
    } else {
      process.stdout.write(` empty\n`);
    }

    if (start === 0) break;
  }

  console.log("");
  console.log("=== RESULT ===");
  console.log(`Chunks scanned:     ${chunkCount} (~${chunkCount * CHUNK} blocks, ~${Math.round(chunkCount * CHUNK / 86400)} days)`);
  console.log(`Total events:       ${totalFound}`);
  if (earliestBlock !== null) {
    console.log(`Earliest activity:  block ${earliestBlock}`);
    console.log(`Event type:         ${earliestInfo.event}`);
    console.log(`Tx hash:            ${earliestInfo.txHash}`);
    console.log("");
    console.log(`Recovery SDK call:`);
    console.log(`  scanJanusFlowSnapshots(coaEvm, provider, { fromBlock: ${earliestBlock} })`);
  } else {
    console.log("No events found within scanned range.");
    console.log("Either the wallet has never wrapped, or activity is older than scanned range.");
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
