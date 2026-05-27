/// Checks whether the PrivateTip contract is currently paused.
///
/// When paused, the recordTip function rejects new tips. Existing tips and
/// claiming are unaffected.
///
/// This is a read-only script that calls PrivateTip.isPaused().
///
/// @return `true` if the contract is paused, `false` otherwise
///
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(): Bool {
    return PrivateTip.isPaused()
}
