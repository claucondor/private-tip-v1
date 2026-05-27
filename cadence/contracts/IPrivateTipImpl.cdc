// IPrivateTipImpl.cdc
//
// Interface contract that all PrivateTip implementation contracts must conform to.
//
// Design principles:
//   - Impl contracts are STATELESS — pure logic only, no resources, no mutable state.
//   - Router (PrivateTip) holds all custody (tip records, recipient indices, paused flag).
//   - Impl is responsible only for input validation and any derived computation.
//   - Impl swap requires 48h time-lock so apps can react to upgrades.
//
// Interface methods cannot return resources (Cadence 1.0 restriction), so all results
// are returned as primitive types or simple structs. Error reporting uses the
// "" = success, non-empty = error message convention.
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router — v0.2.1 sprint Phase 3).
// Replaces deprecated monolithic PrivateTip at 0xd807a3992d7be612 (bob's deployer
// account), which had vuln 015: self.account.address used in claimTip authorization
// instead of the transaction signer.

access(all) contract interface IPrivateTipImpl {

    // ─── Constants ───────────────────────────────────────────────────────────────

    /// Maximum length of the optional memo string attached to a tip.
    access(all) view fun maxMemoLength(): UInt64

    // ─── Interface Methods ───────────────────────────────────────────────────────

    /// Validate inputs for a sendTip operation.
    ///
    /// Structural checks only — does NOT check pause state, balance, or
    /// authorization. Those belong to the router (which owns the state).
    ///
    /// Returns "" on success, non-empty error message on failure.
    access(all) view fun validateSendTip(
        sender: Address,
        recipient: Address,
        amount: UFix64,
        memo: String?
    ): String

    /// Validate inputs for a claimTip operation.
    ///
    /// Checks: tip exists, claimer is the recipient, tip not already claimed.
    /// Does NOT check pause state — that belongs to the router.
    ///
    /// Returns "" on success, non-empty error message on failure.
    access(all) view fun validateClaim(
        tipExists: Bool,
        tipRecipient: Address,
        tipClaimed: Bool,
        claimer: Address
    ): String

    /// Semantic version of this implementation (e.g. "0.1.0").
    access(all) view fun version(): String

    /// Human-readable description of the impl strategy.
    access(all) view fun strategy(): String
}
