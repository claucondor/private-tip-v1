/// Admin transaction for PrivateTip impl-swap workflow.
///
/// The PrivateTip router uses a swappable IPrivateTipImpl. Swaps follow a 48h
/// time-lock so apps can react. This transaction supports three actions via an
/// `action` parameter:
///
///   "propose"  — schedule a new impl version; starts 48h lock
///   "finalize" — finalize after lock has expired
///   "cancel"   — cancel the pending swap (no lock)
///
/// @param action          One of "propose", "finalize", "cancel"
/// @param newImplVersion  Required for "propose"; ignored otherwise
///
import PrivateTip from "./../contracts/PrivateTip.cdc"

transaction(action: String, newImplVersion: String) {

    let adminRef: auth(PrivateTip.Upgrade) &PrivateTip.AdminResource

    prepare(signer: auth(BorrowValue) &Account) {
        self.adminRef = signer.storage.borrow<auth(PrivateTip.Upgrade) &PrivateTip.AdminResource>(
            from: PrivateTip.AdminStoragePath
        ) ?? panic(
            "Could not borrow PrivateTip.AdminResource with Upgrade entitlement from "
                .concat(PrivateTip.AdminStoragePath.toString())
        )
    }

    execute {
        if action == "propose" {
            assert(newImplVersion.length > 0, message: "newImplVersion required for propose")
            self.adminRef.proposeImplSwap(newVersion: newImplVersion)
        } else if action == "finalize" {
            self.adminRef.finalizeImplSwap()
        } else if action == "cancel" {
            self.adminRef.cancelImplSwap()
        } else {
            panic("unknown action: ".concat(action).concat(" (expected: propose, finalize, cancel)"))
        }
    }
}
