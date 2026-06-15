/// admin_reset_privatetip.cdc — Testnet-only: reset all PrivateTip state.
///
/// Wipes all recorded tip metadata and resets the ID counter to 1.
/// Useful during dev iteration and smoke testing without redeploying the contract.
///
/// Access control:
///   Must be signed by the deployer account (0x4b6bc58bc8bf5dcc), which holds
///   the AdminProof resource at PrivateTip.AdminStoragePath.
///   Any other signer will panic ("must be signed by deployer account").
///
/// TESTNET ONLY — do not include in mainnet deployment scripts.

import "PrivateTip"

transaction {
    prepare(signer: auth(BorrowValue) &Account) {
        let adminProof = signer.storage.borrow<auth(PrivateTip.Admin) &PrivateTip.AdminProof>(
            from: PrivateTip.AdminStoragePath
        ) ?? panic("admin_reset_privatetip: must be signed by deployer account (AdminProof not found)")

        PrivateTip.adminReset(admin: adminProof)

        log("admin_reset_privatetip: PrivateTip state cleared, ID counter reset to 1")
    }
}
