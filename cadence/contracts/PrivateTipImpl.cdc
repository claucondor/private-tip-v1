// PrivateTipImpl.cdc
//
// Initial implementation of IPrivateTipImpl.
//
// Strategy: in-router custody. The router holds @{UInt64: FlowToken.Vault} keyed by tipID,
// claimTip moves the vault out to the verified recipient (signer-bound via auth ref).
//
// This contract is PURE LOGIC — no resources, no mutable state.
// All state lives in PrivateTip (the router).
//
// Validation responsibilities:
//   - sendTip: amount > 0, memo length within bound, recipient != sender restriction OFF
//              (self-tipping is allowed, useful for personal escrow).
//   - claimTip: tip exists, claimer is the recorded recipient, not already claimed.
//
// Authorization (the vuln 015 fix) is enforced by the router using an
// `auth(BorrowValue) &Account` reference — the impl is only told the resolved claimer
// address. The router proves signer ownership; the impl just validates the values.
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router).

import IPrivateTipImpl from 0xb9ac529c14a4c5a1

access(all) contract PrivateTipImpl: IPrivateTipImpl {

    // ─── Constants ──────────────────────────────────────────────────────────────

    access(self) let MAX_MEMO_LENGTH: UInt64

    // ─── IPrivateTipImpl conformance ─────────────────────────────────────────────

    access(all) view fun maxMemoLength(): UInt64 {
        return self.MAX_MEMO_LENGTH
    }

    access(all) view fun validateSendTip(
        sender: Address,
        recipient: Address,
        amount: UFix64,
        memo: String?
    ): String {
        // Self-tipping is allowed (personal escrow / scheduled payment patterns).
        // Add `if sender == recipient { return "self-tip not allowed" }` if that
        // ever becomes a policy decision.
        if amount <= 0.0 {
            return "amount must be > 0"
        }
        if memo != nil && UInt64(memo!.length) > self.MAX_MEMO_LENGTH {
            return "memo length exceeds maximum (".concat(self.MAX_MEMO_LENGTH.toString()).concat(")")
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

    access(all) view fun version(): String {
        return "0.1.0"
    }

    access(all) view fun strategy(): String {
        return "in-router FlowToken vault custody; signer-bound auth via &Account ref"
    }

    // ─── Initializer ─────────────────────────────────────────────────────────────

    init() {
        self.MAX_MEMO_LENGTH = 280
    }
}
