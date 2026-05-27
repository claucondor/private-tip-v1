/// Admin: force-set activeImplVersion without going through the 48h time-lock.
/// Intended for the one-time v0.2 → v0.3 cutover.
///
/// All subsequent upgrades should use admin_upgrade.cdc (propose → wait 48h →
/// finalize) so apps can react.
///
/// @param version  e.g. "0.3.0"

import PrivateTip from "./../contracts/PrivateTip.cdc"

transaction(version: String) {

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
        self.adminRef.forceSetImplVersion(version: version)
    }
}
