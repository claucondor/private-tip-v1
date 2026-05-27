// IPrivateTipImpl.cdc — v0.3 orchestrator interface.
//
// Design principles:
//   - Impl contracts are STATELESS — pure logic only, no resources, no mutable state.
//   - Router (PrivateTip) is a pure ORCHESTRATOR over JanusFlow. NO escrow,
//     NO per-tip FlowToken vaults. Funds live in the JanusFlow shielded slot
//     of the recipient; PrivateTip only records the (sender, recipient, memo,
//     ciphertext_ref, timestamp) tuple so apps can index "who sent me what
//     metadata" without ever learning the amount.
//   - Impl swap requires 48h time-lock so apps can react to upgrades.
//
// Interface methods cannot return resources (Cadence 1.0 restriction), so all
// results are returned as primitive types or simple structs. Error reporting
// uses the "" = success, non-empty = error message convention.
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router).
//
// v0.3 vs v0.2 differences:
//   - validateSendTip(...amount, memo) → validateRecordTip(...memo) — NO amount.
//   - validateClaim(...) REMOVED — no per-tip claim in v0.3 (recipient unwraps
//     directly from their JanusFlow shielded slot via JanusFlow.unwrap).
//   - Legacy v0.2 validate functions are still required by the interface so the
//     router's old sendTip/claimTip code paths (kept for already-issued tips
//     on testnet) remain compilable. They become no-ops in practice once the
//     router stops calling them on the new orchestrator path.

access(all) contract interface IPrivateTipImpl {

    // ─── Constants ───────────────────────────────────────────────────────────────

    /// Maximum length of the optional memo string attached to a tip.
    access(all) view fun maxMemoLength(): UInt64

    // ─── v0.3 orchestrator validation ────────────────────────────────────────────

    /// Validate inputs for a recordTip (orchestrator) operation.
    ///
    /// Structural checks only — does NOT check pause state, COA ownership, or
    /// the EVM-side proof verification (the JanusFlow contract handles that).
    ///
    /// @param sender         Cadence address of the sender (for self-tip policy)
    /// @param recipient      Cadence address of the recipient
    /// @param ciphertextLen  Length of the ciphertextRef array (must be 2 — Pedersen C = (Cx, Cy))
    /// @param memo           Optional memo (length-bounded by maxMemoLength)
    ///
    /// Returns "" on success, non-empty error message on failure.
    access(all) view fun validateRecordTip(
        sender: Address,
        recipient: Address,
        ciphertextLen: Int,
        memo: String?
    ): String

    // ─── Legacy v0.2 validation (kept for backward compat) ───────────────────────

    /// Validate inputs for a legacy sendTip operation (v0.2 escrow path).
    /// Kept so the router can still compile its (frozen) escrow code paths
    /// in case operators want to drain leftover v0.2 vaults.
    access(all) view fun validateSendTip(
        sender: Address,
        recipient: Address,
        amount: UFix64,
        memo: String?
    ): String

    /// Validate inputs for a legacy claimTip operation (v0.2 escrow path).
    /// Kept so already-issued v0.2 tips remain claimable.
    access(all) view fun validateClaim(
        tipExists: Bool,
        tipRecipient: Address,
        tipClaimed: Bool,
        claimer: Address
    ): String

    // ─── Identity ────────────────────────────────────────────────────────────────

    /// Semantic version of this implementation (e.g. "0.3.0").
    access(all) view fun version(): String

    /// Human-readable description of the impl strategy.
    access(all) view fun strategy(): String
}
