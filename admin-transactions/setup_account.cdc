/// Smart setup — create COA AND MemoKey in a single atomic tx (v0.4.1).
///
/// Idempotent: each step early-returns if the resource already exists.
/// One transaction takes the user from "fresh Cadence account" to "ready
/// to send and receive shielded encrypted-memo tips".
///
/// The (privkey, pubkeyX, pubkeyY) triple for the MemoKey is generated
/// OFF-CHAIN in the signer's browser via @openjanus/sdk's
/// generateBabyJubKeypair() and passed in as UInt256 arguments.

import "EVM"
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    memoPrivkey: UInt256,
    memoPubkeyX: UInt256,
    memoPubkeyY: UInt256
) {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability, BorrowValue) &Account) {

        // ─── 1. COA at /storage/evm + /public/evm ──────────────────────────────
        if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) == nil {
            let coa <- EVM.createCadenceOwnedAccount()
            log("Created COA with EVM address: ".concat(coa.address().toString()))
            signer.storage.save(<-coa, to: /storage/evm)
            let coaCap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
            signer.capabilities.publish(coaCap, at: /public/evm)
        } else {
            log("COA already exists at /storage/evm — skipping")
        }

        // ─── 2. MemoKey at /storage/openjanusMemoKey + /public/openjanusMemoKey ─
        let memoStoragePath = PrivateTip.memoKeyStoragePath()
        let memoPublicPath = PrivateTip.memoKeyPublicPath()

        if signer.storage.borrow<&PrivateTip.MemoKey>(from: memoStoragePath) == nil {
            let key <- PrivateTip.createMemoKey(
                privkey: memoPrivkey,
                pubkeyX: memoPubkeyX,
                pubkeyY: memoPubkeyY
            )
            signer.storage.save(<-key, to: memoStoragePath)
            let memoCap = signer.capabilities.storage.issue<&{PrivateTip.MemoKeyPublic}>(memoStoragePath)
            signer.capabilities.publish(memoCap, at: memoPublicPath)
            log("MemoKey published at ".concat(memoPublicPath.toString()))
        } else {
            log("MemoKey already exists at ".concat(memoStoragePath.toString()).concat(" — skipping"))
        }
    }
}
