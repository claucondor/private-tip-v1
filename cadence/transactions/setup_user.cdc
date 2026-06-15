/// setup_user.cdc — Combined onboarding transaction for PrivateTip v0.8.
///
/// Installs all three components needed to participate as a sender or recipient,
/// then registers the user's BabyJub memo key with MemoKeyRegistry.
/// Idempotent: safe to run multiple times (inbox + checkpoint guards skip if present).
///
/// Steps (all atomic):
///   1. Install ShieldedInbox.NoteInbox at /storage/shieldedInbox + publish Receiver cap
///   2. Install ShieldedCheckpoint.Checkpoint at /storage/shieldedCheckpoint + publish Metadata cap
///   3. Call MemoKeyRegistry.publishMemoKey via COA (overwrites if key was previously set)
///
/// Prerequisites:
///   - Signer must have a COA at /storage/evm (run admin-transactions/setup_coa.cdc first)
///
/// Parameters:
///   memoKeyCalldata  Hex-encoded calldata for MemoKeyRegistry.publishMemoKey(bytes32,bytes32).
///                    Built off-chain by the SDK using the user's BabyJub public key.
///                    Pass "0x" or "" to skip key registration (e.g. if already published).
///   gasLimit         EVM gas limit for the MemoKeyRegistry call (80_000 is sufficient).
///
/// MemoKeyRegistry EVM: 0x361bD4d037838A3a9c5408AE465d36077800ee6c

import "ShieldedInbox"
import "ShieldedCheckpoint"
import "EVM"

transaction(memoKeyCalldata: String, gasLimit: UInt64) {

    let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(
        signer: auth(
            SaveValue,
            BorrowValue,
            IssueStorageCapabilityController,
            PublishCapability
        ) &Account
    ) {
        // Require COA — must be set up beforehand via setup_coa.cdc.
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("setup_user: no COA at /storage/evm — run setup_coa first")

        // ── 1. Install ShieldedInbox ────────────────────────────────────────────
        if signer.storage.borrow<&ShieldedInbox.NoteInbox>(
            from: /storage/shieldedInbox
        ) == nil {
            let inbox <- ShieldedInbox.createInbox(owner: signer.address)
            signer.storage.save(<-inbox, to: /storage/shieldedInbox)

            let receiverCap = signer.capabilities.storage
                .issue<&{ShieldedInbox.Receiver}>(/storage/shieldedInbox)
            signer.capabilities.publish(receiverCap, at: /public/shieldedInbox)

            log("setup_user: ShieldedInbox installed")
        } else {
            log("setup_user: ShieldedInbox already installed — skipping")
        }

        // ── 2. Install ShieldedCheckpoint ──────────────────────────────────────
        if signer.storage.borrow<&ShieldedCheckpoint.Checkpoint>(
            from: /storage/shieldedCheckpoint
        ) == nil {
            let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
            signer.storage.save(<-cp, to: /storage/shieldedCheckpoint)

            let metaCap = signer.capabilities.storage
                .issue<&{ShieldedCheckpoint.Metadata}>(/storage/shieldedCheckpoint)
            signer.capabilities.publish(metaCap, at: /public/shieldedCheckpoint)

            log("setup_user: ShieldedCheckpoint installed")
        } else {
            log("setup_user: ShieldedCheckpoint already installed — skipping")
        }
    }

    execute {
        // ── 3. Register BabyJub memo key with MemoKeyRegistry ──────────────────
        // Skip if caller passes empty calldata (key already registered or not needed yet).
        if memoKeyCalldata == "" || memoKeyCalldata == "0x" {
            log("setup_user: memo key registration skipped (empty calldata)")
            return
        }

        let registry = EVM.addressFromString("361bD4d037838A3a9c5408AE465d36077800ee6c")
        let result   = self.coa.call(
            to:       registry,
            data:     memoKeyCalldata.decodeHex(),
            gasLimit: gasLimit,
            value:    EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "setup_user: MemoKeyRegistry.publishMemoKey reverted — "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
        )

        log("setup_user: memo key published to MemoKeyRegistry")
    }
}
