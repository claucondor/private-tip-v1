/// Returns the total number of tipIDs ever issued (v0.2 + v0.3 combined).
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(): UInt64 {
    return PrivateTip.getTotalTipCount()
}
