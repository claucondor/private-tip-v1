/// Get a single tip's full TipRecord by tipID (v0.2 + v0.3 compatible).
///
/// For v0.3 shielded tips, the returned record has amount = 0.0 and a
/// non-nil ciphertextRef. For v0.2 escrow tips, amount > 0.0 and
/// ciphertextRef is nil.
///
/// To get only the v0.3 metadata view (no amount field), use
/// `get_shielded_tip.cdc`.
import PrivateTip from "../contracts/PrivateTip.cdc"

access(all) fun main(tipID: UInt64): PrivateTip.TipRecord? {
    return PrivateTip.getTip(tipID: tipID)
}
