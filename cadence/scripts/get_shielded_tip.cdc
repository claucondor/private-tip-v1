/// Get a single shielded (v0.3) tip's TipMetadata by tipID.
///
/// Returns nil if the tipID doesn't exist OR the record is a v0.2 escrow tip.
///
/// TipMetadata explicitly excludes amount + claimed fields — those are not
/// part of the v0.3 privacy contract. The amount lives only in the JanusFlow
/// EVM Pedersen commitment (which leaks ONLY the sender + recipient pair).
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(tipID: UInt64): PrivateTip.TipMetadata? {
    return PrivateTip.getTipMetadata(tipID: tipID)
}
