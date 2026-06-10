/**
 * Cross-VM transactions that publish state to BOTH Cadence storage AND EVM via COA.
 * These run from FCL with a single Flow Wallet signature — NO ethers.BrowserProvider,
 * NO MetaMask, NO Rainbow, NO window.ethereum.
 */

import { MEMO_REGISTRY_ADDRESS } from "@claucondor/sdk/network";

const CADENCE_DEPLOYER = "0x4b6bc58bc8bf5dcc";    // v0.8 openjanus-v08
const EVM_SYSTEM_CONTRACT = "0x8c5303eaa26202d6"; // testnet EVM system contract

/**
 * Publish the user's BabyJub memokey to both Cadence storage and the shared EVM
 * MemoKeyRegistry. Covers ALL four Janus token adapters in a single tx.
 *
 * Caller must have a COA at /storage/evm.
 * Args: memoPubX (UInt256), memoPubY (UInt256)
 *
 * After this tx the user's memo key is available from:
 *   - Cadence storage (/storage/openjanusMemoKey) — JanusFT + future Cadence tokens
 *   - EVM MemoKeyRegistry (${MEMO_REGISTRY_ADDRESS}) — JanusFlow, JanusERC20 proxies
 */
export const TX_PUBLISH_MEMOKEY_XVM = `
import JanusFT from ${CADENCE_DEPLOYER}
import JanusFlow from ${CADENCE_DEPLOYER}
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(memoPubX: UInt256, memoPubY: UInt256) {
    prepare(signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability, SaveValue, Storage) &Account) {

        // ----------------------------------------------------------------
        // 1. Publish to Cadence storage path.
        //    JanusFT.publishMemoKey writes to /storage/openjanusMemoKey
        //    (shared with JanusFlow.MemoKey resource — one path, all Cadence tokens).
        // ----------------------------------------------------------------
        JanusFT.publishMemoKey(
            account: signer,
            pubkeyX: memoPubX,
            pubkeyY: memoPubY
        )

        // ----------------------------------------------------------------
        // 2. Publish to EVM MemoKeyRegistry via COA cross-VM call.
        //    msg.sender in the EVM call is the user's COA address, which is
        //    the identity used by the EVM Janus token adapters.
        // ----------------------------------------------------------------
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")

        let memoRegistryAddr = EVM.addressFromString("${MEMO_REGISTRY_ADDRESS}")

        // ABI-encode: publishMemoKey(uint256,uint256)
        // selector = keccak256("publishMemoKey(uint256,uint256)")[0:4] = 0xe50a8aad
        let calldata = EVM.encodeABIWithSignature(
            "publishMemoKey(uint256,uint256)",
            [memoPubX, memoPubY]
        )

        let result = coa.call(
            to: memoRegistryAddr,
            data: calldata,
            gasLimit: 100000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
        )
    }
}
`;
