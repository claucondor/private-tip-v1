/// Unwrap FLOW from the caller's shielded slot via JanusFlow router (v0.3).
///
/// Calls JanusFlow.unwrap(...) which:
///   1. Calls the EVM JanusFlow proxy via signer's COA to release the claimed
///      amount to `recipientEVMHex`.
///   2. Verifies amount-disclose proof (claimedAmount ↔ txCommit) and
///      confidential-transfer proof (storedCommit = txCommit + newCommit).
///
/// claimedAmount and recipient are VISIBLE — this is the unwrap boundary.
///
/// @param claimedAmount         UFix64 FLOW being unwrapped
/// @param recipientEVMHex       EVM hex address to receive the FLOW
/// @param txCommit              [Cx, Cy] for amount-disclose
/// @param amountProof           uint256[8] amount-disclose proof
/// @param transferPublicInputs  uint256[6] [C_old, C_tx, C_new]
/// @param transferProof         uint256[8] confidential-transfer proof
/// @param calldataHex           ABI-encoded calldata for JanusFlow.unwrap(...)

import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    recipientEVMHex: String,
    txCommit: [UInt256],
    amountProof: [UInt256],
    transferPublicInputs: [UInt256],
    transferProof: [UInt256],
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.unwrap(
            signer: signer,
            claimedAmount: claimedAmount,
            recipientEVMHex: recipientEVMHex,
            txCommit: txCommit,
            amountProof: amountProof,
            transferPublicInputs: transferPublicInputs,
            transferProof: transferProof,
            calldataHex: calldataHex
        )
    }
}
