/// One-time setup transaction: creates a Cadence Owned Account (COA) at
/// /storage/evm and publishes a public capability at /public/evm.
///
/// This is the bridge between the Cadence account and the Flow EVM side —
/// required before any shielded wrap/transfer/unwrap operation that calls
/// into JanusFlow on EVM.
///
/// Idempotent: if a COA already exists at /storage/evm, this transaction
/// does nothing. Safe to run multiple times.
///
/// After running this, fund the COA's EVM address with FLOW so it can pay
/// EVM gas. See `fund_coa.cdc` or use the home page "Fund COA" button.

import "EVM"

transaction {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        // Skip if COA already exists at /storage/evm
        if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) != nil {
            log("COA already exists at /storage/evm — skipping setup")
            return
        }

        // 1. Create a new COA resource and save it at /storage/evm
        let coa <- EVM.createCadenceOwnedAccount()
        log("Created COA with EVM address: ".concat(coa.address().toString()))
        signer.storage.save(<-coa, to: /storage/evm)

        // 2. Publish a public capability so other accounts / scripts can
        //    read the COA's EVM address without authorization.
        let cap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
        signer.capabilities.publish(cap, at: /public/evm)

        log("COA setup complete — ready for cross-VM shielded operations")
    }
}
