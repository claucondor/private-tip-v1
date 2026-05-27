/// Read another account's published MemoKey pubkey (v0.4.1).
///
/// Returns nil if the account has not published a MemoKey at
/// /public/openjanusMemoKey. Senders use this to determine whether the
/// recipient can receive an encrypted memo.
///
/// @param owner  Cadence address whose memo pubkey to fetch.
/// @return       Optional {"x": UInt256, "y": UInt256}.

import PrivateTip from 0xb9ac529c14a4c5a1

access(all) fun main(owner: Address): {String: UInt256}? {
    return PrivateTip.getMemoPubkey(owner: owner)
}
