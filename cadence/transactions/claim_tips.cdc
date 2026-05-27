/// Claims one or more tips from the PrivateTip router.
///
/// Vuln 015 FIX: claim is gated by the transaction signer's auth-ref. The router
/// asserts tip.recipient == signer.address using the SIGNER (NOT the contract
/// account), so only the intended recipient can actually withdraw the FLOW.
///
/// The withdrawn FLOW is deposited into the signer's own FlowToken vault.
///
/// @param tipIDs  IDs of the tips to claim
///
import PrivateTip from "./../contracts/PrivateTip.cdc"
import "FungibleToken"
import "FlowToken"

transaction(tipIDs: [UInt64]) {

    let signerRef: auth(BorrowValue) &Account
    let receiver: &{FungibleToken.Receiver}

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        self.receiver = signer.capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic(
                "Could not borrow FlowToken.Receiver for signer "
                    .concat(signer.address.toString())
            )
    }

    execute {
        for tipID in tipIDs {
            let vault <- PrivateTip.claimTip(
                signer: self.signerRef,
                tipID: tipID
            )
            self.receiver.deposit(from: <-vault)
        }
    }
}
