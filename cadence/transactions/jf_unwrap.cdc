/// Unwrap FLOW via the JanusFlow Cadence router.
///
/// The router (1) calls EVM JanusToken via the signer's COA with the unwrap calldata,
/// (2) clears the signer's commitment, and (3) releases FLOW from the router's vault
/// into `recipient`'s FlowToken vault.
///
/// @param claimedAmount  Amount in UFix64 FLOW being unwrapped (matches ZK proof)
/// @param recipient      Cadence Address to receive the released FLOW
/// @param calldataHex    ABI-encoded calldata for JanusToken.unwrap(claimedUnits, ...)
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    recipient: Address,
    calldataHex: String
) {
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        JanusFlow.unwrap(
            signer: self.signerRef,
            claimedAmount: claimedAmount,
            recipient: recipient,
            calldataHex: calldataHex
        )
    }
}
