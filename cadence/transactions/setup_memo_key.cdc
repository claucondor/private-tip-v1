/// setup_memo_key.cdc — v0.5.2: publish BabyJub memo pubkey atomically on
/// Cadence (JanusFlow.MemoKey Resource) AND EVM (JanusFlow.publishMemoKey).
///
/// Privacy model:
///   The privkey is NEVER passed to this transaction. Keypair derivation is
///   entirely client-side via the sign-derive pattern:
///       privkey = HKDF(keccak256(wallet.sign("openjanus-memo-key-v1")))
///   Only (pubkeyX, pubkeyY) travel to chain.
///
/// Architecture (v0.5.2 fix):
///   MemoKey is a GENERIC JanusFlow primitive — the Resource type lives in
///   JanusFlow.cdc (0x5dcbeb41055ec57e), NOT in PrivateTip.cdc.
///   This tx imports from JanusFlow and writes to /storage/openjanusMemoKey
///   (same path as before, but now the resource type is JanusFlow.MemoKey).
///
/// What this tx does:
///   1. CADENCE SIDE: creates a JanusFlow.MemoKey (pubkey only) resource and
///      saves it at /storage/openjanusMemoKey with a public capability at
///      /public/openjanusMemoKey. Idempotent — skips if already present.
///   2. EVM SIDE: calls JanusFlow.publishMemoKey(pubkeyX, pubkeyY) on the EVM
///      proxy via the signer's COA. Idempotent — always overwrites (key
///      rotation is intentionally supported; last-write wins on EVM).
///
/// Parameters:
///   pubkeyX  BabyJub pubkey X coordinate (derived client-side, NOT the privkey)
///   pubkeyY  BabyJub pubkey Y coordinate

import JanusFlow from 0x5dcbeb41055ec57e
import EVM from 0x8c5303eaa26202d6

transaction(pubkeyX: UInt256, pubkeyY: UInt256) {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability, BorrowValue) &Account) {
        let storagePath = JanusFlow.memoKeyStoragePath()
        let publicPath  = JanusFlow.memoKeyPublicPath()

        // ── 1. CADENCE SIDE ──────────────────────────────────────────────────
        // Idempotent: skip if a JanusFlow.MemoKey already exists at the path.
        if signer.storage.borrow<&JanusFlow.MemoKey>(from: storagePath) == nil {
            let key <- JanusFlow.createMemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
            signer.storage.save(<-key, to: storagePath)

            let cap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(storagePath)
            signer.capabilities.publish(cap, at: publicPath)

            log("JanusFlow.MemoKey created at ".concat(storagePath.toString()))
        } else {
            log("JanusFlow.MemoKey already exists — skipping Cadence save")
        }

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
