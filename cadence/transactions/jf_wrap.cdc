/// Wrap FLOW into a confidential slot via the JanusFlow Cadence router.
///
/// The router (1) withdraws FLOW from the signer's vault, (2) calls EVM JanusToken
/// via the signer's COA with the pre-encoded wrap calldata, and (3) updates the
/// recipient's commitment. Proves Cadence path is alive and proxies to v0.2.1 proxy.
///
/// @param amount       FLOW to wrap (UFix64)
/// @param recipient    Cadence Address of the recipient (whose slot will receive)
/// @param toEVMHex     Recipient's EVM/COA address (hex with 0x prefix)
/// @param ciphertext   128-byte accumulated ElGamal ciphertext (c1x||c1y||c2x||c2y)
/// @param senderNonce  Sender's current nonce on the EVM proxy
/// @param calldataHex  ABI-encoded calldata for JanusToken.wrap(...)
import "FlowToken"
import "FungibleToken"
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    amount: UFix64,
    recipient: Address,
    toEVMHex: String,
    ciphertext: [UInt8],
    senderNonce: UInt256,
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
        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <- self.payment,
            recipient: recipient,
            toEVMHex: toEVMHex,
            ciphertext: ciphertext,
            senderNonce: senderNonce,
            calldataHex: calldataHex
        )
    }
}
