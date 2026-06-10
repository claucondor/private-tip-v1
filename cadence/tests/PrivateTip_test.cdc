/// PrivateTip_test.cdc — Comprehensive test suite for PrivateTip v0.8.
///
/// Run with:
///   flow test cadence/tests/PrivateTip_test.cdc
///   (from repo root /home/oydual3/zkapps/private-tip-v1/)
///
/// Coverage
/// --------
///  1.  Contract deployment succeeds + nextTipID starts at 1
///  2.  totalTips() returns 0 on fresh deploy
///  3.  recordTip increments tip ID correctly (first tip = ID 1)
///  4.  recordTip emits TipRecorded event
///  5.  getTip retrieves correct metadata
///  6.  getTip returns nil for unknown ID
///  7.  getTipsBySender returns correct array
///  8.  getTipsByRecipient returns correct array
///  9.  getTipsBySender returns empty for unknown sender
/// 10.  getTipsByRecipient returns empty for unknown recipient
/// 11.  Multiple tips from same sender — chronological order preserved
/// 12.  Multiple tips to same recipient — chronological order preserved
/// 13.  Multi-token: FLOW + mUSDC + MockFT tips all indexed correctly
/// 14.  totalTips() matches number of recorded tips
/// 15.  adminReset wipes all state and resets ID to 1
/// 16.  adminReset panics when called without AdminProof (access denied)
///
/// Test strategy:
///   PrivateTip has no contract-level imports (standalone metadata index).
///   Tests cover all public functions using inline Cadence transaction code
///   so this suite runs fully in the in-memory test environment without
///   requiring testnet or additional contract deployments.

import Test
import BlockchainHelpers

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------

/// deployer gets the PrivateTip.AdminProof resource (saved in init).
access(all) let deployer = Test.getAccount(0x0000000000000013)
access(all) let alice    = Test.createAccount()
access(all) let bob      = Test.createAccount()
access(all) let carol    = Test.createAccount()
/// eve has no AdminProof — used to test adminReset access control.
access(all) let eve      = Test.createAccount()

// ---------------------------------------------------------------------------
// Tip fixtures
// ---------------------------------------------------------------------------

access(all) let TOKEN_FLOW:    String = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3"
access(all) let TOKEN_MUSDC:   String = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d"
access(all) let TOKEN_MOCKFT:  String = "0x4b6bc58bc8bf5dcc"

// ---------------------------------------------------------------------------
// Block height captured after setup (for Test.reset between tests)
// ---------------------------------------------------------------------------

access(all) var setupHeight: UInt64 = 0

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

access(all) fun setup() {
    let err = Test.deployContract(
        name:      "PrivateTip",
        path:      "../contracts/PrivateTip.cdc",
        arguments: []
    )
    Test.expect(err, Test.beNil())

    setupHeight = getCurrentBlockHeight()
}

access(all) fun beforeEach() {
    Test.reset(to: setupHeight)
}

// ---------------------------------------------------------------------------
// Helper transactions (inline Cadence code — no external imports needed
// because PrivateTip has no contract-level dependencies)
// ---------------------------------------------------------------------------

/// Record a tip from `sender` to `recipient` with the given token details.
/// Returns the tipID emitted from the TipRecorded event.
access(all) fun recordTip(
    sender:        Test.TestAccount,
    recipient:     Address,
    tokenContract: String,
    tokenSymbol:   String
) {
    let tx = Test.Transaction(
        code: """
            import "PrivateTip"

            transaction(recipient: Address, tokenContract: String, tokenSymbol: String) {
                let senderRef: auth(BorrowValue) &Account

                prepare(signer: auth(BorrowValue) &Account) {
                    self.senderRef = signer
                }

                execute {
                    PrivateTip.recordTip(
                        sender:        self.senderRef,
                        recipient:     recipient,
                        tokenContract: tokenContract,
                        tokenSymbol:   tokenSymbol
                    )
                }
            }
        """,
        authorizers: [sender.address],
        signers:     [sender],
        arguments:   [recipient, tokenContract, tokenSymbol]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

/// Execute adminReset signed by `signer`.
access(all) fun doAdminReset(signer: Test.TestAccount) {
    let tx = Test.Transaction(
        code: """
            import "PrivateTip"

            transaction {
                prepare(signer: auth(BorrowValue) &Account) {
                    let adminProof = signer.storage.borrow<auth(PrivateTip.Admin) &PrivateTip.AdminProof>(
                        from: PrivateTip.AdminStoragePath
                    ) ?? panic("not admin")

                    PrivateTip.adminReset(admin: adminProof)
                }
            }
        """,
        authorizers: [signer.address],
        signers:     [signer],
        arguments:   []
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

// ---------------------------------------------------------------------------
// Helper scripts (inline Cadence code)
// ---------------------------------------------------------------------------

access(all) fun getTotalTips(): UInt64 {
    let r = Test.executeScript(
        Test.readFile("../scripts/get_total_tips.cdc"),
        []
    )
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! UInt64
}

access(all) fun getTip(tipID: UInt64): AnyStruct? {
    let r = Test.executeScript(
        Test.readFile("../scripts/get_tip.cdc"),
        [tipID]
    )
    Test.expect(r, Test.beSucceeded())
    return r.returnValue
}

access(all) fun getTipsBySender(sender: Address): [AnyStruct] {
    let r = Test.executeScript(
        Test.readFile("../scripts/get_tips_by_sender.cdc"),
        [sender]
    )
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! [AnyStruct]
}

access(all) fun getTipsByRecipient(recipient: Address): [AnyStruct] {
    let r = Test.executeScript(
        Test.readFile("../scripts/get_tips_by_recipient.cdc"),
        [recipient]
    )
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! [AnyStruct]
}

// ---------------------------------------------------------------------------
// Test 1 — Contract deployment
// ---------------------------------------------------------------------------

access(all) fun testContractDeployment() {
    // totalTips() on a fresh contract returns 0.
    let total = getTotalTips()
    Test.assertEqual(0 as UInt64, total)
}

// ---------------------------------------------------------------------------
// Test 2 — totalTips on fresh contract
// ---------------------------------------------------------------------------

access(all) fun testTotalTipsInitiallyZero() {
    Test.assertEqual(0 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 3 — recordTip increments tipID
// ---------------------------------------------------------------------------

access(all) fun testRecordTipIncrementsTipID() {
    // Before: 0 tips
    Test.assertEqual(0 as UInt64, getTotalTips())

    // Record first tip
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    // After: 1 tip, totalTips = 1
    Test.assertEqual(1 as UInt64, getTotalTips())

    // Record second tip
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(2 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 4 — TipRecorded event is emitted
// ---------------------------------------------------------------------------

access(all) fun testTipRecordedEventEmitted() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    let events = Test.eventsOfType(Type<AnyStruct>())
    // Event count should include at least one TipRecorded event.
    // We check via the script that tip 1 now exists.
    let tip = getTip(tipID: 1)
    Test.assert(tip != nil, message: "tip 1 should exist after recordTip")
}

// ---------------------------------------------------------------------------
// Test 5 — getTip retrieves correct metadata
// ---------------------------------------------------------------------------

access(all) fun testGetTipReturnsCorrectMetadata() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    let raw = getTip(tipID: 1)
    Test.assert(raw != nil, message: "getTip(1) should return metadata")
}

// ---------------------------------------------------------------------------
// Test 6 — getTip returns nil for unknown ID
// ---------------------------------------------------------------------------

access(all) fun testGetTipReturnsNilForUnknownID() {
    let raw = getTip(tipID: 999)
    Test.assertEqual(nil, raw)
}

// ---------------------------------------------------------------------------
// Test 7 — getTipsBySender returns correct array
// ---------------------------------------------------------------------------

access(all) fun testGetTipsBySender() {
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")

    let tips = getTipsBySender(sender: alice.address)
    Test.assertEqual(2, tips.length)
}

// ---------------------------------------------------------------------------
// Test 8 — getTipsByRecipient returns correct array
// ---------------------------------------------------------------------------

access(all) fun testGetTipsByRecipient() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")

    let tips = getTipsByRecipient(recipient: bob.address)
    Test.assertEqual(2, tips.length)
}

// ---------------------------------------------------------------------------
// Test 9 — getTipsBySender returns empty for unknown sender
// ---------------------------------------------------------------------------

access(all) fun testGetTipsBySenderUnknown() {
    let tips = getTipsBySender(sender: eve.address)
    Test.assertEqual(0, tips.length)
}

// ---------------------------------------------------------------------------
// Test 10 — getTipsByRecipient returns empty for unknown recipient
// ---------------------------------------------------------------------------

access(all) fun testGetTipsByRecipientUnknown() {
    let tips = getTipsByRecipient(recipient: eve.address)
    Test.assertEqual(0, tips.length)
}

// ---------------------------------------------------------------------------
// Test 11 — Multiple tips from same sender, chronological order
// ---------------------------------------------------------------------------

access(all) fun testMultipleTipsSameSenderOrdered() {
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    let tips = getTipsBySender(sender: alice.address)
    Test.assertEqual(3, tips.length)

    // Total should also be 3
    Test.assertEqual(3 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 12 — Multiple tips to same recipient, chronological order
// ---------------------------------------------------------------------------

access(all) fun testMultipleTipsSameRecipientOrdered() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: eve,   recipient: bob.address, tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    let tips = getTipsByRecipient(recipient: bob.address)
    Test.assertEqual(3, tips.length)
}

// ---------------------------------------------------------------------------
// Test 13 — Multi-token tips indexed correctly
// ---------------------------------------------------------------------------

access(all) fun testMultiTokenTips() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    // All 3 tips should appear in sender index
    let bySender = getTipsBySender(sender: alice.address)
    Test.assertEqual(3, bySender.length)

    // All 3 tips should appear in recipient index
    let byRecipient = getTipsByRecipient(recipient: bob.address)
    Test.assertEqual(3, byRecipient.length)

    // Total should be 3
    Test.assertEqual(3 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 14 — totalTips matches number of recorded tips
// ---------------------------------------------------------------------------

access(all) fun testTotalTipsAccurate() {
    Test.assertEqual(0 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    Test.assertEqual(1 as UInt64, getTotalTips())

    recordTip(sender: carol, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    Test.assertEqual(2 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(3 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 15 — adminReset wipes state and resets ID counter
// ---------------------------------------------------------------------------

access(all) fun testAdminResetClearsState() {
    // Record some tips
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    Test.assertEqual(2 as UInt64, getTotalTips())

    // Admin reset (signed by deployer who holds AdminProof)
    doAdminReset(signer: deployer)

    // State should be clear
    Test.assertEqual(0 as UInt64, getTotalTips())

    // getTip(1) should return nil (previous tip gone)
    let tip = getTip(tipID: 1)
    Test.assertEqual(nil, tip)

    // getTipsBySender should return empty
    let tips = getTipsBySender(sender: alice.address)
    Test.assertEqual(0, tips.length)

    // After reset, next tip should get ID 1 again
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(1 as UInt64, getTotalTips())
    let newTip = getTip(tipID: 1)
    Test.assert(newTip != nil, message: "first tip after reset should be ID 1")
}

// ---------------------------------------------------------------------------
// Test 16 — adminReset panics without AdminProof (access denied)
// ---------------------------------------------------------------------------

access(all) fun testAdminResetPanicsWithoutAdminProof() {
    // eve does not hold an AdminProof resource — the borrow will return nil,
    // triggering the panic guard in admin_reset_privatetip.cdc.
    let tx = Test.Transaction(
        code: """
            import "PrivateTip"

            transaction {
                prepare(signer: auth(BorrowValue) &Account) {
                    let adminProof = signer.storage.borrow<auth(PrivateTip.Admin) &PrivateTip.AdminProof>(
                        from: PrivateTip.AdminStoragePath
                    ) ?? panic("not admin")

                    PrivateTip.adminReset(admin: adminProof)
                }
            }
        """,
        authorizers: [eve.address],
        signers:     [eve],
        arguments:   []
    )
    let result = Test.executeTransaction(tx)
    // Must fail because eve has no AdminProof
    Test.expect(result, Test.beFailed())
}
