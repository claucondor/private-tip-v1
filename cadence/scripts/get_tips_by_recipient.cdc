/// Get all tips addressed to recipient (v0.2 + v0.3 mixed).
///
/// v0.3 shielded tips: amount = 0.0, ciphertextRef != nil.
/// v0.2 escrow tips:   amount > 0.0, ciphertextRef = nil.
///
/// For v0.3-only filtering, use `get_shielded_tips_by_recipient.cdc`.
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(recipient: Address): [PrivateTip.TipRecord] {
    return PrivateTip.getTipsByRecipient(recipient: recipient)
}
