/// send_shielded_tip_flow.cdc — Send a FLOW-backed shielded tip.
///
/// Atomically submits a JanusFlow.shieldedTransfer EVM call and records
/// tip metadata in PrivateTip. Both succeed or both revert.
///
/// Privacy: amount and memo are encrypted in the ECIES note delivered to the
/// recipient's ShieldedInbox. Only sender/recipient/token are publicly recorded.
///
/// Steps (all atomic in one Cadence transaction):
///   1. COA calls JanusFlow.shieldedTransfer via EVM (commits ZK proof + deposits inbox note)
///   2. PrivateTip.recordTip stores public metadata
///
/// Parameters (all built off-chain by SDK using JanusFlowAdapter):
///   recipient    Cadence address of the tip recipient (must have ShieldedInbox installed)
///   evmCalldata  Hex-encoded calldata for JanusFlow.shieldedTransfer(...)
///                Format: 0x<selector><abi-encoded args>
///   gasLimit     EVM gas limit for the JanusFlow call (500_000 recommended)
///
/// JanusFlow proxy (testnet): 0xA64340C1d356835A2450306Ffd290Ed52c001Ad3

import "PrivateTip"
import "EVM"

transaction(
    recipient:   Address,
    evmCalldata: String,
    gasLimit:    UInt64
) {
    let coa:       auth(EVM.Call) &EVM.CadenceOwnedAccount
    let senderRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("send_shielded_tip_flow: no COA at /storage/evm — run setup_coa first")

        self.senderRef = signer
    }

    execute {
        // ── 1. Submit JanusFlow.shieldedTransfer via COA ────────────────────────
        // JanusFlow proxy EVM address (testnet). COA call auto-delivers inbox note
        // to recipient's ShieldedInbox (EVM-side Inbox at shieldedTransfer completion).
        let janusFlowProxy = EVM.addressFromString("A64340C1d356835A2450306Ffd290Ed52c001Ad3")
        let result = self.coa.call(
            to:       janusFlowProxy,
            data:     evmCalldata.decodeHex(),
            gasLimit: gasLimit,
            value:    EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "send_shielded_tip_flow: JanusFlow.shieldedTransfer reverted — "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
                .concat(" data: 0x")
                .concat(String.encodeHex(result.data))
        )

        // ── 2. Record tip metadata (atomic with step 1) ────────────────────────
        PrivateTip.recordTip(
            sender:        self.senderRef,
            recipient:     recipient,
            tokenContract: "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
            tokenSymbol:   "FLOW"
        )
    }
}
