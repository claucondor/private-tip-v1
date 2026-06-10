/// claim_batch_ft.cdc — Aggregate JanusFT inbox notes into a single fresh commitment.
///
/// Calls JanusFT.claimBatch() directly (v0.8.1 contract-level function).
/// The signer provides a COA for the cross-VM ZK proof verification call.
/// Any account with a COA can sign on behalf of any `account` — the ZK proof
/// enforces that only the owner of the current commitment can produce a valid proof.
///
/// Public input layout (ConfidentialClaimBatch, N=50):
///   [0..1] C_old      — current on-chain commitment (must match)
///   [2..3] C_new      — new commitment after aggregation
///   [4..5] C_consumed — homomorphic sum of consumed note commitments
///
/// Proof format: flat [UInt256; 8] in EVM-swapped order
///   (pB already Fp2-swapped — JanusFT._verifyBatchClaimProof reads [proof[2..5]] as EVM pB).

import "JanusFT"
import "EVM"

transaction(
    account:      Address,
    publicInputs: [UInt256],
    proof:        [UInt256]
) {
    let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("claim_batch_ft: signer has no COA at /storage/evm — run setup_coa first")
    }

    execute {
        JanusFT.claimBatch(
            account:      account,
            publicInputs: publicInputs,
            proof:        proof,
            coa:          self.coa
        )
    }
}
