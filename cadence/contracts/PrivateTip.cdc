// PrivateTip.cdc — v0.8 minimal metadata index.
//
// Deployed at: 0x4b6bc58bc8bf5dcc (openjanus-v08).
// NOT an upgrade of 0xb9ac529c14a4c5a1 — new account, clean state.
//
// Privacy model:
//   - Amount per tip:    HIDDEN (lives in ShieldedInbox cipher delivered by JanusToken.shieldedTransfer)
//   - Memo content:      HIDDEN (lives in ShieldedInbox cipher)
//   - Sender/recipient:  VISIBLE (public linkage is PrivateTip's stated trade-off)
//   - Token type:        VISIBLE (via tokenContract + tokenSymbol)
//
// No encrypted blobs. No escrow vaults. No impl-swap machinery.
// PrivateTip is a pure lookup index: "who tipped whom, when, with which token."
//
// Design note on tokenContract type:
//   The field uses String (not Address) because EVM contract addresses are 20 bytes
//   while Cadence Address is 8 bytes — the types are incompatible.
//   For EVM tokens (JanusFlow/JanusERC20), the full checksummed EVM hex address
//   is stored (e.g. "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3").
//   For Cadence tokens (JanusFT), the 8-byte Cadence deployer address in hex
//   is stored (e.g. "0x4b6bc58bc8bf5dcc").

access(all) contract PrivateTip {

    // ─── Entitlements ──────────────────────────────────────────────────────────
    access(all) entitlement Admin

    // ─── Storage paths ─────────────────────────────────────────────────────────
    access(all) let AdminStoragePath: StoragePath

    // ─── State ─────────────────────────────────────────────────────────────────
    access(self) var nextTipID:      UInt64
    access(self) var tipsByID:       {UInt64: TipMetadata}
    access(self) var tipsBySender:   {Address: [UInt64]}
    access(self) var tipsByRecipient: {Address: [UInt64]}

    // ─── Structs ───────────────────────────────────────────────────────────────

    access(all) struct TipMetadata {
        access(all) let tipID:         UInt64
        access(all) let sender:        Address
        access(all) let recipient:     Address
        access(all) let timestamp:     UFix64
        /// EVM hex addr for JanusFlow/JanusERC20; Cadence hex addr for JanusFT.
        access(all) let tokenContract: String
        /// Display hint: "FLOW" | "mUSDC" | "MockFT"
        access(all) let tokenSymbol:   String

        init(
            tipID:         UInt64,
            sender:        Address,
            recipient:     Address,
            timestamp:     UFix64,
            tokenContract: String,
            tokenSymbol:   String
        ) {
            self.tipID         = tipID
            self.sender        = sender
            self.recipient     = recipient
            self.timestamp     = timestamp
            self.tokenContract = tokenContract
            self.tokenSymbol   = tokenSymbol
        }
    }

    // ─── Events ────────────────────────────────────────────────────────────────

    access(all) event TipRecorded(
        tipID:         UInt64,
        sender:        Address,
        recipient:     Address,
        tokenContract: String,
        tokenSymbol:   String
    )

    // ─── Admin resource ────────────────────────────────────────────────────────

    /// Marker resource. The holder can invoke Admin-gated functions.
    /// Saved to the contract account at AdminStoragePath during init.
    /// Only the deployer account (0x4b6bc58bc8bf5dcc) can borrow it.
    access(all) resource AdminProof {}

    // ─── Write ─────────────────────────────────────────────────────────────────

    /// Record tip metadata atomically with the shieldedTransfer that precedes it.
    /// Must be called in the same Cadence transaction as the transfer.
    /// If the transfer fails, this call never executes; if this fails, both revert.
    ///
    /// Parameters:
    ///   sender        Authenticated reference to the signer's account.
    ///   recipient     Cadence address of the tip recipient.
    ///   tokenContract String identifier for the token:
    ///                   EVM proxy hex  → JanusFlow or JanusERC20
    ///                   Cadence hex    → JanusFT deployer address
    ///   tokenSymbol   Human-readable symbol for display ("FLOW", "mUSDC", "MockFT").
    ///
    /// Returns the assigned tipID (UInt64, starting at 1).
    access(all) fun recordTip(
        sender:        auth(BorrowValue) &Account,
        recipient:     Address,
        tokenContract: String,
        tokenSymbol:   String
    ): UInt64 {
        let tipID = self.nextTipID
        let meta  = TipMetadata(
            tipID:         tipID,
            sender:        sender.address,
            recipient:     recipient,
            timestamp:     getCurrentBlock().timestamp,
            tokenContract: tokenContract,
            tokenSymbol:   tokenSymbol
        )
        self.nextTipID = self.nextTipID + 1
        self.tipsByID[tipID] = meta

        if let existing = self.tipsBySender[sender.address] {
            self.tipsBySender[sender.address] = existing.concat([tipID])
        } else {
            self.tipsBySender[sender.address] = [tipID]
        }

        if let existing = self.tipsByRecipient[recipient] {
            self.tipsByRecipient[recipient] = existing.concat([tipID])
        } else {
            self.tipsByRecipient[recipient] = [tipID]
        }

        emit TipRecorded(
            tipID:         tipID,
            sender:        sender.address,
            recipient:     recipient,
            tokenContract: tokenContract,
            tokenSymbol:   tokenSymbol
        )
        return tipID
    }

    // ─── Read ──────────────────────────────────────────────────────────────────

    /// Fetch a single tip by ID. Returns nil if tipID does not exist.
    access(all) view fun getTip(tipID: UInt64): TipMetadata? {
        return self.tipsByID[tipID]
    }

    /// Total number of tips recorded (across all tokens).
    access(all) view fun totalTips(): UInt64 {
        return UInt64(self.tipsByID.length)
    }

    /// All tips sent by `sender`, chronological order (oldest first).
    access(all) fun getTipsBySender(sender: Address): [TipMetadata] {
        let ids = self.tipsBySender[sender] ?? []
        var out: [TipMetadata] = []
        for id in ids {
            if let m = self.tipsByID[id] {
                out.append(m)
            }
        }
        return out
    }

    /// All tips received by `recipient`, chronological order (oldest first).
    access(all) fun getTipsByRecipient(recipient: Address): [TipMetadata] {
        let ids = self.tipsByRecipient[recipient] ?? []
        var out: [TipMetadata] = []
        for id in ids {
            if let m = self.tipsByID[id] {
                out.append(m)
            }
        }
        return out
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    /// Testnet-only: wipe all tip state and reset the ID counter.
    /// Useful during dev iteration without redeploying.
    /// Caller must hold auth(Admin) &AdminProof (deployer account only).
    access(all) fun adminReset(admin: auth(Admin) &AdminProof) {
        self.nextTipID       = 1
        self.tipsByID        = {}
        self.tipsBySender    = {}
        self.tipsByRecipient = {}
    }

    // ─── Init ──────────────────────────────────────────────────────────────────

    init() {
        self.AdminStoragePath  = /storage/privateTipAdmin
        self.nextTipID         = 1
        self.tipsByID          = {}
        self.tipsBySender      = {}
        self.tipsByRecipient   = {}

        let adminProof <- create AdminProof()
        self.account.storage.save(<-adminProof, to: self.AdminStoragePath)
    }
}
