/// Wrap FLOW into the caller's shielded slot — COA-source variant (v0.3).
///
/// Identical privacy semantics to `jf_wrap.cdc` (msg.value VISIBLE at the wrap
/// boundary, commitment opaque after), but the FLOW comes from the signer's
/// Cadence Owned Account (EVM-side balance) instead of their Cadence
/// FlowToken.Vault.
///
/// WHY: Many Flow users hold FLOW on the EVM side (because their dApp / DeFi
/// activity lives there). Forcing them to bridge COA -> vault before wrapping
/// adds an extra tx + a UX wart. This transaction does the COA withdrawal +
/// JanusFlow.wrap in a single atomic Cadence tx — the temporary FlowToken.Vault
/// only exists inside this transaction's scope.
///
/// FLOW:
///   1. Borrow the signer's COA with `auth(EVM.Withdraw)`.
///   2. Withdraw `attoflow` from the COA -> a fresh FlowToken.Vault.
///   3. Hand that vault to `JanusFlow.wrap(...)` — which internally re-deposits
///      it into the same COA before issuing the EVM JanusFlow.wrap call.
///      (Yes, the FLOW round-trips COA -> vault -> COA. That is required by
///      JanusFlow's current API which expects a Vault, NOT a COA-side
///      attoflow balance. The round-trip is gas-cheap because both sides live
///      inside the same Cadence tx — no external bridging.)
///
/// @param amount        FLOW to wrap (UFix64; must be a whole number of wei)
/// @param txCommit      [Cx, Cy] — Pedersen commit of (amount in wei, blinding)
/// @param amountProof   uint256[8] amount-disclose Groth16 proof
/// @param calldataHex   ABI-encoded calldata for JanusFlow.wrap(uint256[2], uint256[8])

import "FlowToken"
import "FungibleToken"
import "EVM"
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    amount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    calldataHex: String
) {
    let payment: @FlowToken.Vault
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer

        // Borrow with EVM.Withdraw so we can pull attoFLOW out of the COA.
        let coa = signer.storage
            .borrow<auth(EVM.Withdraw) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_wrap_from_coa: no COA at /storage/evm — run setup_coa.cdc first")

        // Convert UFix64 FLOW -> attoFLOW (1 FLOW = 1e18 attoFLOW).
        // UFix64 has 8 fractional digits; multiplying by 1e8 gives integer
        // flowUnits, then * 1e10 lifts to attoflow.
        let flowUnits: UInt64 = UInt64(amount * 100_000_000.0)
        let attoflowU: UInt = UInt(flowUnits) * 10_000_000_000

        // Withdraw the required attoflow from the COA into a temp FlowToken.Vault.
        // (EVM.Balance is the COA-side currency unit.)
        let withdrawn <- coa.withdraw(balance: EVM.Balance(attoflow: attoflowU))
        self.payment <- withdrawn
    }

    execute {
        assert(txCommit.length == 2, message: "txCommit must be [Cx, Cy]")
        assert(amountProof.length == 8, message: "amountProof must be Groth16 [8]")

        // Hand to the standard router. Internally it re-deposits this vault
        // into the signer's COA and issues the EVM JanusFlow.wrap call.
        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <- self.payment,
            txCommit: txCommit,
            amountProof: amountProof,
            calldataHex: calldataHex
        )
    }
}
