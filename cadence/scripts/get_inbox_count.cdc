/// get_inbox_count.cdc — Fetch the number of pending (unread) notes in a user's ShieldedInbox.
///
/// Returns the count of notes not yet drained by the inbox owner.
/// Returns -1 if the user has not installed a ShieldedInbox (run setup_user first).
///
/// This is the "you have pending tips" indicator for the PrivateTip frontend:
///   count > 0  → user has encrypted tips waiting to be claimed and decrypted
///   count == 0 → all tips have been drained
///   count == -1 → user has not set up their inbox
///
/// Usage:
///   flow scripts execute cadence/scripts/get_inbox_count.cdc <recipientAddress> --network testnet

import "ShieldedInbox"

access(all) fun main(recipient: Address): Int {
    // Borrow the public Receiver capability from the user's /public/shieldedInbox.
    // &{Receiver} exposes count(), peek(), and deposit() — but NOT drain (Owner-only).
    if let inbox = getAccount(recipient)
        .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
    {
        return inbox.count()
    }

    // Inbox not installed — return sentinel -1.
    return -1
}
