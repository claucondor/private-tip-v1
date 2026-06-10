/// admin_reset.cdc — Test helper: reset PrivateTip state.
/// Succeeds only when signed by the deployer account that holds AdminProof.
/// Used by PrivateTip_test.cdc for both the happy-path and access-control tests.

import "PrivateTip"

transaction {
    prepare(signer: auth(BorrowValue) &Account) {
        let adminProof = signer.storage.borrow<auth(PrivateTip.Admin) &PrivateTip.AdminProof>(
            from: PrivateTip.AdminStoragePath
        ) ?? panic("not admin")

        PrivateTip.adminReset(admin: adminProof)
    }
}
