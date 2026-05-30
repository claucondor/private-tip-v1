/// setup_memo_key.cdc — v0.5.3: publish BabyJub memo pubkey atomically on
/// Cadence (JanusFlow.MemoKey Resource) AND EVM (JanusFlow.publishMemoKey).
///
/// Privacy model:
///   The privkey is NEVER passed to this transaction. Keypair derivation is
///   entirely client-side via the sign-derive pattern:
///       privkey = HKDF(keccak256(wallet.sign("openjanus-memo-key-v1")))
///   Only (pubkeyX, pubkeyY) travel to chain.
///
/// Architecture (v0.5.3 fix):
///   MemoKey is a GENERIC JanusFlow primitive — the Resource type lives in
///   JanusFlow.cdc (0x5dcbeb41055ec57e), NOT in PrivateTip.cdc.
///   This tx imports from JanusFlow and writes to /storage/openjanusMemoKey
///   (same path as before, but now the resource type is JanusFlow.MemoKey).
///
/// Migration (v0.5.3):
///   Pre-v0.5.2 accounts had PrivateTip.MemoKey stored at the same path.
///   A typed borrow<&JanusFlow.MemoKey> would fail with a type mismatch.
///   This tx now uses load<@AnyResource> to evict any existing resource
///   (regardless of type) before saving the new JanusFlow.MemoKey.
///   This is safe: the sign-derive keypair is deterministic, so re-running
///   produces the same pubkey — no key material is lost.
///
/// What this tx does:
///   1. CADENCE SIDE: evicts any existing resource at /storage/openjanusMemoKey
///      (handles old PrivateTip.MemoKey and stale JanusFlow.MemoKey alike),
///      then saves a fresh JanusFlow.MemoKey with capability at
///      /public/openjanusMemoKey.
///   2. EVM SIDE: calls JanusFlow.publishMemoKey(pubkeyX, pubkeyY) on the EVM
///      proxy via the signer's COA. Always overwrites (last-write wins; key
///      rotation is intentionally supported).
///
/// Idempotency:
///   Re-running with the same (pubkeyX, pubkeyY) is safe — evict + re-save
///   produces the same final state. Running with a different pubkey performs
///   key rotation (old key destroyed, new key installed).
///
/// Parameters:
///   pubkeyX  BabyJub pubkey X coordinate (derived client-side, NOT the privkey)
///   pubkeyY  BabyJub pubkey Y coordinate

import JanusFlow from 0x5dcbeb41055ec57e
import EVM from 0x8c5303eaa26202d6

transaction(pubkeyX: UInt256, pubkeyY: UInt256) {
    prepare(signer: auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability, BorrowValue) &Account) {
        let storagePath = JanusFlow.memoKeyStoragePath()
        let publicPath  = JanusFlow.memoKeyPublicPath()

        // ── 1. CADENCE SIDE ──────────────────────────────────────────────────
        // Evict any existing resource at the path — regardless of type.
        // This handles three cases:
        //   a) Nothing at path (fresh account) → load returns nil, nothing to destroy.
        //   b) PrivateTip.MemoKey at path (pre-v0.5.2) → evict via @AnyResource.
        //   c) JanusFlow.MemoKey at path (already v0.5.2+) → evict and re-install
        //      (key rotation / idempotent re-run). Sign-derive is deterministic so
        //      the same pubkey is written back; no key material is lost.
        if let anyOld <- signer.storage.load<@AnyResource>(from: storagePath) {
            destroy anyOld
            signer.capabilities.unpublish(publicPath)
            log("setup_memo_key: evicted existing resource at ".concat(storagePath.toString()))
        }

        let key <- JanusFlow.createMemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
        signer.storage.save(<-key, to: storagePath)

        let cap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(storagePath)
        signer.capabilities.publish(cap, at: publicPath)

        log("JanusFlow.MemoKey created at ".concat(storagePath.toString()))

        // ── 2. EVM SIDE ──────────────────────────────────────────────────────
        // Call JanusFlow.publishMemoKey(uint256, uint256) on the EVM proxy.
        //
        // ABI encoding (manual — avoids EVM.encodeABIWithSignature issues with
        // scalar types vs fixed arrays):
        //   selector: bytes4(keccak256("publishMemoKey(uint256,uint256)")) = 0x6370796a
        //   data: selector (4 bytes) || pubkeyX (32 bytes BE) || pubkeyY (32 bytes BE)
        //   total: 68 bytes

        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("setup_memo_key: no COA at /storage/evm — call EVM.createCadenceOwnedAccount() first")

        // Function selector for publishMemoKey(uint256,uint256) = 0x6370796a
        var calldata: [UInt8] = [0x63, 0x70, 0x79, 0x6a]

        // ABI-encode pubkeyX as 32-byte big-endian uint256
        var xEncoded: [UInt8] = []
        var xVal: UInt256 = pubkeyX
        var xIdx: Int = 0
        while xIdx < 32 {
            xEncoded.insert(at: 0, UInt8(xVal & 0xFF))
            xVal = xVal >> 8
            xIdx = xIdx + 1
        }
        calldata = calldata.concat(xEncoded)

        // ABI-encode pubkeyY as 32-byte big-endian uint256
        var yEncoded: [UInt8] = []
        var yVal: UInt256 = pubkeyY
        var yIdx: Int = 0
        while yIdx < 32 {
            yEncoded.insert(at: 0, UInt8(yVal & 0xFF))
            yVal = yVal >> 8
            yIdx = yIdx + 1
        }
        calldata = calldata.concat(yEncoded)

        let janusFlowEVM = EVM.addressFromString("0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078")
        let result = coa.call(
            to: janusFlowEVM,
            data: calldata,
            gasLimit: 200_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "setup_memo_key: EVM publishMemoKey failed: ".concat(result.errorMessage)
        )

        log("MemoKey published on Cadence + EVM for ".concat(signer.address.toString()))
    }
}
