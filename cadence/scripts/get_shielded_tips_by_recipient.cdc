/// Get all v0.3 SHIELDED tip metadata records addressed to recipient.
///
/// Each record contains (sender, recipient, timestamp, ciphertextRef, memo) —
/// NO amount, NO claimed flag. The recipient learns total received only by
/// reading their JanusFlow EVM commitment and reconstructing it from locally-
/// stored blindings (or by tracking incoming TipSentShielded events with
/// their own decryption key).
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(recipient: Address): [PrivateTip.TipMetadata] {
    return PrivateTip.getShieldedTipsByRecipient(recipient: recipient)
}
