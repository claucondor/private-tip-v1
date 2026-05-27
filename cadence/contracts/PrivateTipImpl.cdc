// PrivateTipImpl.cdc — v0.3 orchestrator implementation.
//
// Strategy: PURE ORCHESTRATOR over JanusFlow. PrivateTip no longer holds any
// FlowToken vaults. The router's recordTip(...) writes a metadata record while
// a single Cadence transaction also calls JanusFlow.shieldedTransfer (which
// orchestrates the EVM JanusFlow proxy's shieldedTransfer via the signer's
// COA). Atomicity is provided by the Cadence transaction (both calls succeed
// or both abort).
//
// Privacy boundary:
//   The TipSentShielded event emitted by the router carries NO amount field.
//   The amount is hidden in the JanusFlow EVM proxy's Pedersen commitment
//   update, which by design exposes ONLY (from, to) — see audits-kb
//   v0.3 privacy validation.
//
// This contract is PURE LOGIC — no resources, no mutable state.
// All state lives in PrivateTip (the router).
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router).

import IPrivateTipImpl from 0xb9ac529c14a4c5a1

access(all) contract PrivateTipImpl: IPrivateTipImpl {

    // ─── Constants ──────────────────────────────────────────────────────────────

    access(self) let MAX_MEMO_LENGTH: UInt64

    /// Required length of `ciphertextRef` passed to recordTip — Pedersen
    /// C_tx = (Cx, Cy), so 2. Inlined per-call instead of a contract field
    /// to keep the v0.2 → v0.3 storage layout unchanged.
    access(all) view fun ciphertextRefLen(): Int {
        return 2
    }

    // ─── IPrivateTipImpl conformance ─────────────────────────────────────────────

    access(all) view fun maxMemoLength(): UInt64 {
        return self.MAX_MEMO_LENGTH
    }

    access(all) view fun validateRecordTip(
        sender: Address,
        recipient: Address,
        ciphertextLen: Int,
        memo: String?
    ): String {
        // Self-tipping is allowed (personal escrow / scheduled payment patterns).
        if ciphertextLen != self.ciphertextRefLen() {
            return "ciphertextRef must be ["
                .concat(self.ciphertextRefLen().toString())
                .concat("] UInt256 (Pedersen Cx, Cy)")
        }
        if memo != nil && UInt64(memo!.length) > self.MAX_MEMO_LENGTH {
            return "memo length exceeds maximum ("
                .concat(self.MAX_MEMO_LENGTH.toString())
                .concat(")")
        }
        return ""
    }

    // ─── Legacy v0.2 validation (kept for backward compat) ───────────────────────

    access(all) view fun validateSendTip(
        sender: Address,
        recipient: Address,
        amount: UFix64,
        memo: String?
    ): String {
        // Legacy v0.2 escrow path. Self-tipping allowed for personal escrow.
        if amount <= 0.0 {
            return "amount must be > 0"
        }
        if memo != nil && UInt64(memo!.length) > self.MAX_MEMO_LENGTH {
            return "memo length exceeds maximum ("
                .concat(self.MAX_MEMO_LENGTH.toString())
                .concat(")")
        }
        return ""
    }

    access(all) view fun validateClaim(
        tipExists: Bool,
        tipRecipient: Address,
        tipClaimed: Bool,
        claimer: Address
    ): String {
        if !tipExists {
            return "tip does not exist"
        }
        if tipClaimed {
            return "tip already claimed"
        }
        if tipRecipient != claimer {
            return "only the intended recipient can claim"
        }
        return ""
    }

    // ─── Identity ────────────────────────────────────────────────────────────────

    access(all) view fun version(): String {
        return "0.3.0"
    }

    access(all) view fun strategy(): String {
        return "pure orchestrator over JanusFlow shielded transfer; no escrow"
    }

    // ─── Initializer ─────────────────────────────────────────────────────────────

    init() {
        self.MAX_MEMO_LENGTH = 280
    }
}
