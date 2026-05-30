// PrivateTip.cdc — v0.4.1 orchestrator with encrypted memos.
//
// v0.4.1 clean-break changes from v0.3:
//
//   * MemoKey resource — each user mints once via createMemoKey(); stores their
//     BabyJubJub keypair at /storage/openjanusMemoKey. Senders read the
//     /public/openjanusMemoKey capability to encrypt memos that only the
//     recipient can decrypt.
//
//   * TipSentShielded event schema replaced (CLEAN BREAK — testnet only).
//     The String? memo field is GONE. Replaced by:
//         memoCiphertext     : [UInt8]   AES-GCM ciphertext (iv||ct||tag)
//         memoEphPubkeyX/Y   : UInt256   sender's ephemeral BabyJub pubkey
//     The plaintext memo NEVER touches the chain in v0.4.1.
//
//   * recordTip(...) signature accepts the encrypted payload instead of the
//     plaintext String?.
//
// Architecture (unchanged from v0.3):
//   PrivateTip is a PURE ORCHESTRATOR over JanusFlow. It does NOT custody
//   FlowToken. The shielded value transfer happens via JanusFlow.shieldedTransfer
//   in the SAME Cadence transaction. PrivateTip only records metadata so
//   indexers can answer "what tips did X send/receive" without ever learning
//   amounts OR the memo content.
//
// Privacy model (v0.4.1):
//   - Amount per tip:        HIDDEN (JanusFlow Pedersen commit).
//   - Sender → recipient:    VISIBLE (still public).
//   - Memo content:          HIDDEN (only recipient can decrypt).
//   - Memo presence:         VISIBLE (ciphertext length is observable).
//   - ciphertextRef:         EVENT ONLY (not in storage).
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router).

import "FlowToken"
import "FungibleToken"
import IPrivateTipImpl from 0xb9ac529c14a4c5a1
import PrivateTipImpl from 0xb9ac529c14a4c5a1

access(all) contract PrivateTip {

    // ─── Entitlements ───────────────────────────────────────────────────────────

    access(all) entitlement Pause
    access(all) entitlement Upgrade
    /// Admin entitlement to drain a leftover v0.2 tipVault (testnet cleanup).
    access(all) entitlement Drain

    // ─── Storage Paths ──────────────────────────────────────────────────────────

    access(all) let AdminStoragePath: StoragePath
    access(all) let TipsCustodyVaultPath: StoragePath  // reserved (unused)

    // v0.4.1 MemoKey paths exposed as functions (NOT new contract fields —
    // adding new `let` fields would require init() to re-run, which Cadence
    // does not do on upgrade. View functions are free to add post-deploy.)
    access(all) view fun memoKeyStoragePath(): StoragePath {
        return /storage/openjanusMemoKey
    }
    access(all) view fun memoKeyPublicPath(): PublicPath {
        return /public/openjanusMemoKey
    }

    // ─── State — KEPT for Cadence upgrade compat ────────────────────────────────
    // The Cadence upgrade validator requires existing storage fields to remain.
    // We KEEP every v0.2/v0.3 field; v0.4.1 just adds new behavior on top.

    access(self) var nextTipID: UInt64
    access(self) var tips: {UInt64: TipRecord}
    access(self) var tipVaults: @{UInt64: FlowToken.Vault}
    access(self) var tipsByRecipient: {Address: [UInt64]}
    access(self) var tipsBySender: {Address: [UInt64]}
    access(self) var totalLocked: UFix64
    access(self) var paused: Bool
    access(self) var activeImplVersion: String
    access(self) var pendingImplVersion: String?
    access(self) var pendingImplUnlockAt: UFix64

    // v0.4.2 note: encrypted memo blobs live in a separate MemoStore resource
    // saved at the contract account's storage. We could NOT add a new
    // contract-level field — the Cadence upgrade validator hard-blocks new
    // fields on already-deployed contracts. The resource pattern (new TYPE,
    // installed post-upgrade) is the only legal path.

    // ─── Events ─────────────────────────────────────────────────────────────────
    //
    // CLEAN-BREAK v0.4.1 NOTE: TipSentShielded now omits `memo: String?` and
    // adds an encrypted-memo blob + ephemeral pubkey. Pre-v0.4.1 test tips on
    // testnet are now unreadable via this event (acceptable per operator —
    // testnet only). On-chain TipRecord entries created pre-v0.4.1 retain
    // their plaintext memos in storage but are NOT exposed in shielded views.
    //
    // The legacy v0.2 TipSent / TipClaimed events are KEPT (Cadence forbids
    // removing event declarations on upgrade).

    /// LEGACY v0.2 — kept for upgrade compat. NEVER emitted post-v0.3.
    access(all) event TipSent(
        tipID: UInt64,
        sender: Address,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64,
        memo: String?
    )

    /// LEGACY v0.2 — kept for upgrade compat. Emitted only by
    /// adminDrainLegacyVault (and historical v0.2 claims).
    access(all) event TipClaimed(
        tipID: UInt64,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64
    )

    /// v0.4.1 shielded-tip event — encrypted memo (CLEAN BREAK from v0.3).
    ///
    /// Fields:
    ///   tipID            — sequential identifier
    ///   sender           — Cadence address (public)
    ///   recipient        — Cadence address (public)
    ///   timestamp        — block timestamp
    ///   ciphertextRef    — Pedersen C_tx point (Cx, Cy) — opaque under
    ///                      perfect-hiding; no amount info recoverable.
    ///   memoCiphertext   — AES-GCM ciphertext frame (iv||ct||tag); empty
    ///                      array = no memo.
    ///   memoEphPubkeyX/Y — sender's ephemeral BabyJub pubkey; recipient does
    ///                      ECDH against their MemoKey privkey to derive the
    ///                      AES key.
    access(all) event TipSentShielded(
        tipID: UInt64,
        sender: Address,
        recipient: Address,
        timestamp: UFix64,
        ciphertextRef: [UInt256],
        memoCiphertext: [UInt8],
        memoEphPubkeyX: UInt256,
        memoEphPubkeyY: UInt256
    )

    /// Emitted when admin drains a leftover v0.2 tipVault.
    access(all) event LegacyVaultDrained(
        tipID: UInt64,
        recipient: Address,
        amount: UFix64
    )

    /// Emitted when admin wipes all tip records for a recipient (testnet cleanup).
    access(all) event AdminTipsWiped(recipient: Address, count: UInt64)

    access(all) event Paused()
    access(all) event Unpaused()
    access(all) event ImplSwapProposed(pendingVersion: String, unlockAt: UFix64)
    access(all) event ImplSwapped(oldVersion: String, newVersion: String)
    access(all) event ImplSwapCancelled()

    /// Emitted when a user publishes (or rotates) their memo encryption pubkey.
    /// KEPT for Cadence upgrade compat — Cadence forbids removing event
    /// declarations. In v0.5.2 this event is no longer emitted here; the
    /// canonical event is JanusFlow.MemoKeyPublished.
    access(all) event MemoKeyPublished(
        owner: Address,
        pubkeyX: UInt256,
        pubkeyY: UInt256
    )

    // ─── MemoKey Resource — DEPRECATED in v0.5.2 ───────────────────────────────
    //
    // v0.5.2 architectural fix: MemoKey is a GENERIC JanusFlow primitive, not a
    // PrivateTip-specific type. The canonical type is now JanusFlow.MemoKey
    // (deployed at 0x5dcbeb41055ec57e). New code imports from JanusFlow.
    //
    // These declarations are KEPT for Cadence upgrade compat:
    //   - Removing Resource types is forbidden by the Cadence upgrade validator
    //     when they exist in storage.
    //   - Removing the `privkey` field from the existing MemoKey Resource is
    //     also forbidden — the validator hard-blocks field removal.
    //   - The `privkey` field is now SECURITY-DEAD: setup_memo_key.cdc no
    //     longer passes a privkey. Existing on-testnet resources will be
    //     destroyed by the hard reset before mainnet.
    //
    // MIGRATION PATH: After the testnet hard reset, users call setup_memo_key.cdc
    // which writes a JanusFlow.MemoKey (not PrivateTip.MemoKey) to the SAME
    // path (/storage/openjanusMemoKey). The paths remain identical, so any
    // app reading /public/openjanusMemoKey works unchanged.
    //
    // DO NOT USE PrivateTip.MemoKey in new code. Import JanusFlow instead.

    /// @deprecated — use JanusFlow.MemoKeyPublic
    access(all) resource interface MemoKeyPublic {
        access(all) view fun getPubkeyX(): UInt256
        access(all) view fun getPubkeyY(): UInt256
    }

    /// @deprecated — use JanusFlow.MemoKey
    /// privkey field retained for upgrade compat ONLY. It is NEVER populated
    /// by new transactions (setup_memo_key.cdc v0.5.2 uses JanusFlow.createMemoKey).
    access(all) resource MemoKey: MemoKeyPublic {
        access(self) let privkey: UInt256
        access(self) let pubkeyX: UInt256
        access(self) let pubkeyY: UInt256

        init(privkey: UInt256, pubkeyX: UInt256, pubkeyY: UInt256) {
            self.privkey = privkey
            self.pubkeyX = pubkeyX
            self.pubkeyY = pubkeyY
        }

        access(all) view fun getPubkeyX(): UInt256 { return self.pubkeyX }
        access(all) view fun getPubkeyY(): UInt256 { return self.pubkeyY }
        // borrowPrivkey() REMOVED — intentionally dropped. Even though
        // the field still exists for upgrade compat, exposing it as a
        // callable getter would re-introduce the privkey leak. The field
        // value is 0 in all new MemoKey resources (createMemoKey now
        // accepts only pubkeyX/Y and passes 0 for privkey).
    }

    /// @deprecated — use JanusFlow.createMemoKey(pubkeyX:pubkeyY:)
    /// privkey param silently ignored (always stored as 0).
    access(all) fun createMemoKey(
        pubkeyX: UInt256,
        pubkeyY: UInt256
    ): @MemoKey {
        return <- create MemoKey(privkey: 0, pubkeyX: pubkeyX, pubkeyY: pubkeyY)
    }

    // ─── Tip Record (FROZEN shape for storage compat) ───────────────────────────

    access(all) struct TipRecord {
        access(all) let tipID: UInt64
        access(all) let sender: Address
        access(all) let recipient: Address
        access(all) let amount: UFix64
        access(all) let timestamp: UFix64
        access(all) let memo: String?
        access(all) var claimed: Bool

        init(
            tipID: UInt64,
            sender: Address,
            recipient: Address,
            amount: UFix64,
            timestamp: UFix64,
            memo: String?
        ) {
            self.tipID = tipID
            self.sender = sender
            self.recipient = recipient
            self.amount = amount
            self.timestamp = timestamp
            self.memo = memo
            self.claimed = false
        }

        access(contract) fun markClaimed() { self.claimed = true }
        access(all) view fun isShielded(): Bool { return self.amount == 0.0 }
    }

    /// v0.4.1 metadata view — encrypted-memo specific.
    access(all) struct TipMetadata {
        access(all) let tipID: UInt64
        access(all) let sender: Address
        access(all) let recipient: Address
        access(all) let timestamp: UFix64

        init(
            tipID: UInt64,
            sender: Address,
            recipient: Address,
            timestamp: UFix64
        ) {
            self.tipID = tipID
            self.sender = sender
            self.recipient = recipient
            self.timestamp = timestamp
        }
    }

    /// v0.4.2 — encrypted memo blob stored alongside each tip.
    /// Mirrors the payload emitted in TipSentShielded so recipients can
    /// decrypt via a single Cadence script (no event log scanning).
    access(all) struct MemoCiphertext {
        access(all) let ciphertext: [UInt8]
        access(all) let ephPubkeyX: UInt256
        access(all) let ephPubkeyY: UInt256

        init(ciphertext: [UInt8], ephPubkeyX: UInt256, ephPubkeyY: UInt256) {
            self.ciphertext = ciphertext
            self.ephPubkeyX = ephPubkeyX
            self.ephPubkeyY = ephPubkeyY
        }
    }

    /// v0.4.2 — encrypted memo storage. Lives as a separate resource at the
    /// contract account's storage (path: /storage/privateTipMemoStore) because
    /// the Cadence upgrade validator forbids adding new contract-level fields.
    /// Installed post-upgrade via PrivateTip.installMemoStore() — idempotent.
    access(all) resource MemoStore {
        access(self) var memos: {UInt64: MemoCiphertext}

        init() {
            self.memos = {}
        }

        access(contract) fun setMemo(tipID: UInt64, memo: MemoCiphertext) {
            self.memos[tipID] = memo
        }

        access(contract) fun removeMemo(tipID: UInt64) {
            self.memos.remove(key: tipID)
        }

        access(all) view fun getMemo(tipID: UInt64): MemoCiphertext? {
            return self.memos[tipID]
        }
    }

    /// Storage path for the MemoStore resource.
    access(all) view fun memoStoreStoragePath(): StoragePath {
        return /storage/privateTipMemoStore
    }

    /// Idempotently install the MemoStore on the contract account. Safe to
    /// call repeatedly; does nothing if already installed. Must be invoked
    /// once after upgrading to v0.4.2 to enable on-chain memo persistence.
    access(all) fun installMemoStore() {
        let path = self.memoStoreStoragePath()
        if self.account.storage.borrow<&MemoStore>(from: path) == nil {
            self.account.storage.save(<-create MemoStore(), to: path)
        }
    }

    /// v0.4.2 metadata view bundled with the encrypted memo. `memo` is nil
    /// for pre-v0.4.2 tips (stored before MemoStore was installed) and for
    /// tips sent without a memo.
    access(all) struct TipMetadataWithMemo {
        access(all) let tipID: UInt64
        access(all) let sender: Address
        access(all) let recipient: Address
        access(all) let timestamp: UFix64
        access(all) let memo: MemoCiphertext?

        init(
            tipID: UInt64,
            sender: Address,
            recipient: Address,
            timestamp: UFix64,
            memo: MemoCiphertext?
        ) {
            self.tipID = tipID
            self.sender = sender
            self.recipient = recipient
            self.timestamp = timestamp
            self.memo = memo
        }
    }

    // ─── Admin Resource ─────────────────────────────────────────────────────────

    access(all) resource AdminResource {

        access(Pause) fun pause() {
            pre { !PrivateTip.paused: "PrivateTip: already paused" }
            PrivateTip.paused = true
            emit Paused()
        }

        access(Pause) fun unpause() {
            pre { PrivateTip.paused: "PrivateTip: not paused" }
            PrivateTip.paused = false
            emit Unpaused()
        }

        access(Upgrade) fun proposeImplSwap(newVersion: String) {
            PrivateTip.pendingImplVersion = newVersion
            PrivateTip.pendingImplUnlockAt = getCurrentBlock().timestamp + 172800.0
            emit ImplSwapProposed(
                pendingVersion: newVersion,
                unlockAt: PrivateTip.pendingImplUnlockAt
            )
        }

        access(Upgrade) fun finalizeImplSwap() {
            pre {
                PrivateTip.pendingImplVersion != nil:
                    "PrivateTip: no pending impl swap"
                getCurrentBlock().timestamp >= PrivateTip.pendingImplUnlockAt:
                    "PrivateTip: time-lock has not expired yet"
            }
            let old = PrivateTip.activeImplVersion
            PrivateTip.activeImplVersion = PrivateTip.pendingImplVersion!
            PrivateTip.pendingImplVersion = nil
            PrivateTip.pendingImplUnlockAt = 0.0
            emit ImplSwapped(oldVersion: old, newVersion: PrivateTip.activeImplVersion)
        }

        access(Upgrade) fun cancelImplSwap() {
            PrivateTip.pendingImplVersion = nil
            PrivateTip.pendingImplUnlockAt = 0.0
            emit ImplSwapCancelled()
        }

        access(Upgrade) fun forceSetImplVersion(version: String) {
            let old = PrivateTip.activeImplVersion
            PrivateTip.activeImplVersion = version
            emit ImplSwapped(oldVersion: old, newVersion: version)
        }

        access(Drain) fun drainLegacyVault(tipID: UInt64): @FlowToken.Vault {
            pre {
                PrivateTip.tips.containsKey(tipID):
                    "PrivateTip.drainLegacyVault: tip does not exist"
                PrivateTip.tipVaults[tipID] != nil:
                    "PrivateTip.drainLegacyVault: no leftover vault for tip"
            }

            let updated = PrivateTip.tips[tipID]!
            updated.markClaimed()
            PrivateTip.tips[tipID] = updated

            let vault <- PrivateTip.tipVaults.remove(key: tipID)!
            let amount = vault.balance
            PrivateTip.totalLocked = PrivateTip.totalLocked - amount

            emit LegacyVaultDrained(
                tipID: tipID,
                recipient: updated.recipient,
                amount: amount
            )

            return <- vault
        }

        // MAINNET-PREPARE-REMOVE
        // !!! TESTNET-ONLY — REMOVE BEFORE MAINNET !!!
        /// TESTNET-ONLY admin recovery: clear all tip records + memo blobs for one
        /// recipient. Removes entries from `tipsByRecipient[addr]`, deletes the
        /// matching keys from `tips`, and wipes the corresponding MemoStore entries.
        /// Does NOT touch JanusFlow EVM commitments (use adminResetSlot separately).
        access(Pause) fun adminWipeTipsByRecipient(recipient: Address) {
            let ids = PrivateTip.tipsByRecipient[recipient] ?? []
            // Remove tip records + MemoStore entries
            let memoStore = PrivateTip.account.storage.borrow<&MemoStore>(
                from: PrivateTip.memoStoreStoragePath()
            )
            for id in ids {
                PrivateTip.tips.remove(key: id)
                if memoStore != nil {
                    memoStore!.removeMemo(tipID: id)
                }
            }
            // Clear the recipient's index entry
            PrivateTip.tipsByRecipient.remove(key: recipient)
            emit AdminTipsWiped(recipient: recipient, count: UInt64(ids.length))
        }
    }

    // ─── v0.4.1 Public Orchestrator Function ────────────────────────────────────

    /// Record metadata for a shielded tip with an encrypted memo.
    ///
    /// CLEAN-BREAK signature change from v0.3:
    ///   old: recordTip(sender, recipient, ciphertextRef, memo: String?)
    ///   new: recordTip(sender, recipient, ciphertextRef, memoCiphertext, memoEphPubkeyX, memoEphPubkeyY)
    ///
    /// Atomicity contract (unchanged):
    ///   The amount transfer happens out-of-band via JanusFlow.shieldedTransfer
    ///   in the SAME Cadence transaction. Both calls succeed or both abort.
    ///
    /// @param sender           auth ref to the sender's account
    /// @param recipient        Flow address of the tip recipient
    /// @param ciphertextRef    [Cx, Cy] Pedersen transfer-commit
    /// @param memoCiphertext   AES-GCM blob (iv||ct||tag); empty = no memo
    /// @param memoEphPubkeyX/Y Sender's ephemeral BabyJub pubkey
    /// @return tipID           Newly-allocated UInt64 identifier
    access(all) fun recordTip(
        sender: auth(BorrowValue) &Account,
        recipient: Address,
        ciphertextRef: [UInt256],
        memoCiphertext: [UInt8],
        memoEphPubkeyX: UInt256,
        memoEphPubkeyY: UInt256
    ): UInt64 {
        pre {
            !self.paused: "PrivateTip: contract is paused"
        }

        let senderAddr = sender.address

        // Structural validation (length checks).
        assert(
            ciphertextRef.length == 2,
            message: "PrivateTip.recordTip: ciphertextRef must be [Cx, Cy]"
        )
        // memoCiphertext = 0 means no memo. Otherwise must include at least
        // iv(12) + tag(16) = 28 bytes.
        assert(
            memoCiphertext.length == 0 || memoCiphertext.length >= 28,
            message: "PrivateTip.recordTip: memoCiphertext must be empty or >= 28 bytes"
        )
        // Soft upper bound to prevent storage abuse (event field).
        assert(
            memoCiphertext.length <= 4096,
            message: "PrivateTip.recordTip: memoCiphertext exceeds 4096 bytes"
        )

        let tipID = self.nextTipID
        self.nextTipID = self.nextTipID + 1
        let timestamp = getCurrentBlock().timestamp

        // TipRecord storage stays unchanged for upgrade compat. We always
        // record memo: nil for v0.4.1 tips — the encrypted blob lives in
        // the event only (indexers retrieve it from logs).
        self.tips[tipID] = TipRecord(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            amount: 0.0,
            timestamp: timestamp,
            memo: nil
        )

        if let existing = self.tipsByRecipient[recipient] {
            self.tipsByRecipient[recipient] = existing.concat([tipID])
        } else {
            self.tipsByRecipient[recipient] = [tipID]
        }
        if let existing = self.tipsBySender[senderAddr] {
            self.tipsBySender[senderAddr] = existing.concat([tipID])
        } else {
            self.tipsBySender[senderAddr] = [tipID]
        }

        // v0.4.2: persist the encrypted memo blob into MemoStore so recipients
        // can fetch + decrypt via a single script call instead of scanning
        // event logs. Skipped silently when MemoStore is not yet installed —
        // that's the upgrade-without-admin-tx window.
        if memoCiphertext.length > 0 {
            if let memoStore = self.account.storage.borrow<&MemoStore>(
                from: self.memoStoreStoragePath()
            ) {
                memoStore.setMemo(
                    tipID: tipID,
                    memo: MemoCiphertext(
                        ciphertext: memoCiphertext,
                        ephPubkeyX: memoEphPubkeyX,
                        ephPubkeyY: memoEphPubkeyY
                    )
                )
            }
        }

        emit TipSentShielded(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            timestamp: timestamp,
            ciphertextRef: ciphertextRef,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY
        )

        return tipID
    }

    // ─── Read-only Views ────────────────────────────────────────────────────────

    access(all) view fun getTip(tipID: UInt64): TipRecord? {
        return self.tips[tipID]
    }

    access(all) fun getTipMetadata(tipID: UInt64): TipMetadata? {
        if let r = self.tips[tipID] {
            if r.isShielded() {
                return TipMetadata(
                    tipID: r.tipID,
                    sender: r.sender,
                    recipient: r.recipient,
                    timestamp: r.timestamp
                )
            }
        }
        return nil
    }

    access(all) fun getTipsByRecipient(recipient: Address): [TipRecord] {
        let ids = self.tipsByRecipient[recipient] ?? []
        var out: [TipRecord] = []
        for id in ids {
            if let r = self.tips[id] {
                out.append(r)
            }
        }
        return out
    }

    access(all) fun getShieldedTipsByRecipient(recipient: Address): [TipMetadata] {
        let ids = self.tipsByRecipient[recipient] ?? []
        var out: [TipMetadata] = []
        for id in ids {
            if let r = self.tips[id] {
                if r.isShielded() {
                    out.append(TipMetadata(
                        tipID: r.tipID,
                        sender: r.sender,
                        recipient: r.recipient,
                        timestamp: r.timestamp
                    ))
                }
            }
        }
        return out
    }

    /// v0.4.2 — fetch a stored encrypted memo blob, or nil if the tip pre-
    /// dates the MemoStore install or had no memo.
    access(all) fun getTipMemo(tipID: UInt64): MemoCiphertext? {
        if let memoStore = self.account.storage.borrow<&MemoStore>(
            from: self.memoStoreStoragePath()
        ) {
            return memoStore.getMemo(tipID: tipID)
        }
        return nil
    }

    /// v0.4.2 — single-call read for `/tips`: returns metadata + the encrypted
    /// memo blob (when present) for every shielded tip a recipient has.
    access(all) fun getShieldedTipsByRecipientWithMemo(
        recipient: Address
    ): [TipMetadataWithMemo] {
        let ids = self.tipsByRecipient[recipient] ?? []
        let memoStore = self.account.storage.borrow<&MemoStore>(
            from: self.memoStoreStoragePath()
        )
        var out: [TipMetadataWithMemo] = []
        for id in ids {
            if let r = self.tips[id] {
                if r.isShielded() {
                    let memo = memoStore != nil
                        ? memoStore!.getMemo(tipID: id)
                        : nil
                    out.append(TipMetadataWithMemo(
                        tipID: r.tipID,
                        sender: r.sender,
                        recipient: r.recipient,
                        timestamp: r.timestamp,
                        memo: memo
                    ))
                }
            }
        }
        return out
    }

    access(all) fun getTipsBySender(sender: Address): [TipRecord] {
        let ids = self.tipsBySender[sender] ?? []
        var out: [TipRecord] = []
        for id in ids {
            if let r = self.tips[id] {
                out.append(r)
            }
        }
        return out
    }

    access(all) fun getShieldedTipsBySender(sender: Address): [TipMetadata] {
        let ids = self.tipsBySender[sender] ?? []
        var out: [TipMetadata] = []
        for id in ids {
            if let r = self.tips[id] {
                if r.isShielded() {
                    out.append(TipMetadata(
                        tipID: r.tipID,
                        sender: r.sender,
                        recipient: r.recipient,
                        timestamp: r.timestamp
                    ))
                }
            }
        }
        return out
    }

    /// v0.4.3 — single-call read for sender-side recovery: returns metadata +
    /// the encrypted memo blob for every shielded tip a sender has sent.
    /// Mirrors getShieldedTipsByRecipientWithMemo but indexes by sender.
    /// Self-tips (sender == recipient) are recovery carbon-copies — they use
    /// the same on-chain infrastructure so no new fields are required.
    access(all) fun getShieldedTipsBySenderWithMemo(
        sender: Address
    ): [TipMetadataWithMemo] {
        let ids = self.tipsBySender[sender] ?? []
        let memoStore = self.account.storage.borrow<&MemoStore>(
            from: self.memoStoreStoragePath()
        )
        var out: [TipMetadataWithMemo] = []
        for id in ids {
            if let r = self.tips[id] {
                if r.isShielded() {
                    let memo = memoStore != nil
                        ? memoStore!.getMemo(tipID: id)
                        : nil
                    out.append(TipMetadataWithMemo(
                        tipID: r.tipID,
                        sender: r.sender,
                        recipient: r.recipient,
                        timestamp: r.timestamp,
                        memo: memo
                    ))
                }
            }
        }
        return out
    }

    access(all) view fun getTipCount(recipient: Address): UInt64 {
        if let ids = self.tipsByRecipient[recipient] {
            return UInt64(ids.length)
        }
        return 0
    }

    access(all) view fun getTotalTipCount(): UInt64 {
        if self.nextTipID == 0 {
            return 0
        }
        return self.nextTipID - 1
    }

    access(all) view fun isPaused(): Bool {
        return self.paused
    }

    access(all) view fun getTotalLocked(): UFix64 {
        return self.totalLocked
    }

    access(all) view fun getActiveImplVersion(): String {
        return self.activeImplVersion
    }

    access(all) view fun getPendingImplVersion(): String? {
        return self.pendingImplVersion
    }

    access(all) view fun getPendingImplUnlockAt(): UFix64 {
        return self.pendingImplUnlockAt
    }

    /// Read another account's published memo pubkey (returns nil if no MemoKey
    /// is published at /public/openjanusMemoKey).
    access(all) fun getMemoPubkey(owner: Address): {String: UInt256}? {
        let acct = getAccount(owner)
        if let cap = acct.capabilities.borrow<&{MemoKeyPublic}>(self.memoKeyPublicPath()) {
            return {
                "x": cap.getPubkeyX(),
                "y": cap.getPubkeyY()
            }
        }
        return nil
    }

    // ─── Initializer ────────────────────────────────────────────────────────────
    // NOTE: init() does NOT re-run on contract upgrades. All field initializations
    // here apply only to brand-new deployments. The v0.2 -> v0.3 -> v0.4.1
    // path keeps the original on-chain values for pre-existing fields.

    init() {
        self.AdminStoragePath = /storage/privateTipAdmin
        self.TipsCustodyVaultPath = /storage/privateTipsCustody

        self.nextTipID = 1
        self.tips = {}
        self.tipVaults <- {}
        self.tipsByRecipient = {}
        self.tipsBySender = {}
        self.totalLocked = 0.0
        self.paused = false

        self.activeImplVersion = "0.4.1"
        self.pendingImplVersion = nil
        self.pendingImplUnlockAt = 0.0

        self.account.storage.save(
            <-create AdminResource(),
            to: self.AdminStoragePath
        )
    }
}
