/// Setup a per-user MemoKey for encrypted-memo PrivateTips (v0.4.1).
///
/// Idempotent: if a MemoKey already exists at /storage/openjanusMemoKey, this
/// transaction does nothing.
///
/// The (privkey, pubkeyX, pubkeyY) triple is generated OFF-CHAIN in the
/// signer's browser via @openjanus/sdk's generateBabyJubKeypair() and passed
/// in as UInt256 arguments. The privkey is stored INSIDE the MemoKey resource
/// in /storage/openjanusMemoKey — only the resource's owner can borrow it.
/// The pubkey is exposed via a published capability at /public/openjanusMemoKey
/// so any sender can encrypt-to it without a Cadence script.
///
/// Security note:
///   The privkey transits this Cadence transaction in cleartext. This is
///   acceptable for v0.4.1 because: (a) the signer is the privkey owner;
///   (b) the privkey is committed to chain only inside the signer's own
///   storage. The transaction history on-chain may leak the privkey to
///   anyone reading historical block data. For mainnet, replace this with
///   an off-chain key-derivation scheme (e.g. HKDF of a signed message)
///   that NEVER puts the privkey in a tx argument.

import PrivateTip from 0xb9ac529c14a4c5a1

transaction(
    privkey: UInt256,
    pubkeyX: UInt256,
    pubkeyY: UInt256
) {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability, BorrowValue) &Account) {
        let storagePath = PrivateTip.memoKeyStoragePath()
        let publicPath = PrivateTip.memoKeyPublicPath()

        // Idempotent: skip if a MemoKey already exists.
        if signer.storage.borrow<&PrivateTip.MemoKey>(from: storagePath) != nil {
            log("MemoKey already exists at ".concat(storagePath.toString()).concat(" — skipping setup"))
            return
        }

        let key <- PrivateTip.createMemoKey(
            privkey: privkey,
            pubkeyX: pubkeyX,
            pubkeyY: pubkeyY
        )
        signer.storage.save(<-key, to: storagePath)

        let cap = signer.capabilities.storage.issue<&{PrivateTip.MemoKeyPublic}>(storagePath)
        signer.capabilities.publish(cap, at: publicPath)

        log("MemoKey published at ".concat(publicPath.toString()))
    }
}
