/// get_tips_by_recipient.cdc — Fetch all tips received by a given address.
///
/// Returns an array of TipMetadata in chronological order (oldest first).
/// Returns an empty array if the address has never received a tip.
///
/// Note: TipMetadata only reveals sender, timestamp, and token type.
/// The tip amount and memo remain hidden in the recipient's ShieldedInbox.
///
/// Usage:
///   flow scripts execute cadence/scripts/get_tips_by_recipient.cdc <recipientAddress> --network testnet

import "PrivateTip"

access(all) fun main(recipient: Address): [PrivateTip.TipMetadata] {
    return PrivateTip.getTipsByRecipient(recipient: recipient)
}
