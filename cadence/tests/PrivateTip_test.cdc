/// PrivateTip_test.cdc — Comprehensive test suite for PrivateTip v0.8.
///
/// Run with:
///   flow test cadence/tests/PrivateTip_test.cdc
///   (from repo root /home/oydual3/zkapps/private-tip-v1/)
///
/// Coverage
/// --------
///  1.  Contract deployment succeeds
///  2.  totalTips() returns 0 on fresh deploy
///  3.  recordTip increments tip count correctly (first tip = ID 1)
///  4.  getTip retrieves tip after recordTip
///  5.  getTip returns nil for unknown ID
///  6.  getTipsBySender returns correct array
///  7.  getTipsByRecipient returns correct array
///  8.  getTipsBySender returns empty for unknown sender
///  9.  getTipsByRecipient returns empty for unknown recipient
/// 10.  Multiple tips from same sender — array size matches
/// 11.  Multiple tips to same recipient — array size matches
/// 12.  Multi-token tips all indexed correctly
/// 13.  totalTips matches number of recorded tips (incremental)
/// 14.  adminReset wipes state and resets ID counter to 1
/// 15.  adminReset panics when called without AdminProof (access denied)
/// 16.  Post-reset: new tips start from ID 1 again
///
/// PrivateTip has no contract-level imports (standalone metadata index).
/// Tests cover all public functions via helpers/record_tip.cdc +
/// helpers/admin_reset.cdc — no external contract deployments needed.

import Test
import BlockchainHelpers

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------

/// deployer gets the PrivateTip.AdminProof resource (saved during init).
/// Matches the "testing" alias in flow.json: 0000000000000014.
access(all) let deployer = Test.getAccount(0x0000000000000014)
access(all) let alice    = Test.createAccount()
access(all) let bob      = Test.createAccount()
access(all) let carol    = Test.createAccount()
/// eve has no AdminProof — used to verify adminReset access control.
access(all) let eve      = Test.createAccount()

// ---------------------------------------------------------------------------
// Token contract address fixtures (match testnet v0.8 deployment)
// ---------------------------------------------------------------------------

access(all) let TOKEN_FLOW:   String = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3"
access(all) let TOKEN_MUSDC:  String = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d"
access(all) let TOKEN_MOCKFT: String = "0x4b6bc58bc8bf5dcc"

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
// Helper: record a tip via helpers/record_tip.cdc
// ---------------------------------------------------------------------------

access(all) fun recordTip(
    sender:        Test.TestAccount,
    recipient:     Address,
    tokenContract: String,
    tokenSymbol:   String
) {
    let tx = Test.Transaction(
        code:        Test.readFile("helpers/record_tip.cdc"),
        authorizers: [sender.address],
        signers:     [sender],
        arguments:   [recipient, tokenContract, tokenSymbol]
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())
}

// ---------------------------------------------------------------------------
// Helper scripts using cadence/scripts/ files
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
// Test 1 — Contract deployment succeeds
// ---------------------------------------------------------------------------

access(all) fun testContractDeployment() {
    // If setup() passed (no panic), deployment succeeded.
    // Verify the initial state by calling totalTips().
    let total = getTotalTips()
    Test.assertEqual(0 as UInt64, total)
}

// ---------------------------------------------------------------------------
// Test 2 — totalTips returns 0 on fresh deploy
// ---------------------------------------------------------------------------

access(all) fun testTotalTipsInitiallyZero() {
    Test.assertEqual(0 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 3 — recordTip increments tip count
// ---------------------------------------------------------------------------

access(all) fun testRecordTipIncrementsTipCount() {
    Test.assertEqual(0 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    Test.assertEqual(1 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(2 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 4 — getTip retrieves tip after recordTip
// ---------------------------------------------------------------------------

access(all) fun testGetTipReturnsMetadata() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    let tip = getTip(tipID: 1)
    Test.assert(tip != nil, message: "getTip(1) should return TipMetadata after recordTip")
}

// ---------------------------------------------------------------------------
// Test 5 — getTip returns nil for unknown ID
// ---------------------------------------------------------------------------

access(all) fun testGetTipReturnsNilForUnknown() {
    let tip = getTip(tipID: 999)
    Test.assertEqual(nil, tip)
}

// ---------------------------------------------------------------------------
// Test 6 — getTipsBySender returns correct array
// ---------------------------------------------------------------------------

access(all) fun testGetTipsBySenderCorrect() {
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    // carol sends one tip — should NOT appear in alice's index
    recordTip(sender: carol, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")

    let aliceTips = getTipsBySender(sender: alice.address)
    Test.assertEqual(2, aliceTips.length)

    let carolTips = getTipsBySender(sender: carol.address)
    Test.assertEqual(1, carolTips.length)
}

// ---------------------------------------------------------------------------
// Test 7 — getTipsByRecipient returns correct array
// ---------------------------------------------------------------------------

access(all) fun testGetTipsByRecipientCorrect() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    // tip to carol — should NOT appear in bob's index
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    let bobTips = getTipsByRecipient(recipient: bob.address)
    Test.assertEqual(2, bobTips.length)

    let carolTips = getTipsByRecipient(recipient: carol.address)
    Test.assertEqual(1, carolTips.length)
}

// ---------------------------------------------------------------------------
// Test 8 — getTipsBySender returns empty for unknown sender
// ---------------------------------------------------------------------------

access(all) fun testGetTipsBySenderUnknown() {
    let tips = getTipsBySender(sender: eve.address)
    Test.assertEqual(0, tips.length)
}

// ---------------------------------------------------------------------------
// Test 9 — getTipsByRecipient returns empty for unknown recipient
// ---------------------------------------------------------------------------

access(all) fun testGetTipsByRecipientUnknown() {
    let tips = getTipsByRecipient(recipient: eve.address)
    Test.assertEqual(0, tips.length)
}

// ---------------------------------------------------------------------------
// Test 10 — Multiple tips from same sender
// ---------------------------------------------------------------------------

access(all) fun testMultipleTipsSameSender() {
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    let tips = getTipsBySender(sender: alice.address)
    Test.assertEqual(3, tips.length)
}

// ---------------------------------------------------------------------------
// Test 11 — Multiple tips to same recipient
// ---------------------------------------------------------------------------

access(all) fun testMultipleTipsSameRecipient() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: eve,   recipient: bob.address, tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    let tips = getTipsByRecipient(recipient: bob.address)
    Test.assertEqual(3, tips.length)
}

// ---------------------------------------------------------------------------
// Test 12 — Multi-token tips all indexed correctly
// ---------------------------------------------------------------------------

access(all) fun testMultiTokenTipsIndexed() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW,   tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_MUSDC,  tokenSymbol: "mUSDC")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_MOCKFT, tokenSymbol: "MockFT")

    Test.assertEqual(3, getTipsBySender(sender: alice.address).length)
    Test.assertEqual(3, getTipsByRecipient(recipient: bob.address).length)
    Test.assertEqual(3 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 13 — totalTips matches incrementally
// ---------------------------------------------------------------------------

access(all) fun testTotalTipsIncremental() {
    Test.assertEqual(0 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    Test.assertEqual(1 as UInt64, getTotalTips())

    recordTip(sender: carol, recipient: bob.address,   tokenContract: TOKEN_FLOW,  tokenSymbol: "FLOW")
    Test.assertEqual(2 as UInt64, getTotalTips())

    recordTip(sender: alice, recipient: carol.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(3 as UInt64, getTotalTips())
}

// ---------------------------------------------------------------------------
// Test 14 — adminReset wipes state
// ---------------------------------------------------------------------------

access(all) fun testAdminResetClearsState() {
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    Test.assertEqual(2 as UInt64, getTotalTips())

    // Admin reset — deployer account holds AdminProof
    let tx = Test.Transaction(
        code:        Test.readFile("helpers/admin_reset.cdc"),
        authorizers: [deployer.address],
        signers:     [deployer],
        arguments:   []
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beSucceeded())

    // State is cleared
    Test.assertEqual(0 as UInt64, getTotalTips())
    Test.assertEqual(nil, getTip(tipID: 1))
    Test.assertEqual(0, getTipsBySender(sender: alice.address).length)
}

// ---------------------------------------------------------------------------
// Test 15 — adminReset panics without AdminProof
// ---------------------------------------------------------------------------

access(all) fun testAdminResetPanicsWithoutAdminProof() {
    // eve does not hold AdminProof — borrow returns nil → panic
    let tx = Test.Transaction(
        code:        Test.readFile("helpers/admin_reset.cdc"),
        authorizers: [eve.address],
        signers:     [eve],
        arguments:   []
    )
    let result = Test.executeTransaction(tx)
    Test.expect(result, Test.beFailed())
}

// ---------------------------------------------------------------------------
// Test 16 — Post-reset new tips start from ID 1
// ---------------------------------------------------------------------------

access(all) fun testPostResetTipsStartFromIDOne() {
    // Record, reset, then record again
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")
    recordTip(sender: alice, recipient: bob.address, tokenContract: TOKEN_FLOW, tokenSymbol: "FLOW")

    let resetTx = Test.Transaction(
        code:        Test.readFile("helpers/admin_reset.cdc"),
        authorizers: [deployer.address],
        signers:     [deployer],
        arguments:   []
    )
    Test.expect(Test.executeTransaction(resetTx), Test.beSucceeded())

    // Record new tip — should get ID 1
    recordTip(sender: carol, recipient: bob.address, tokenContract: TOKEN_MUSDC, tokenSymbol: "mUSDC")
    Test.assertEqual(1 as UInt64, getTotalTips())
    Test.assert(getTip(tipID: 1) != nil, message: "first tip post-reset should be ID 1")
}
