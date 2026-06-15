/// get_tip.cdc — Fetch a single tip by ID.
///
/// Returns the full TipMetadata struct for the given tipID,
/// or nil if the ID does not exist or has not been recorded yet.
///
/// Usage:
///   flow scripts execute cadence/scripts/get_tip.cdc <tipID> --network testnet

import "PrivateTip"

access(all) fun main(tipID: UInt64): PrivateTip.TipMetadata? {
    return PrivateTip.getTip(tipID: tipID)
}
