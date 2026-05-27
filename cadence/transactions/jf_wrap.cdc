/// Wrap FLOW into the caller's shielded slot via JanusFlow Cadence router (v0.3).
///
/// The router withdraws FLOW from the signer's vault and calls
/// `JanusFlow.wrap(uint256[2] txCommit, uint256[8] amountProof)` on the EVM
/// proxy via the signer's COA. The amount-disclose Groth16 proof binds
/// `msg.value` (== amount) to the supplied Pedersen commitment.
///
/// msg.value is VISIBLE BY DESIGN — this is the wrap boundary.
///
/// @param amount        FLOW to wrap (UFix64; must be a whole number of wei)
/// @param txCommit      [Cx, Cy] — Pedersen commit of (amount in wei, blinding)
/// @param amountProof   uint256[8] amount-disclose Groth16 proof
/// @param calldataHex   ABI-encoded calldata for JanusFlow.wrap(uint256[2], uint256[8])

import "FlowToken"
import "FungibleToken"
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    amount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    calldataHex: String
) {
    let payment: @FlowToken.Vault
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        let vault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault for ".concat(signer.address.toString()))
        self.payment <- vault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        assert(txCommit.length == 2, message: "txCommit must be [Cx, Cy]")
        assert(amountProof.length == 8, message: "amountProof must be Groth16 [8]")

        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <- self.payment,
            txCommit: txCommit,
            amountProof: amountProof,
            calldataHex: calldataHex
        )
    }
}
