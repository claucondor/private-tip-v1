/// get_tips_by_sender.cdc — Fetch all tips sent by a given address.
///
/// Returns an array of TipMetadata in chronological order (oldest first).
/// Returns an empty array if the address has never sent a tip.
///
/// Usage:
///   flow scripts execute cadence/scripts/get_tips_by_sender.cdc <senderAddress> --network testnet

import "PrivateTip"

access(all) fun main(sender: Address): [PrivateTip.TipMetadata] {
    return PrivateTip.getTipsBySender(sender: sender)
}
