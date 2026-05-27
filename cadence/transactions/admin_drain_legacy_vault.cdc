/// Admin: drain a leftover v0.2 tipVault and deposit the FLOW into the recorded
/// recipient's FlowToken vault. Testnet cleanup function — clears `totalLocked`
/// down to zero as each leftover vault is drained.
///
/// The recipient is read from the existing TipRecord — the admin cannot redirect
/// funds. The recipient must have a published FlowToken Receiver capability at
/// /public/flowTokenReceiver (the Flow account default).
///
/// @param tipID  ID of the legacy v0.2 tip with a leftover vault.

import "FlowToken"
import "FungibleToken"
import PrivateTip from "./../contracts/PrivateTip.cdc"

transaction(tipID: UInt64) {

    let adminRef: auth(PrivateTip.Drain) &PrivateTip.AdminResource
    let recipient: Address

    prepare(signer: auth(BorrowValue) &Account) {
        self.adminRef = signer.storage.borrow<auth(PrivateTip.Drain) &PrivateTip.AdminResource>(
            from: PrivateTip.AdminStoragePath
        ) ?? panic(
            "Could not borrow PrivateTip.AdminResource with Drain entitlement from "
                .concat(PrivateTip.AdminStoragePath.toString())
        )

        let tip = PrivateTip.getTip(tipID: tipID)
            ?? panic("admin_drain_legacy_vault: tip ".concat(tipID.toString()).concat(" does not exist"))
        self.recipient = tip.recipient
    }

    execute {
        let vault <- self.adminRef.drainLegacyVault(tipID: tipID)
        let amount = vault.balance

        // Deposit into the recipient's default FlowToken receiver.
        let recipientAcct = getAccount(self.recipient)
        let receiverRef = recipientAcct.capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic(
                "admin_drain_legacy_vault: recipient "
                    .concat(self.recipient.toString())
                    .concat(" has no FungibleToken.Receiver at /public/flowTokenReceiver")
            )

        receiverRef.deposit(from: <- vault)

        log("Drained ".concat(amount.toString()).concat(" FLOW from legacy tipVault #").concat(tipID.toString()))
    }
}
