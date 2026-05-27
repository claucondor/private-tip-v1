// PrivateTip.cdc — v0.3 orchestrator router (pure orchestrator over JanusFlow).
//
// Architecture:
//   v0.3 PrivateTip is a PURE ORCHESTRATOR. It does NOT custody FlowToken.
//   The shielded value transfer is done by JanusFlow.shieldedTransfer (which in
//   turn calls the EVM JanusFlow proxy via the signer's COA). PrivateTip only
//   records the (sender, recipient, memo, timestamp) tuple so indexers can list
//   "what tips did X receive" without ever learning amounts.
//
//   PrivateTip      = router + metadata records + pause flag (no escrow in v0.3)
//   PrivateTipImpl  = pure-logic impl (stateless)
//   IPrivateTipImpl = interface
//
// Privacy model (v0.3):
//   - Amount per tip: HIDDEN ON-CHAIN. Not in TipRecord (amount = 0.0 sentinel),
//     not in TipSentShielded event. The amount lives only in the JanusFlow EVM
//     proxy's Pedersen commitment update, which leaks ONLY (from, to) — see
//     audits-kb v0.3 privacy validation.
//   - Sender → recipient relationship: VISIBLE.
//   - Memo: VISIBLE (max 280 chars).
//   - ciphertextRef (Pedersen C_tx point): ONLY in the TipSentShielded event
//     (not in storage). Under the perfect-hiding property of Pedersen, no info
//     about the amount can be recovered without the blinding factor (which
//     never leaves the sender's wallet).
//
// Pre-condition for users: pre-fund JanusFlow slot ONCE via JanusFlow.wrap(...).
// Recipients unwrap from their JanusFlow slot when they want to cash out
// (NOT a per-tip claim).
//
// Backward compat:
//   v0.2 storage fields are KEPT (Cadence upgrade validator requires it). The
//   legacy `sendTip` / `claimTip` functions are REMOVED. Existing TipRecord
//   entries from v0.2 remain readable; distinguishable from v0.3 records by
//   `amount > 0.0`. Any leftover v0.2 tipVaults are drainable via
//   `adminDrainLegacyVault` (testnet only).
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
    access(all) let TipsCustodyVaultPath: StoragePath  // reserved (unused in v0.3)

    // ─── State — KEPT for Cadence upgrade compat ────────────────────────────────
    // The Cadence upgrade validator requires storage fields to remain in place.
    // We keep them all; the v0.3 orchestrator path stops writing/reading the
    // legacy fields beyond what's needed for backward queries.

    /// Monotonically-increasing counter for tipIDs.
    access(self) var nextTipID: UInt64

    /// Tip record per tipID. In v0.3 we keep this dict and use `amount == 0.0`
    /// as the sentinel meaning "shielded tip — amount is HIDDEN on-chain (lives
    /// in JanusFlow Pedersen commitment)". Pre-existing v0.2 records have
    /// `amount > 0.0` and remain readable as before.
    access(self) var tips: {UInt64: TipRecord}

    /// LEGACY v0.2 FLOW custody. Drained via adminDrainLegacyVault in v0.3.
    /// New v0.3 tips NEVER write here.
    access(self) var tipVaults: @{UInt64: FlowToken.Vault}

    /// Index: tipIDs grouped by recipient (covers BOTH v0.2 and v0.3 tips).
    access(self) var tipsByRecipient: {Address: [UInt64]}

    /// Index: tipIDs grouped by sender (covers BOTH v0.2 and v0.3 tips).
    access(self) var tipsBySender: {Address: [UInt64]}

    /// Cumulative FLOW held in legacy v0.2 custody (drains to 0 as admin clears).
    access(self) var totalLocked: UFix64

    // ─── State — Router/Admin ───────────────────────────────────────────────────

    /// Emergency-stop flag. When true, recordTip is blocked.
    access(self) var paused: Bool

    /// Active impl version string. Updated to "0.3.0" on first orchestrator deploy.
    access(self) var activeImplVersion: String

    /// Pending impl swap: new version (nil = no pending swap).
    access(self) var pendingImplVersion: String?

    /// Unix timestamp after which the pending impl swap can be finalized (48h lock).
    access(self) var pendingImplUnlockAt: UFix64

    // ─── Events ─────────────────────────────────────────────────────────────────

    /// LEGACY v0.2 event. KEPT for upgrade compat (Cadence forbids event
    /// declaration removal). v0.3 code path never emits this; pre-existing
    /// v0.2 indexers continue to see only the historical TipSent events.
    access(all) event TipSent(
        tipID: UInt64,
        sender: Address,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64,
        memo: String?
    )

    /// LEGACY v0.2 event. KEPT for upgrade compat. Emitted ONLY by the
    /// adminDrainLegacyVault path (and historical v0.2 claims). v0.3 has
    /// no per-tip claim concept.
    access(all) event TipClaimed(
        tipID: UInt64,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64
    )

    /// v0.3 shielded-tip event. NO amount field — the amount is hidden in
    /// JanusFlow. ciphertextRef = [C_tx.x, C_tx.y] = Pedersen commit of
    /// (transferAmount, blinding). Under Pedersen perfect-hiding, this point
    /// leaks NO amount info without the blinding factor.
    access(all) event TipSentShielded(
        tipID: UInt64,
        sender: Address,
        recipient: Address,
        timestamp: UFix64,
        ciphertextRef: [UInt256],
        memo: String?
    )

    /// Emitted when admin drains a leftover v0.2 tipVault.
    access(all) event LegacyVaultDrained(
        tipID: UInt64,
        recipient: Address,
        amount: UFix64
    )

    access(all) event Paused()
    access(all) event Unpaused()
    access(all) event ImplSwapProposed(pendingVersion: String, unlockAt: UFix64)
    access(all) event ImplSwapped(oldVersion: String, newVersion: String)
    access(all) event ImplSwapCancelled()

    // ─── Tip Record (FROZEN shape for storage compat) ───────────────────────────

    /// TipRecord stores both legacy v0.2 escrow tips and v0.3 shielded tips.
    /// Discriminator:
    ///   v0.2: amount > 0.0 (was the per-tip FlowToken vault balance)
    ///   v0.3: amount == 0.0 (sentinel — amount is hidden in JanusFlow)
    ///
    /// Storage compatibility: field set IDENTICAL to v0.2 (Cadence upgrade
    /// validator forbids adding fields to existing structs). The v0.3
    /// ciphertextRef is carried in the TipSentShielded event ONLY.
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

        access(contract) fun markClaimed() {
            self.claimed = true
        }

        /// Convenience: true if this record was created by a v0.3 shielded path.
        access(all) view fun isShielded(): Bool {
            return self.amount == 0.0
        }
    }

    /// Lightweight v0.3 view-only struct returned by getTipMetadata(...).
    /// Encodes the v0.3 privacy contract explicitly: NO amount, NO claimed flag.
    /// Note: ciphertextRef is NOT included — it's emitted in TipSentShielded
    /// events only and must be retrieved from event logs by indexers.
    access(all) struct TipMetadata {
        access(all) let tipID: UInt64
        access(all) let sender: Address
        access(all) let recipient: Address
        access(all) let timestamp: UFix64
        access(all) let memo: String?

        init(
            tipID: UInt64,
            sender: Address,
            recipient: Address,
            timestamp: UFix64,
            memo: String?
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

        /// Emergency stop: blocks recordTip.
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

        /// Propose an impl swap to a new version. Starts the 48h time-lock.
        access(Upgrade) fun proposeImplSwap(newVersion: String) {
            PrivateTip.pendingImplVersion = newVersion
            PrivateTip.pendingImplUnlockAt = getCurrentBlock().timestamp + 172800.0 // 48h
            emit ImplSwapProposed(
                pendingVersion: newVersion,
                unlockAt: PrivateTip.pendingImplUnlockAt
            )
        }

        /// Finalize a pending impl swap after the time-lock has expired.
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

        /// Force the activeImplVersion string without going through the time-lock.
        /// Intended for the one-time v0.2 → v0.3 cutover.
        access(Upgrade) fun forceSetImplVersion(version: String) {
            let old = PrivateTip.activeImplVersion
            PrivateTip.activeImplVersion = version
            emit ImplSwapped(oldVersion: old, newVersion: version)
        }

        /// Drain a leftover v0.2 tipVault. Returns the @FlowToken.Vault so the
        /// caller transaction can deposit it into the recipient's vault.
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
    }

    // ─── v0.3 Public Orchestrator Function ──────────────────────────────────────

    /// Record metadata for a shielded tip.
    ///
    /// THIS IS THE v0.3 ENTRY POINT. The amount transfer happens out-of-band
    /// in the SAME Cadence transaction by calling JanusFlow.shieldedTransfer
    /// BEFORE this function — Cadence's atomicity guarantees both calls
    /// succeed or both abort.
    ///
    /// Privacy contract:
    ///   - Emitted TipSentShielded carries NO amount.
    ///   - Stored TipRecord has amount = 0.0 (sentinel for "shielded").
    ///   - ciphertextRef is the Pedersen C_tx point (Cx, Cy), opaque under
    ///     perfect-hiding.
    ///
    /// @param sender         auth ref to the sender's account
    /// @param recipient      Flow address of the tip recipient
    /// @param ciphertextRef  [Cx, Cy] of the Pedersen transfer-commit
    /// @param memo           Optional public memo (max 280 chars)
    /// @return tipID         Newly-allocated UInt64 identifier
    access(all) fun recordTip(
        sender: auth(BorrowValue) &Account,
        recipient: Address,
        ciphertextRef: [UInt256],
        memo: String?
    ): UInt64 {
        pre {
            !self.paused: "PrivateTip: contract is paused"
        }

        let senderAddr = sender.address

        // Delegate structural validation to the impl.
        let err = PrivateTipImpl.validateRecordTip(
            sender: senderAddr,
            recipient: recipient,
            ciphertextLen: ciphertextRef.length,
            memo: memo
        )
        assert(err == "", message: "PrivateTip.recordTip: ".concat(err))

        // Allocate tipID, build the record.
        let tipID = self.nextTipID
        self.nextTipID = self.nextTipID + 1
        let timestamp = getCurrentBlock().timestamp

        self.tips[tipID] = TipRecord(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            amount: 0.0,           // sentinel: shielded (amount hidden)
            timestamp: timestamp,
            memo: memo
        )

        // Index updates.
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

        emit TipSentShielded(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            timestamp: timestamp,
            ciphertextRef: ciphertextRef,
            memo: memo
        )

        return tipID
    }

    // ─── Read-only Views ────────────────────────────────────────────────────────

    /// Full TipRecord (covers v0.2 + v0.3).
    access(all) view fun getTip(tipID: UInt64): TipRecord? {
        return self.tips[tipID]
    }

    /// v0.3-specific metadata view (returns nil if the record is v0.2 escrow).
    access(all) fun getTipMetadata(tipID: UInt64): TipMetadata? {
        if let r = self.tips[tipID] {
            if r.isShielded() {
                return TipMetadata(
                    tipID: r.tipID,
                    sender: r.sender,
                    recipient: r.recipient,
                    timestamp: r.timestamp,
                    memo: r.memo
                )
            }
        }
        return nil
    }

    /// All TipRecords addressed to recipient (covers v0.2 + v0.3).
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

    /// Only v0.3 shielded TipMetadata for recipient.
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
                        timestamp: r.timestamp,
                        memo: r.memo
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
                        timestamp: r.timestamp,
                        memo: r.memo
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

    // ─── Initializer ────────────────────────────────────────────────────────────
    // NOTE: init() does NOT re-run on contract upgrades. It ran once at the
    // original v0.2 deployment. Existing on-chain values for these fields
    // persist across the v0.2 → v0.3 update.

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

        // For brand-new deployments, start at v0.3. The on-chain update path
        // ignores this (init doesn't re-run); operators run admin_force_set_impl_version
        // to flip the active version after upgrading.
        self.activeImplVersion = "0.3.0"
        self.pendingImplVersion = nil
        self.pendingImplUnlockAt = 0.0

        self.account.storage.save(
            <-create AdminResource(),
            to: self.AdminStoragePath
        )
    }
}
