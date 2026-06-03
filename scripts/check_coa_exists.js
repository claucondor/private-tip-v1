const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org", 545);

async function main() {
    // Bob's COA
    const bobAddr = "0xC9d6479E71CdD19BAE1CB293c26FE11a4094F1FB";
    
    // Check balance
    let bal = await provider.getBalance(bobAddr);
    console.log("Bob COA balance (wei):", bal.toString());
    console.log("Bob COA balance (FLOW):", ethers.formatEther(bal));
    
    // Check nonce
    try {
        let nonce = await provider.getTransactionCount(bobAddr);
        console.log("Bob COA nonce:", nonce);
    } catch(e) {
        console.log("Bob COA nonce error:", e.message);
    }
    
    // Check code
    try {
        let code = await provider.getCode(bobAddr);
        console.log("Bob COA code:", code);
    } catch(e) {
        console.log("Bob COA code error:", e.message);
    }

    // Bob's COA as a wallet
    const bobKeyFile = (await fs.promises.readFile(
        (await fs.promises.realpath(path.join(process.env.HOME || "", ".flow/testnet-bob.json")))
    )).toString();
    const bobData = JSON.parse(bobKeyFile);
    const bobPkeyPath = bobData.pkeyPath.replace(/^~/, process.env.HOME || "");
    const bobPkHex = (await fs.promises.readFile(bobPkeyPath)).toString().trim();
    const bobWallet = new ethers.Wallet(bobPkHex, provider);
    console.log("Bob wallet address:", bobWallet.address);
    console.log("Bob wallet matches COA:", bobWallet.address.toLowerCase() === bobAddr.toLowerCase());
    
    // Now try the actual signer balance
    const signerBal = await provider.getBalance(bobWallet.address);
    console.log("Bob signer/wallet balance:", ethers.formatEther(signerBal), "FLOW");
}

main().catch(console.error);
