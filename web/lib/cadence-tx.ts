/**
 * Cross-VM transactions that publish state to BOTH Cadence storage AND EVM via COA.
 * These run from FCL with a single Flow Wallet signature — NO ethers.BrowserProvider,
 * NO MetaMask, NO Rainbow, NO window.ethereum.
 */

import { MEMO_REGISTRY_ADDRESS, SHIELDED_CHECKPOINT_ADDRESS, SHIELDED_INBOX_ADDRESS, TOKEN_REGISTRY } from "@claucondor/sdk/network";

const CADENCE_DEPLOYER = "0x4b6bc58bc8bf5dcc";    // v0.8 openjanus-v08 (JanusFT, MockFT, PrivateTip, ShieldedInbox, ShieldedCheckpoint)
const JANUSFLOW_CADENCE = "0x5dcbeb41055ec57e";   // v0.8 JanusFlow Cadence (NOT same as CADENCE_DEPLOYER)
const EVM_SYSTEM_CONTRACT = "0x8c5303eaa26202d6"; // testnet EVM system contract
const JANUS_FLOW_EVM_PROXY = TOKEN_REGISTRY.flow.proxy;   // "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3"
const SHIELDED_INBOX_EVM   = SHIELDED_INBOX_ADDRESS;      // "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6"

/**
 * Publish the user's BabyJub memokey to both Cadence storage and the shared EVM
 * MemoKeyRegistry. Covers ALL four Janus token adapters in a single tx.
 *
 * Caller must have a COA at /storage/evm.
 * Args: memoPubX (UInt256), memoPubY (UInt256)
 *
 * After this tx the user's memo key is available from:
 *   - Cadence storage (/storage/openjanusMemoKey) — JanusFT + future Cadence tokens
 *   - EVM MemoKeyRegistry (${MEMO_REGISTRY_ADDRESS}) — JanusFlow, JanusERC20 proxies
 */
export const TX_PUBLISH_MEMOKEY_XVM = `
import JanusFT from ${CADENCE_DEPLOYER}
import JanusFlow from ${JANUSFLOW_CADENCE}
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(memoPubX: UInt256, memoPubY: UInt256) {
    prepare(signer: auth(BorrowValue, Storage, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

        // ----------------------------------------------------------------
        // 1. Publish to Cadence storage path.
        //    JanusFT.publishMemoKey writes to /storage/openjanusMemoKey
        //    (shared with JanusFlow.MemoKey resource — one path, all Cadence tokens).
        // ----------------------------------------------------------------
        JanusFT.publishMemoKey(
            account: signer,
            pubkeyX: memoPubX,
            pubkeyY: memoPubY
        )

        // ----------------------------------------------------------------
        // 2. Publish to EVM MemoKeyRegistry via COA cross-VM call.
        //    msg.sender in the EVM call is the user's COA address, which is
        //    the identity used by the EVM Janus token adapters.
        // ----------------------------------------------------------------
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")

        let memoRegistryAddr = EVM.addressFromString("${MEMO_REGISTRY_ADDRESS}")

        // ABI-encode: publishMemoKey(uint256,uint256)
        // selector = keccak256("publishMemoKey(uint256,uint256)")[0:4] = 0xe50a8aad
        let calldata = EVM.encodeABIWithSignature(
            "publishMemoKey(uint256,uint256)",
            [memoPubX, memoPubY]
        )

        let result = coa.call(
            to: memoRegistryAddr,
            data: calldata,
            gasLimit: 100000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
        )
    }
}
`;

/**
 * Update the user's ShieldedCheckpoint via COA. Local override of the SDK
 * template — same logic but `gasLimit: 1_500_000` instead of 200_000, because
 * the SDK default is insufficient for the `update(bytes,uint256,uint256,uint64)`
 * EVM call (the encryptedSnapshot bytes pushes the cost above 200k).
 *
 * Will be folded back into the SDK in the next bump.
 */
export const TX_UPDATE_CHECKPOINT_VIA_COA = `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  encryptedSnapshot:     [UInt8],
  ephPubkeyX:            UInt256,
  ephPubkeyY:            UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("update_checkpoint_via_coa: no COA at /storage/evm — run setup_coa first")
  }

  execute {
    let checkpointAddr = EVM.addressFromString("${SHIELDED_CHECKPOINT_ADDRESS}")

    let calldata = EVM.encodeABIWithSignature(
      "update(bytes,uint256,uint256,uint64)",
      [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )

    let result = self.coa.call(
      to:       checkpointAddr,
      data:     calldata,
      gasLimit: 1500000,
      value:    EVM.Balance(attoflow: 0)
    )

    assert(
      result.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(result.errorMessage)
    )
  }
}
`;

/**
 * Atomic wrap for FLOW native — moves FLOW to COA, calls JanusFlow.wrapWithProof
 * (via pre-encoded hex calldata) and ShieldedCheckpoint.update in a single FCL tx.
 *
 * All proof data is pre-encoded client-side; the Cadence tx simply relays the
 * hex calldata to the EVM proxy via COA. Because it must borrow the FlowToken
 * vault, all logic lives in the prepare block (not execute).
 *
 * Args:
 *   amountUFix64        UFix64   — gross FLOW amount, e.g. "1.00000000"
 *   attoflowWei         UInt     — same amount in attoflow (wei)
 *   wrapCalldataHex     String   — ABI-encoded wrapWithProof calldata, no 0x prefix
 *   encryptedSnapshot   [UInt8]  — cumulative checkpoint ciphertext
 *   ephPubkeyX          UInt256
 *   ephPubkeyY          UInt256
 *   lastConsumedNoteIndex UInt64
 */
export const TX_WRAP_FLOW_ATOMIC = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  amountUFix64: UFix64,
  attoflowWei: UInt,
  wrapCalldataHex: String,
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("wrap_flow_atomic: no COA at /storage/evm — run setup_coa first")

    let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
      from: /storage/flowTokenVault
    ) ?? panic("wrap_flow_atomic: no FlowToken vault")

    // Move FLOW from Cadence vault to COA EVM balance
    let payment <- flowVault.withdraw(amount: amountUFix64) as! @FlowToken.Vault
    coa.deposit(from: <-payment)

    // Call JanusFlow.wrapWithProof via pre-encoded calldata (complex ABI, pre-encoded client-side)
    let wrapResult = coa.call(
      to: EVM.addressFromString("${JANUS_FLOW_EVM_PROXY}"),
      data: wrapCalldataHex.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: attoflowWei)
    )
    assert(
      wrapResult.status == EVM.Status.successful,
      message: "JanusFlow.wrapWithProof reverted: ".concat(wrapResult.errorMessage)
    )

    // Update ShieldedCheckpoint in the same tx (atomic — no second wallet popup)
    let checkpointAddr = EVM.addressFromString("${SHIELDED_CHECKPOINT_ADDRESS}")
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(bytes,uint256,uint256,uint64)",
      [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = coa.call(
      to: checkpointAddr,
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;

/**
 * Atomic send-tip for FLOW native — shieldedTransfer (via pre-encoded hex calldata)
 * and ShieldedCheckpoint.update in a single FCL tx.
 *
 * janusProxyHex is passed as an arg (not baked in) so this template can be reused
 * for different EVM tokens if needed.
 *
 * Args:
 *   transferCalldataHex   String   — ABI-encoded shieldedTransfer calldata, no 0x prefix
 *   janusProxyHex         String   — JanusFlow proxy EVM address (hex, with 0x)
 *   encryptedSnapshot     [UInt8]  — sender's residual checkpoint ciphertext
 *   ephPubkeyX            UInt256
 *   ephPubkeyY            UInt256
 *   lastConsumedNoteIndex UInt64
 */
export const TX_SEND_TIP_ATOMIC = `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  transferCalldataHex: String,
  janusProxyHex: String,
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("send_tip_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusFlow.shieldedTransfer via pre-encoded calldata
    let janusAddr = EVM.addressFromString(janusProxyHex)
    let transferResult = self.coa.call(
      to: janusAddr,
      data: transferCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      transferResult.status == EVM.Status.successful,
      message: "JanusFlow.shieldedTransfer reverted: ".concat(transferResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as transfer)
    let checkpointAddr = EVM.addressFromString("${SHIELDED_CHECKPOINT_ADDRESS}")
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(bytes,uint256,uint256,uint64)",
      [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: checkpointAddr,
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;

/**
 * Atomic unwrap for FLOW native — JanusFlow.unwrap (via pre-encoded hex calldata)
 * and ShieldedCheckpoint.update in a single FCL tx.
 *
 * Args:
 *   unwrapCalldataHex     String   — ABI-encoded unwrap calldata, no 0x prefix
 *   encryptedSnapshot     [UInt8]  — residual checkpoint ciphertext
 *   ephPubkeyX            UInt256
 *   ephPubkeyY            UInt256
 *   lastConsumedNoteIndex UInt64
 */
export const TX_UNWRAP_FLOW_ATOMIC = `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  unwrapCalldataHex: String,
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("unwrap_flow_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusFlow.unwrap via pre-encoded calldata
    let janusAddr = EVM.addressFromString("${JANUS_FLOW_EVM_PROXY}")
    let unwrapResult = self.coa.call(
      to: janusAddr,
      data: unwrapCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      unwrapResult.status == EVM.Status.successful,
      message: "JanusFlow.unwrap reverted: ".concat(unwrapResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as unwrap)
    let checkpointAddr = EVM.addressFromString("${SHIELDED_CHECKPOINT_ADDRESS}")
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(bytes,uint256,uint256,uint64)",
      [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: checkpointAddr,
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;

/**
 * Atomic batch-claim — drainAll + claimBatch + ShieldedCheckpoint.update in a
 * single FCL tx. Replaces the 3-sequential-tx pattern in BatchClaimCTA.
 *
 * drainAll is non-fatal (inbox may be concurrently drained by another tx).
 * claimBatch and ShieldedCheckpoint.update assert success.
 *
 * Args:
 *   publicInputs          [UInt256] — claimBatch public inputs (6 elements)
 *   proof                 [UInt256] — claimBatch proof (8 elements)
 *   encryptedSnapshot     [UInt8]   — new consolidated checkpoint ciphertext
 *   ephPubkeyX            UInt256
 *   ephPubkeyY            UInt256
 *   lastConsumedNoteIndex UInt64
 */
export const TX_CLAIM_BATCH_ATOMIC = `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  publicInputs: [UInt256],
  proof: [UInt256],
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("claim_batch_atomic: no COA at /storage/evm — activate first")
  }

  execute {
    // 1. drainAll from ShieldedInbox (non-fatal — inbox may already be empty)
    let inboxAddr = EVM.addressFromString("${SHIELDED_INBOX_EVM}")
    let drainCalldata = EVM.encodeABIWithSignature("drainAll()", [])
    let _ = self.coa.call(
      to: inboxAddr,
      data: drainCalldata,
      gasLimit: 400000,
      value: EVM.Balance(attoflow: 0)
    )

    // 2. JanusToken.claimBatch (assert success)
    let janusAddr = EVM.addressFromString("${JANUS_FLOW_EVM_PROXY}")
    let claimCalldata = EVM.encodeABIWithSignature(
      "claimBatch(uint256[6],uint256[8])",
      [publicInputs, proof]
    )
    let claimResult = self.coa.call(
      to: janusAddr,
      data: claimCalldata,
      gasLimit: 600000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      claimResult.status == EVM.Status.successful,
      message: "JanusToken.claimBatch failed: ".concat(claimResult.errorMessage)
    )

    // 3. ShieldedCheckpoint.update (assert success)
    let checkpointAddr = EVM.addressFromString("${SHIELDED_CHECKPOINT_ADDRESS}")
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(bytes,uint256,uint256,uint64)",
      [encryptedSnapshot, ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: checkpointAddr,
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;

/**
 * Atomic account activation — publishMemoKey (Cadence + EVM) + install ShieldedInbox
 * + ShieldedCheckpoint in a single FCL tx. Replaces the 2-sequential-tx pattern in
 * activateAccount().
 *
 * All operations are idempotent at the contract level (re-publishing same key is a
 * harmless overwrite; resource installation checks before creating).
 *
 * Args: memoPubX (UInt256), memoPubY (UInt256)
 */
export const TX_ACTIVATE_ACCOUNT_ATOMIC = `
import JanusFT from ${CADENCE_DEPLOYER}
import JanusFlow from ${JANUSFLOW_CADENCE}
import ShieldedInbox from ${CADENCE_DEPLOYER}
import ShieldedCheckpoint from ${CADENCE_DEPLOYER}
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(memoPubX: UInt256, memoPubY: UInt256) {
  prepare(signer: auth(BorrowValue, Storage, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

    // ── 1. Publish MemoKey to Cadence storage ──────────────────────────────────
    JanusFT.publishMemoKey(
      account: signer,
      pubkeyX: memoPubX,
      pubkeyY: memoPubY
    )

    // ── 2. Publish MemoKey to EVM MemoKeyRegistry via COA ─────────────────────
    let coa = signer.storage
      .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("activate_account_atomic: no COA at /storage/evm")

    let memoRegistryAddr = EVM.addressFromString("${MEMO_REGISTRY_ADDRESS}")

    let memoCalldata = EVM.encodeABIWithSignature(
      "publishMemoKey(uint256,uint256)",
      [memoPubX, memoPubY]
    )

    let memoResult = coa.call(
      to: memoRegistryAddr,
      data: memoCalldata,
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )

    assert(
      memoResult.status == EVM.Status.successful,
      message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
        .concat(memoResult.errorCode.toString())
        .concat(" ")
        .concat(memoResult.errorMessage)
    )

    // ── NoteInbox ──────────────────────────────────────────────────────────────
    let inboxStoragePath = /storage/shieldedInbox
    let inboxPublicPath  = /public/shieldedInbox

    let inboxType = signer.storage.type(at: inboxStoragePath)
    if inboxType != Type<@ShieldedInbox.NoteInbox>() {
      if inboxType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: inboxStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale inbox resource vanished")
        destroy stale
      }
      let inbox <- ShieldedInbox.createInbox(owner: signer.address)
      signer.storage.save(<- inbox, to: inboxStoragePath)
    }
    signer.capabilities.unpublish(inboxPublicPath)
    let inboxCap = signer.capabilities.storage.issue<&{ShieldedInbox.Receiver}>(inboxStoragePath)
    signer.capabilities.publish(inboxCap, at: inboxPublicPath)

    // ── Checkpoint ──────────────────────────────────────────────────────────────
    let cpStoragePath = /storage/shieldedCheckpoint
    let cpPublicPath  = /public/shieldedCheckpoint

    let cpType = signer.storage.type(at: cpStoragePath)
    if cpType != Type<@ShieldedCheckpoint.Checkpoint>() {
      if cpType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: cpStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale checkpoint resource vanished")
        destroy stale
      }
      let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
      signer.storage.save(<- cp, to: cpStoragePath)
    }
    signer.capabilities.unpublish(cpPublicPath)
    let cpCap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(cpStoragePath)
    signer.capabilities.publish(cpCap, at: cpPublicPath)
  }
}
`;
