/// Send a SHIELDED tip with an ENCRYPTED memo (v0.4.1 — clean break from v0.3).
///
/// This is the v0.4.1 path. PrivateTip is a pure orchestrator — it does NOT
/// custody FLOW. The transaction:
///
///   1. Calls JanusFlow.shieldedTransfer (Cadence) which orchestrates the
///      EVM JanusFlow proxy's shieldedTransfer via the signer's COA. The EVM
///      side debits the sender's Pedersen-commit and credits the recipient's
///      Pedersen-commit homomorphically — amount is HIDDEN on calldata,
///      events, and storage updates.
///
///   2. Calls PrivateTip.recordTip(...) with the encrypted-memo payload.
///      TipSentShielded carries the AES-GCM ciphertext + ephemeral pubkey;
///      ONLY the recipient (who holds the matching MemoKey privkey) can
///      decrypt. The plaintext memo NEVER touches the chain.
///
/// Atomicity: if either call reverts, the whole Cadence transaction aborts.
///
/// Pre-conditions:
///   1. Signer must have a COA at /storage/evm.
///   2. Signer's JanusFlow EVM commitment must already hold >= transferAmount.
///   3. Recipient must have a published MemoKey at /public/openjanusMemoKey
///      (signer reads it off-chain via PrivateTip.getMemoPubkey to encrypt).
///   4. Calldata for the EVM shieldedTransfer must be ABI-encoded off-chain.
///
/// IMPORTANT: ciphertextRef passed to recordTip MUST be [C_tx.x, C_tx.y] —
/// i.e. publicInputs[2..3]. This is the per-transfer commitment that lets
/// indexers correlate the Cadence record with the EVM event.
///
/// @param recipient          Flow address of the recipient (for Cadence indexing)
/// @param recipientEVMHex    Recipient's COA EVM hex (target of EVM shieldedTransfer)
/// @param publicInputs       uint256[6] for the confidential_transfer circuit
/// @param proof              uint256[8] Groth16 proof (pi_b Fp2-swapped)
/// @param calldataHex        Pre-encoded EVM calldata (built via SDK)
/// @param memoCiphertext     AES-GCM ciphertext blob (empty = no memo)
/// @param memoEphPubkeyX/Y   Sender's ephemeral BabyJub pubkey (for ECDH)

import JanusFlow from 0x5dcbeb41055ec57e
import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    recipient: Address,
    recipientEVMHex: String,
    publicInputs: [UInt256],
    proof: [UInt256],
    calldataHex: String,
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256
) {

    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        assert(
            publicInputs.length == 6,
            message: "send_shielded_tip: publicInputs must be exactly 6 UInt256 (C_old, C_tx, C_new)"
        )
        assert(
            proof.length == 8,
            message: "send_shielded_tip: proof must be exactly 8 UInt256 (Groth16 pi_a, pi_b, pi_c)"
        )

        // 1. Shielded value transfer.
        JanusFlow.shieldedTransfer(
            signer: self.signerRef,
            toEVMHex: recipientEVMHex,
            publicInputs: publicInputs,
            proof: proof,
            calldataHex: calldataHex
        )

        // 2. Extract C_tx = publicInputs[2..3] as the ciphertextRef.
        let ciphertextRef: [UInt256] = [publicInputs[2], publicInputs[3]]

        // 3. Record metadata with the encrypted memo blob.
        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: recipient,
            ciphertextRef: ciphertextRef,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY
        )

        log("PrivateTip.recordTip emitted shielded tipID=".concat(tipID.toString()))
    }
}
