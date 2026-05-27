/// Pauses or unpauses the PrivateTip router.
///
/// When paused, sendTip and claimTip both revert. Existing in-custody tips are
/// inaccessible until unpaused — use this only as an emergency stop.
///
/// Only the signer holding the AdminResource at /storage/privateTipAdmin can run
/// this. The router account is the natural admin; capability delegation to a
/// multisig is a future enhancement.
///
/// @param paused  true = pause, false = unpause
///
import PrivateTip from "./../contracts/PrivateTip.cdc"

transaction(paused: Bool) {

    let adminRef: auth(PrivateTip.Pause) &PrivateTip.AdminResource

    prepare(signer: auth(BorrowValue) &Account) {
        self.adminRef = signer.storage.borrow<auth(PrivateTip.Pause) &PrivateTip.AdminResource>(
            from: PrivateTip.AdminStoragePath
        ) ?? panic(
            "Could not borrow PrivateTip.AdminResource with Pause entitlement from "
                .concat(PrivateTip.AdminStoragePath.toString())
        )
    }

    execute {
        if paused {
            self.adminRef.pause()
        } else {
            self.adminRef.unpause()
        }
    }
}
