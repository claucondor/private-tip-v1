/**
 * Fund COA wallets by bridging FLOW from Cadence vault to EVM COA.
 * Uses FCL properly with correct authorization format.
 * 
 * Usage:
 *   npx ts-node --transpile-only scripts/fund_coas_v2.ts
 */

import * as fcl from "@onflow/fcl";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const FLOW_ACCESS_API = "https://rest-testnet.onflow.org";
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;
const FLOW_NETWORK = "testnet";

const FUNGIBLETOKEN_ADDR = "0x9a0766d93b6608b7";
const FLOWTOKEN_ADDR = "0x7e60df042a9c0868";

fcl.config({
    "accessNode.api": FLOW_ACCESS_API,
    "flow.network": FLOW_NETWORK,
});

const ACCOUNTS = [
    { name: "bob",     keyFile: "~/.flow/testnet-bob.json",     cadenceAddr: "0xd807a3992d7be612" },
    { name: "charlie", keyFile: "~/.flow/testnet-charlie.json", cadenceAddr: "0x3c601a443c81e6cd" },
    { name: "dave",    keyFile: "~/.flow/testnet-dave.json",    cadenceAddr: "0xd32d9100e1fe983b" },
    { name: "eve",     keyFile: "~/.flow/testnet-eve.json",    cadenceAddr: "0x374a28ddf00498e4" },
];

function loadAccount(keyFile: string): { address: string; privateKey: string; keyId: number } {
    const resolvedPath = keyFile.replace(/^~/, process.env.HOME || "");
    const data = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
    const pkeyPath = data.pkeyPath.replace(/^~/, process.env.HOME || "");
    const pkHex = fs.readFileSync(path.resolve(pkeyPath), "utf-8").trim();
    return {
        address: fcl.withPrefix(data.address),
        privateKey: pkHex,
        keyId: data.keyIndex ?? 0,
    };
}

function buildAuth(acct: { address: string; privateKey: string; keyId: number }) {
    return async (account: any) => {
        const { SHA3_256, SignatureAlgorithm } = await import("@onflow/typedefs");
        return {
            addr: acct.address,
            keyId: String(acct.keyId),
            signature: async (signable: any) => {
                const { signWithKey } = await import("@onflow/sdk");
                const sig = await signWithKey(
                    Buffer.from(signable.message, "hex"),
                    Buffer.from(acct.privateKey, "hex"),
                    {
                        hashAlgorithm: SHA3_256,
                        signatureAlgorithm: SignatureAlgorithm.ECDSA_P256,
                    }
                );
                return sig;
            },
        };
    };
}

async function main() {
    // First check Cadence balances
    console.log("=== Checking Cadence balances ===\n");
    
    for (const acctInfo of ACCOUNTS) {
        const acct = loadAccount(acctInfo.keyFile);
        try {
            const balScript = `
                import FungibleToken from ${FUNGIBLETOKEN_ADDR}
                import FlowToken from ${FLOWTOKEN_ADDR}
                access(all) fun main(addr: Address): UFix64 {
                    let acct = getAccount(addr)
                    let vaultRef = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
                        ?? panic("no balance")
                    return vaultRef.balance
                }
            `;
            const balance = await fcl.query({ cadence: balScript, args: (arg, t) => [arg(acct.address, t.Address)] });
            console.log(`${acctInfo.name.padEnd(10)} ${acct.address}  balance: ${balance} FLOW`);
        } catch (err: any) {
            console.log(`${acctInfo.name.padEnd(10)} ${acct.address}  error: ${err.message}`);
        }
    }

    // Check COA EVM balances
    console.log("\n=== Checking COA EVM balances ===\n");
    const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
    
    for (const acctInfo of ACCOUNTS) {
        const acct = loadAccount(acctInfo.keyFile);
        const wallet = new ethers.Wallet(acct.privateKey, provider);
        const bal = await provider.getBalance(wallet.address);
        console.log(`${acctInfo.name.padEnd(10)} COA=${wallet.address}  EVM balance: ${ethers.formatEther(bal)} FLOW`);
    }

    // Fund COAs that need it
    console.log("\n=== Funding COA wallets (bridging 0.5 FLOW each) ===\n");

    const depositCadence = `
        import FungibleToken from ${FUNGIBLETOKEN_ADDR}
        import FlowToken from ${FLOWTOKEN_ADDR}
        import EVM

        transaction(amount: UFix64) {
            let vault: @FlowToken.Vault

            prepare(signer: auth(BorrowValue) &Account) {
                let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
                    from: /storage/flowTokenVault
                ) ?? panic("No FlowToken.Vault")
                self.vault <- flowVault.withdraw(amount: amount)
            }

            execute {
                let coa = signer.evm
                coa.deposit(from: <-self.vault)
            }
        }
    `;

    for (const acctInfo of ACCOUNTS) {
        const acct = loadAccount(acctInfo.keyFile);
        const wallet = new ethers.Wallet(acct.privateKey, provider);
        const evmBal = await provider.getBalance(wallet.address);

        if (evmBal >= ethers.parseEther("0.01")) {
            console.log(`${acctInfo.name}: already has ${ethers.formatEther(evmBal)} FLOW on EVM - skipping`);
            continue;
        }

        console.log(`${acctInfo.name}: bridging 0.5 FLOW to COA...`);
        try {
            const authz = buildAuth(acct);
            const txId = await fcl.mutate({
                cadence: depositCadence,
                args: (arg, t) => [arg("0.5", t.UFix64)],
                proposer: authz,
                payer: authz,
                authorizations: [authz],
                limit: 9999,
            });
            console.log(`  tx submitted: ${txId}`);
            await fcl.tx(txId).onceSealed();
            console.log(`  tx sealed ✓`);
        } catch (err: any) {
            console.log(`  FAILED: ${err.message}`);
            // Print stack for debugging
            if (err.stack) {
                console.log(`  ${err.stack.split('\n').slice(0, 3).join('\n')}`);
            }
        }
    }

    // Final check
    console.log("\n=== Final COA EVM balances ===\n");
    for (const acctInfo of ACCOUNTS) {
        const acct = loadAccount(acctInfo.keyFile);
        const wallet = new ethers.Wallet(acct.privateKey, provider);
        const bal = await provider.getBalance(wallet.address);
        console.log(`${acctInfo.name.padEnd(10)} COA=${wallet.address}  EVM balance: ${ethers.formatEther(bal)} FLOW`);
    }
}

main().catch(console.error);
