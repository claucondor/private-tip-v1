/// get_total_tips.cdc — Fetch the total number of tips recorded across all tokens.
///
/// Returns UInt64 count. Count is cumulative and never decreases
/// (unless an admin reset is performed on testnet).
///
/// Usage:
///   flow scripts execute cadence/scripts/get_total_tips.cdc --network testnet

import "PrivateTip"

access(all) fun main(): UInt64 {
    return PrivateTip.totalTips()
}
