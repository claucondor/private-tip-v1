#!/usr/bin/env node
/// Find the earliest block where a Flow address has JanusFlow EVM activity.
/// Paginates BACKWARDS from latest in 9000-block chunks (Flow EVM eth_getLogs cap).

import { ethers } from "ethers";

const FLOW_ADDR = process.argv[2];
if (!FLOW_ADDR) {
  console.error("Usage: node find_first_block.mjs <flow_address>");
  process.exit(1);
}

const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const FLOW_REST = "https://rest-testnet.onflow.org";
const JANUS_FLOW = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

// Event ABI (matches JanusFlow_v0_5_3.sol *WithSnapshot + legacy events)
const EVENTS_ABI = [
  "event Wrapped(address indexed user, uint256 amount)",
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferred(address indexed sender, address indexed recipient)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event Unwrapped(address indexed user, address recipient, uint256 amount)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

// Resolve COA EVM address via Cadence script
async function getCoaEvm(flowAddr) {
  const script = `
import EVM from 0x8c5303eaa26202d6
access(all) fun main(address: Address): String {
  if let coa = getAuthAccount<auth(Storage) &Account>(address)
        .storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) {
    return coa.address().toString()
  }
  return ""
}`;
  const body = {
    script: Buffer.from(script).toString("base64"),
    arguments: [Buffer.from(JSON.stringify({ type: "Address", value: flowAddr })).toString("base64")],
  };
  const res = await fetch(`${FLOW_REST}/v1/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Flow REST: ${res.statusText}`);
  const raw = await res.json();
  const decoded = JSON.parse(Buffer.from(raw, "base64").toString());
  return decoded.value;
}

async function main() {
  console.log(`Flow addr: ${FLOW_ADDR}`);
  const coaEvm = await getCoaEvm(FLOW_ADDR);
  if (!coaEvm) {
    console.log("NO COA — this wallet has no EVM activity at all.");
    process.exit(0);
  }
  // Normalize COA: Flow returns 40 hex chars (Flow EVM 32-byte padded) without 0x.
  // Trim to last 20 bytes for the EVM address.
  const coaHex = (coaEvm.startsWith("0x") ? coaEvm.slice(2) : coaEvm).toLowerCase();
  const coaEvmAddr = "0x" + coaHex.slice(-40);
  console.log(`COA EVM:  ${coaEvmAddr}`);

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const latest = await provider.getBlockNumber();
  console.log(`Latest block: ${latest}`);

  const iface = new ethers.Interface(EVENTS_ABI);
  const userTopic = ethers.zeroPadValue(coaEvmAddr, 32);

  // Build topic filters for each event where user is indexed as sender/user (topic[1])
  // and a separate filter for recipient (topic[2]) on ShieldedTransfer events.
  const eventNames = [
    "Wrapped",
    "WrapWithSnapshot",
    "ShieldedTransferred",
    "ShieldedTransferWithSnapshot",
    "Unwrapped",
    "UnwrapWithSnapshot",
  ];

  const filtersUser = eventNames.map(name => [iface.getEvent(name).topicHash, userTopic]);
  const filtersRecipient = [
    [iface.getEvent("ShieldedTransferred").topicHash, null, userTopic],
    [iface.getEvent("ShieldedTransferWithSnapshot").topicHash, null, userTopic],
  ];
  const allFilters = [...filtersUser, ...filtersRecipient];

  // Paginate backwards in 9000-block chunks
  const CHUNK = 9000;
  let earliestBlock = null;
  let earliestEvent = null;
  let totalFound = 0;
  let chunkCount = 0;

  for (let end = latest; end >= 0; end -= CHUNK) {
    chunkCount++;
    const start = Math.max(0, end - CHUNK + 1);
    process.stdout.write(`  Chunk ${chunkCount}: blocks ${start}-${end}... `);

    const chunkLogs = [];
    try {
      const results = await Promise.all(
        allFilters.map(topics =>
          provider.getLogs({
            address: JANUS_FLOW,
            fromBlock: start,
            toBlock: end,
            topics,
          })
        )
      );
      for (const logs of results) chunkLogs.push(...logs);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      continue;
    }

    if (chunkLogs.length > 0) {
      // Find the earliest block in this chunk
      chunkLogs.sort((a, b) => a.blockNumber - b.blockNumber);
      const chunkEarliest = chunkLogs[0];
      process.stdout.write(`found ${chunkLogs.length} events, earliest at block ${chunkEarliest.blockNumber}\n`);
      if (earliestBlock === null || chunkEarliest.blockNumber < earliestBlock) {
        earliestBlock = chunkEarliest.blockNumber;
        const eventName = eventNames.find(n => iface.getEvent(n).topicHash === chunkEarliest.topics[0]) || "Unknown";
        earliestEvent = { name: eventName, txHash: chunkEarliest.transactionHash, block: chunkEarliest.blockNumber };
      }
      totalFound += chunkLogs.length;
    } else {
      process.stdout.write(`empty\n`);
    }

    // Safety: cap at 100 chunks (~900,000 blocks ≈ 10 days)
    if (chunkCount >= 100) {
      console.log("  Reached 100-chunk safety limit. Stopping.");
      break;
    }

    if (start === 0) break;
  }

  console.log("");
  console.log("=== RESULTS ===");
  console.log(`Total events found: ${totalFound}`);
  if (earliestBlock !== null) {
    console.log(`Earliest activity: block ${earliestBlock}`);
    console.log(`Event type:        ${earliestEvent.name}`);
    console.log(`Tx hash:           0x${earliestEvent.txHash.replace(/^0x/, "")}`);
    console.log("");
    console.log("To recover this wallet's state in the SDK scanner:");
    console.log(`  scanJanusFlowSnapshots(coaEvm, provider, { fromBlock: ${earliestBlock} })`);
  } else {
    console.log("No events found for this COA address.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
