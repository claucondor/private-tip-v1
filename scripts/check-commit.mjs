#!/usr/bin/env node
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
const JANUS_FLOW = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";
const COA = "0x000000000000000000000002c010c708e68bfd7f";

const abi = [
  "function commitments(address) view returns (uint256, uint256)",
  "function firstSnapshotBlock(address) view returns (uint256)",
];
const c = new ethers.Contract(JANUS_FLOW, abi, provider);

const [x, y] = await c.commitments(COA);
console.log(`commit[${COA}] = (0x${x.toString(16)}, 0x${y.toString(16)})`);
console.log(`is identity (0,1)? ${x === 0n && y === 1n}`);

const fsb = await c.firstSnapshotBlock(COA);
console.log(`firstSnapshotBlock[${COA}] = ${fsb} (${fsb === 0n ? "NEVER set" : "set"})`);
