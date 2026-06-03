import { ethers } from "ethers";

const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;
const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);

const coas = [
    { name: "bob",     addr: "0xC9d6479E71CdD19BAE1CB293c26FE11a4094F1FB" },
    { name: "charlie", addr: "0x2264105e5F9a1dE62a731Df0c9f113f97E4c7506" },
    { name: "dave",    addr: "0x9e333486cFB6f0A2249F839DB1C1428dc2C0CA54" },
    { name: "eve",     addr: "0xb6772Ea350a0C3775170375ab0180349a85F3C09" },
];

async function main() {
    for (const c of coas) {
        const bal = await provider.getBalance(c.addr);
        console.log(`${c.name.padEnd(10)} ${c.addr}  balance: ${ethers.formatEther(bal)} FLOW`);
    }
}
main().catch(console.error);
