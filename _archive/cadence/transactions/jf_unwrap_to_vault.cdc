/// Unwrap FLOW from the caller's shielded slot + deposit straight into the
/// signer's Cadence FlowToken.Vault — atomic single-tx variant (v0.3).
///
/// PRIVACY: identical to `jf_unwrap.cdc`. claimedAmount + recipient are
/// VISIBLE on calldata + the JanusFlow.Unwrapped event — this is the unwrap
/// boundary. The only difference is what happens AFTER the EVM call settles:
/// we sweep the freshly-released FLOW from the COA into the signer's Cadence
/// FungibleToken vault so the user sees the balance update in their wallet
/// immediately (no follow-up COA -> vault tx).
///
/// FLOW:
///   1. Snapshot the signer's COA attoFLOW balance (read-only borrow).
///   2. Call `JanusFlow.unwrap(...)` with recipient = signer's COA EVM hex.
///      EVM JanusFlow.unwrap forwards `claimedAmount` attoFLOW via
///      `recipient.call{value: ...}` so the funds land in the COA.
///      The router internally borrows the COA with `auth(EVM.Call)`.
///   3. Re-borrow the COA (now with `auth(EVM.Withdraw)`) and compute the
///      delta. Withdraw it as a FlowToken.Vault and deposit into the signer's
///      Cadence `/storage/flowTokenVault`.
///
/// Why two separate borrows: the router's internal borrow uses a different
/// entitlement (`EVM.Call`) than what we need (`EVM.Withdraw`). Re-borrowing
/// after the router returns is the cleanest way to avoid holding two
/// overlapping references across an external call.
///
/// @param claimedAmount         UFix64 FLOW being unwrapped
/// @param txCommit              [Cx, Cy] for amount-disclose
/// @param amountProof           uint256[8] amount-disclose proof
/// @param transferPublicInputs  uint256[6] [C_old, C_tx, C_new]
/// @param transferProof         uint256[8] confidential-transfer proof
/// @param calldataHex           ABI-encoded calldata for JanusFlow.unwrap(...)
///                              with recipient == signer's COA EVM hex

import "FlowToken"
import "FungibleToken"
import "EVM"
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    transferPublicInputs: [UInt256],
    transferProof: [UInt256],
    calldataHex: String
) {
    let signerRef: auth(BorrowValue) &Account
    let preBalance: UInt
    let recipientEVMHex: String

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer

        // Read-only snapshot of the COA balance + address. We don't need
        // EVM.Withdraw yet — that will be re-borrowed in execute after the
        // router's own EVM.Call borrow has returned.
        let coaSnap = signer.storage
            .borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_unwrap_to_vault: no COA at /storage/evm — run setup_coa.cdc first")
        self.preBalance = coaSnap.balance().attoflow
        self.recipientEVMHex = coaSnap.address().toString()
    }

    execute {
        // Step 1: standard unwrap. EVM JanusFlow will send claimedAmount
        // attoFLOW to recipientEVMHex (== our own COA address) via
        // `recipient.call{value: ...}`.
        JanusFlow.unwrap(
            signer: self.signerRef,
            claimedAmount: claimedAmount,
            recipientEVMHex: self.recipientEVMHex,
            txCommit: txCommit,
            amountProof: amountProof,
            transferPublicInputs: transferPublicInputs,
            transferProof: transferProof,
            calldataHex: calldataHex
        )

        // Step 2: re-borrow with EVM.Withdraw and sweep the unwrapped FLOW
        // into the signer's Cadence vault. We compute the actual delta
        // rather than trusting `claimedAmount` (EVM rounding might differ
        // by 1 wei from the UFix64-derived value).
        let coa = self.signerRef.storage
            .borrow<auth(EVM.Withdraw) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_unwrap_to_vault: COA disappeared after unwrap (impossible)")

        let postBalance = coa.balance().attoflow
        assert(
            postBalance > self.preBalance,
            message: "jf_unwrap_to_vault: COA balance did not increase after unwrap"
        )
        let received: UInt = postBalance - self.preBalance

        let withdrawn <- coa.withdraw(balance: EVM.Balance(attoflow: received))

        let vault = self.signerRef.storage
            .borrow<&FlowToken.Vault>(from: /storage/flowTokenVault)
            ?? panic("jf_unwrap_to_vault: no FlowToken.Vault at /storage/flowTokenVault")

        vault.deposit(from: <- withdrawn)
    }
}
