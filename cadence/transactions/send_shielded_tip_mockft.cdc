/// send_shielded_tip_mockft.cdc — Send a MockFT-backed shielded tip (Cadence-native path).
///
/// Atomically executes JanusFT.shieldedTransfer (pure Cadence) and records
/// tip metadata in PrivateTip. Both succeed or both revert.
///
/// Privacy: amount and memo are encrypted in the ECIES note delivered to the
/// recipient's ShieldedInbox. Only sender/recipient/token are publicly recorded.
///
/// Steps (all atomic in one Cadence transaction):
///   1. JanusFT.shieldedTransfer via CommitmentRegistry public capability
///      (Cadence-native — no EVM calldata required, COA still needed for ZK verifier call)
///   2. PrivateTip.recordTip stores public metadata
///
/// Parameters (built off-chain by SDK using JanusFTAdapter):
///   fromAccount      Sender's Cadence address
///   toAccount        Recipient's Cadence address (must have ShieldedInbox installed)
///   transferProof    [UInt256; 8] Groth16 confidential-transfer-aggregate proof
///   publicInputs     [UInt256; 6] [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
///   encryptedNoteTo  [UInt8] ECIES note for recipient (deposited to their NoteInbox)
///   ephPubToX        Ephemeral BabyJub pubkey X for recipient note ECDH
///   ephPubToY        Ephemeral BabyJub pubkey Y for recipient note ECDH
///
/// JanusFT Cadence deployer: 0x4b6bc58bc8bf5dcc

import "PrivateTip"
import "JanusFT"
import "EVM"

transaction(
    fromAccount:     Address,
    toAccount:       Address,
    transferProof:   [UInt256],
    publicInputs:    [UInt256],
    encryptedNoteTo: [UInt8],
    ephPubToX:       UInt256,
    ephPubToY:       UInt256
) {
    let registryRef: &{JanusFT.CommitmentRegistryPublic}
    let coa:         auth(EVM.Call) &EVM.CadenceOwnedAccount
    let senderRef:   auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        // Borrow the JanusFT commitment registry (deployed at 0x4b6bc58bc8bf5dcc).
        let deployerAddr = JanusFT.registryAddress()
        self.registryRef = getAccount(deployerAddr)
            .capabilities.borrow<&{JanusFT.CommitmentRegistryPublic}>(
                JanusFT.CommitmentRegistryPublicPath
            ) ?? panic("send_shielded_tip_mockft: JanusFT registry capability not published — operator must run setup_registry")

        // COA needed by JanusFT.shieldedTransfer for the EVM verifier call.
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("send_shielded_tip_mockft: no COA at /storage/evm — run setup_coa first")

        self.senderRef = signer
    }

    execute {
        // ── 1. JanusFT shielded transfer (Cadence-native) ──────────────────────
        // Verifies Groth16 ZK proof via EVM verifier (cross-VM), updates commitments,
        // and deposits ECIES note to toAccount's NoteInbox.
        self.registryRef.shieldedTransfer(
            fromAccount:     fromAccount,
            toAccount:       toAccount,
            transferProof:   transferProof,
            publicInputs:    publicInputs,
            encryptedNoteTo: encryptedNoteTo,
            ephPubToX:       ephPubToX,
            ephPubToY:       ephPubToY,
            coa:             self.coa
        )

        // ── 2. Record tip metadata (atomic with step 1) ────────────────────────
        // tokenContract is the Cadence deployer address (JanusFT lives at 0x4b6bc58bc8bf5dcc).
        PrivateTip.recordTip(
            sender:        self.senderRef,
            recipient:     toAccount,
            tokenContract: "0x4b6bc58bc8bf5dcc",
            tokenSymbol:   "MockFT"
        )
    }
}
