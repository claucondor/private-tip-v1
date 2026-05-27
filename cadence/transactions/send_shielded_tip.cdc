/// Send a SHIELDED tip — amount HIDDEN via JanusFlow.shieldedTransfer (v0.3).
///
/// This is THE v0.3 path. PrivateTip is now a pure orchestrator — it does
/// NOT custody FLOW. The transaction:
///
///   1. Calls JanusFlow.shieldedTransfer (Cadence) which orchestrates the
///      EVM JanusFlow proxy's shieldedTransfer via the signer's COA. The EVM
///      side debits the sender's Pedersen-commit and credits the recipient's
///      Pedersen-commit homomorphically — amount is HIDDEN on calldata,
///      events, and storage updates.
///
///   2. Calls PrivateTip.recordTip(...) which writes a TipRecord with
///      amount = 0.0 (sentinel for "shielded") and emits TipSentShielded
///      WITHOUT an amount field.
///
/// Atomicity: if either call reverts, the whole Cadence transaction aborts.
/// You get either both (shielded transfer + metadata record) or neither.
///
/// Pre-conditions:
///   1. Signer must have a COA at /storage/evm.
///   2. Signer's JanusFlow EVM commitment must already hold >= transferAmount
///      (pre-fund via JanusFlow.wrap → "Wrap N FLOW first to enable tips").
///   3. Calldata for the EVM `shieldedTransfer(...)` must be ABI-encoded
///      off-chain (see SDK helper `buildShieldedTransferCalldata`).
///
/// EVM contract signature (for reference):
///   function shieldedTransfer(
///     address to,
///     uint256[6] publicInputs,
///     uint256[8] proof
///   ) external;
///
/// publicInputs layout (matches confidential_transfer.circom):
///   [0..1] C_old  — sender's stored commitment (Pedersen)
///   [2..3] C_tx   — Pedersen(transferAmount, transferBlinding)
///   [4..5] C_new  — sender's residual commitment
///
/// IMPORTANT: ciphertextRef passed to recordTip MUST be [C_tx.x, C_tx.y] —
/// i.e. publicInputs[2..3]. This is the per-transfer commitment that lets
/// indexers correlate the Cadence record with the EVM event.
///
/// @param recipient        Flow address of the recipient (for Cadence indexing)
/// @param recipientEVMHex  Recipient's COA EVM hex (target of EVM shieldedTransfer)
/// @param publicInputs     uint256[6] for the confidential_transfer circuit
/// @param proof            uint256[8] Groth16 proof (pi_b Fp2-swapped)
/// @param calldataHex      Pre-encoded EVM calldata (built via SDK)
/// @param memo             Optional public memo (max 280 chars; empty = nil)

import JanusFlow from 0x5dcbeb41055ec57e
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    recipient: Address,
    recipientEVMHex: String,
    publicInputs: [UInt256],
    proof: [UInt256],
    calldataHex: String,
    memo: String
) {

    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        // Sanity: publicInputs must be exactly 6 (C_old, C_tx, C_new each = 2).
        assert(
            publicInputs.length == 6,
            message: "send_shielded_tip: publicInputs must be exactly 6 UInt256 (C_old, C_tx, C_new)"
        )
        assert(
            proof.length == 8,
            message: "send_shielded_tip: proof must be exactly 8 UInt256 (Groth16 pi_a, pi_b, pi_c)"
        )

        // 1. Shielded value transfer — JanusFlow drives the EVM call.
        JanusFlow.shieldedTransfer(
            signer: self.signerRef,
            toEVMHex: recipientEVMHex,
            publicInputs: publicInputs,
            proof: proof,
            calldataHex: calldataHex
        )

        // 2. Extract C_tx = publicInputs[2..3] as the ciphertextRef stored in
        // the metadata record. Indexers correlate this with the EVM
        // ConfidentialTransfer event's storage update.
        let ciphertextRef: [UInt256] = [publicInputs[2], publicInputs[3]]

        // 3. Convert empty memo to nil.
        let memoOpt: String? = memo.length > 0 ? memo : nil

        // 4. Record metadata on Cadence side. NO amount field.
        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: recipient,
            ciphertextRef: ciphertextRef,
            memo: memoOpt
        )

        log("PrivateTip.recordTip emitted shielded tipID=".concat(tipID.toString()))
    }
}
