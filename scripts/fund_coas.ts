/**
 * Fund COA EVM wallets for the smoke test.
 * 
 * Flow EVM COAs are EVM addresses associated with Flow testnet Cadence accounts.
 * The accounts have FLOW on the Cadence side but need FLOW on the EVM side for gas.
 * 
 * This script bridges FLOW from the claucondor account (rich account) to each COA
 * by using the claucondor account to COA-bridge.
 * 
 * Usage:
 *   npx ts-node --transpile-only scripts/fund_coas.ts
 */

import { ethers } from "ethers";
import * as fcl from "@onflow/fcl";
import fs from "fs";
import path from "path";

const FLOW_ACCESS_API = "https://rest-testnet.onflow.org";
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;
const FLOW_NETWORK = "testnet";

const FUNGIBLETOKEN_ADDR = "0x9a0766d93b6608b7";
const FLOWTOKEN_ADDR = "0x7e60df042a9c0868";

const ACCOUNTS = [
    { name: "bob",     keyFile: "~/.flow/testnet-bob.json",     cadenceAddr: "0xd807a3992d7be612" },
    { name: "charlie", keyFile: "~/.flow/testnet-charlie.json", cadenceAddr: "0x3c601a443c81e6cd" },
    { name: "dave",    keyFile: "~/.flow/testnet-dave.json",    cadenceAddr: "0xd32d9100e1fe983b" },
    { name: "eve",     keyFile: "~/.flow/testnet-eve.json",    cadenceAddr: "0x374a28ddf00498e4" },
];

fcl.config({
    "accessNode.api": FLOW_ACCESS_API,
    "flow.network": FLOW_NETWORK,
});

async function getCOAAddress(keyFile: string): Promise<string> {
    const data = JSON.parse(fs.readFileSync(keyFile.replace(/^~/, process.env.HOME || ""), "utf-8"));
    const pkeyPath = data.pkeyPath.replace(/^~/, process.env.HOME || "");
    const pkHex = fs.readFileSync(path.resolve(pkeyPath), "utf-8").trim();
    const wallet = new ethers.Wallet(pkHex, new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID));
    return wallet.address;
}

async function main() {
    console.log("=== COA EVM Balance Check ===\n");

    for (const acct of ACCOUNTS) {
        const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
        const coaAddr = await getCOAAddress(acct.keyFile);
        const bal = await provider.getBalance(coaAddr);
        console.log(`${acct.name.padEnd(10)} COA=${coaAddr}  balance=${ethers.formatEther(bal)} FLOW`);
    }

    // Check if any need funding
    console.log("\n=== Checking if funding is needed ===\n");

    // The claucondor account can send FLOW on the EVM side too
    // Let me check the claucondor key
    const claucondorData = JSON.parse(fs.readFileSync(
        "~/.flow/testnet-claucondor.json".replace(/^~/, process.env.HOME || ""), "utf-8"));
    const claucondorPkeyPath = claucondorData.pkeyPath.replace(/^~/, process.env.HOME || "");
    const claucondorPkHex = fs.readFileSync(path.resolve(claucondorPkeyPath), "utf-8").trim();
    const claucondorWallet = new ethers.Wallet(claucondorPkHex, new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID));
    
    const claucondorBal = await claucondorWallet.provider.getBalance(claucondorWallet.address);
    console.log(`Claucondor EVM balance: ${ethers.formatEther(claucondorBal)} FLOW`);

    if (claucondorBal < ethers.parseEther("0.1")) {
        console.log("Claucondor EVM balance too low for funding. Need to bridge FLOW from Cadence side.");
        console.log("Please use flow CLI to bridge: flow-cadence-deploy agent should handle this.");
        return;
    }

    console.log("\n=== Funding COAs ===\n");
    for (const acct of ACCOUNTS) {
        const coaAddr = await getCOAAddress(acct.keyFile);
        const bal = await claucondorWallet.provider.getBalance(coaAddr);
        console.log(`${acct.name}: COA=${coaAddr}  balance=${ethers.formatEther(bal)} FLOW`);
        
        if (bal < ethers.parseEther("0.01")) {
            console.log(`  -> Sending 0.5 FLOW to ${coaAddr}...`);
            try {
                const tx = await claucondorWallet.sendTransaction({
                    to: coaAddr,
                    value: ethers.parseEther("0.5"),
                });
                await tx.wait();
                console.log(`  -> Done: ${tx.hash}`);
            } catch (err) {
                console.log(`  -> Failed: ${err.message}`);
            }
        } else {
            console.log(`  -> Already funded`);
        }
    }

    console.log("\n=== Done ===");
}

main().catch(console.error);
