// PrivateTip.cdc — Router + custody for native-FLOW tipping with signer-bound claims.
//
// Architecture: Router/façade + swappable pure-logic implementation (mirrors JanusFlow).
//
//   PrivateTip      = router + custody (FlowToken vaults per tip, tip records, pause flag)
//                     State NEVER moves on impl swap.
//
//   PrivateTipImpl  = pure-logic impl (stateless, no resources)
//                     Swappable via 48h time-lock.
//
//   IPrivateTipImpl = interface; current PrivateTipImpl conforms.
//
// Privacy model:
//   - Amount per tip: VISIBLE on-chain in this Layer-3 contract (native FLOW custody).
//     Cryptographic hiding of amounts is the job of JanusFlow / JanusToken (Layer-2);
//     this contract is the simpler "named tips with metadata" UX layer.
//   - Sender → recipient relationship: VISIBLE on-chain.
//   - Memo: VISIBLE on-chain (max 280 chars).
//
// Vuln 015 fix (CRITICAL):
//   Previous monolithic PrivateTip used `self.account.address` (== contract deployer)
//   in claimTip authorization, so ONLY the deployer could ever claim any tip — and
//   conversely, the deployer could "claim" tips intended for ANY recipient. The new
//   claimTip takes an `auth(BorrowValue) &Account` signer reference, which the
//   transaction must construct from the actual transaction signer. The router then
//   asserts `tip.recipient == signer.address` using the SIGNER, not the contract.
//   The auth-ref construction itself is gated by Cadence so non-signers cannot forge
//   it.
//
// Admin model: capability-based AdminResource saved to deployer storage.
//   Entitlements: Pause | Upgrade. Pause is independent of impl swap. Impl swap has
//   a 48h time-lock; pause is immediate.
//
// Deployed at: 0xb9ac529c14a4c5a1 (openjanus-privatetip-router — v0.2.1 sprint Phase 3).
// Replaces deprecated monolith at 0xd807a3992d7be612 (bob's deployer account; vuln 015).

import "FlowToken"
import "FungibleToken"
import IPrivateTipImpl from 0xb9ac529c14a4c5a1
import PrivateTipImpl from 0xb9ac529c14a4c5a1

access(all) contract PrivateTip {

    // ─── Entitlements ───────────────────────────────────────────────────────────

    access(all) entitlement Pause
    access(all) entitlement Upgrade

    // ─── Storage Paths ──────────────────────────────────────────────────────────

    access(all) let AdminStoragePath: StoragePath
    access(all) let TipsCustodyVaultPath: StoragePath  // reserved for future migrations

    // ─── State — Custody (NEVER moves on impl swap) ─────────────────────────────

    /// Monotonically-increasing counter for tipIDs.
    access(self) var nextTipID: UInt64

    /// Tip record per tipID. Read-only after creation except for `claimed` flag.
    access(self) var tips: {UInt64: TipRecord}

    /// FLOW custody keyed by tipID. Vault is moved out on successful claim.
    access(self) var tipVaults: @{UInt64: FlowToken.Vault}

    /// Index: tipIDs grouped by recipient (for efficient queries).
    access(self) var tipsByRecipient: {Address: [UInt64]}

    /// Index: tipIDs grouped by sender (for efficient queries).
    access(self) var tipsBySender: {Address: [UInt64]}

    /// Cumulative FLOW currently held in custody (sum across all unclaimed tipVaults).
    access(self) var totalLocked: UFix64

    // ─── State — Router/Admin ───────────────────────────────────────────────────

    /// Emergency-stop flag. When true, sendTip and claimTip are blocked.
    access(self) var paused: Bool

    /// Active impl version string.
    access(self) var activeImplVersion: String

    /// Pending impl swap: new version (nil = no pending swap).
    access(self) var pendingImplVersion: String?

    /// Unix timestamp after which the pending impl swap can be finalized (48h lock).
    access(self) var pendingImplUnlockAt: UFix64

    // ─── Events ─────────────────────────────────────────────────────────────────

    access(all) event TipSent(
        tipID: UInt64,
        sender: Address,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64,
        memo: String?
    )

    access(all) event TipClaimed(
        tipID: UInt64,
        recipient: Address,
        amount: UFix64,
        timestamp: UFix64
    )

    access(all) event Paused()
    access(all) event Unpaused()
    access(all) event ImplSwapProposed(pendingVersion: String, unlockAt: UFix64)
    access(all) event ImplSwapped(oldVersion: String, newVersion: String)
    access(all) event ImplSwapCancelled()

    // ─── Tip Record (struct, not resource — read-only metadata) ─────────────────

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
    }

    // ─── Admin Resource ─────────────────────────────────────────────────────────

    access(all) resource AdminResource {

        /// Emergency stop: blocks sendTip and claimTip.
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

        /// Cancel a pending impl swap (no time-lock required).
        access(Upgrade) fun cancelImplSwap() {
            PrivateTip.pendingImplVersion = nil
            PrivateTip.pendingImplUnlockAt = 0.0
            emit ImplSwapCancelled()
        }
    }

    // ─── Public User Functions ──────────────────────────────────────────────────

    /// Send a tip with native FLOW custody held by the router until claimed.
    ///
    /// The sender supplies (1) a signed payment vault and (2) the recipient address.
    /// The router validates with the impl, stores the FLOW + record, returns the tipID.
    ///
    /// @param sender     The Flow account sending the tip (auth ref proves ownership)
    /// @param recipient  Flow address of the intended recipient
    /// @param payment    @FlowToken.Vault holding the tip amount (must be > 0)
    /// @param memo       Optional public memo (max 280 chars)
    /// @return tipID     Unique UInt64 identifier for this tip
    access(all) fun sendTip(
        sender: auth(BorrowValue) &Account,
        recipient: Address,
        payment: @FlowToken.Vault,
        memo: String?
    ): UInt64 {
        pre {
            !self.paused: "PrivateTip: contract is paused"
        }

        let senderAddr = sender.address
        let amount = payment.balance

        // Delegate input validation to the impl.
        let err = PrivateTipImpl.validateSendTip(
            sender: senderAddr,
            recipient: recipient,
            amount: amount,
            memo: memo
        )
        assert(err == "", message: "PrivateTip.sendTip: ".concat(err))

        // Allocate tipID, build the record.
        let tipID = self.nextTipID
        self.nextTipID = self.nextTipID + 1
        let timestamp = getCurrentBlock().timestamp

        self.tips[tipID] = TipRecord(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            amount: amount,
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

        // Custody: move the payment vault into the per-tip custody dictionary.
        let oldVault <- self.tipVaults[tipID] <- (payment as! @FlowToken.Vault)
        // tipID is fresh from nextTipID, so oldVault MUST be nil. Destroy to satisfy
        // Cadence's resource exhaustion check.
        destroy oldVault

        self.totalLocked = self.totalLocked + amount

        emit TipSent(
            tipID: tipID,
            sender: senderAddr,
            recipient: recipient,
            amount: amount,
            timestamp: timestamp,
            memo: memo
        )

        return tipID
    }

    /// Claim a tip and receive the held FLOW vault.
    ///
    /// VULN 015 FIX: takes an `auth(BorrowValue) &Account` signer reference instead
    /// of using `self.account.address`. The transaction submitting this call MUST
    /// construct the auth ref from the actual signer — Cadence enforces this.
    ///
    /// @param signer  The claiming account (must equal the tip's recorded recipient)
    /// @param tipID   The tip to claim
    /// @return        @FlowToken.Vault containing the tip amount
    access(all) fun claimTip(
        signer: auth(BorrowValue) &Account,
        tipID: UInt64
    ): @FlowToken.Vault {
        pre {
            !self.paused: "PrivateTip: contract is paused"
        }

        let claimer = signer.address
        let tipExists = self.tips.containsKey(tipID)
        let tipRecipient: Address = tipExists ? self.tips[tipID]!.recipient : 0x0
        let tipClaimed: Bool = tipExists ? self.tips[tipID]!.claimed : false

        // Delegate auth + state-validation to the impl. The impl resolves to the
        // canonical error message; the router enforces the actual abort.
        let err = PrivateTipImpl.validateClaim(
            tipExists: tipExists,
            tipRecipient: tipRecipient,
            tipClaimed: tipClaimed,
            claimer: claimer
        )
        assert(err == "", message: "PrivateTip.claimTip: ".concat(err))

        // Mark claimed in the record.
        let updatedRecord = self.tips[tipID]!
        updatedRecord.markClaimed()
        self.tips[tipID] = updatedRecord

        // Move the vault out of custody.
        let vault <- self.tipVaults.remove(key: tipID)
            ?? panic("PrivateTip.claimTip: tip vault missing — corrupted state")

        let amount = vault.balance
        self.totalLocked = self.totalLocked - amount

        emit TipClaimed(
            tipID: tipID,
            recipient: claimer,
            amount: amount,
            timestamp: getCurrentBlock().timestamp
        )

        return <- vault
    }

    // ─── Read-only Views ────────────────────────────────────────────────────────

    access(all) view fun getTip(tipID: UInt64): TipRecord? {
        return self.tips[tipID]
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

    access(all) view fun getTipCount(recipient: Address): UInt64 {
        if let ids = self.tipsByRecipient[recipient] {
            return UInt64(ids.length)
        }
        return 0
    }

    access(all) view fun getTotalTipCount(): UInt64 {
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

        self.activeImplVersion = "0.1.0"
        self.pendingImplVersion = nil
        self.pendingImplUnlockAt = 0.0

        // Save admin resource into the deployer's storage. The deployer is the
        // router account (openjanus-privatetip-router); the admin capability can be
        // delegated by issuing a Pause | Upgrade capability from this storage path.
        self.account.storage.save(
            <-create AdminResource(),
            to: self.AdminStoragePath
        )
    }
}
