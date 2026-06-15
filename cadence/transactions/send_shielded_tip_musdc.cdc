/// send_shielded_tip_musdc.cdc — Send an mUSDC-backed shielded tip.
///
/// Atomically submits a JanusERC20.shieldedTransfer EVM call and records
/// tip metadata in PrivateTip. Both succeed or both revert.
///
/// Privacy: amount and memo are encrypted in the ECIES note delivered to the
/// recipient's ShieldedInbox. Only sender/recipient/token are publicly recorded.
///
/// Steps (all atomic in one Cadence transaction):
///   1. COA calls JanusERC20.shieldedTransfer via EVM (commits ZK proof + deposits inbox note)
///   2. PrivateTip.recordTip stores public metadata
///
/// Parameters (all built off-chain by SDK using JanusERC20Adapter):
///   recipient    Cadence address of the tip recipient (must have ShieldedInbox installed)
///   evmCalldata  Hex-encoded calldata for JanusERC20.shieldedTransfer(...)
///                Format: 0x<selector><abi-encoded args>
///   gasLimit     EVM gas limit for the JanusERC20 call (500_000 recommended)
///
/// Prerequisite: sender must have previously approved MockUSDC spend by JanusERC20
/// and wrapped mUSDC into the shielded pool (SDK: JanusERC20Adapter.wrap()).
///
/// JanusERC20 proxy (testnet): 0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d
/// MockUSDC (testnet):         0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524

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
        ) ?? panic("send_shielded_tip_musdc: no COA at /storage/evm — run setup_coa first")

        self.senderRef = signer
    }

    execute {
        // ── 1. Submit JanusERC20.shieldedTransfer via COA ───────────────────────
        // JanusERC20 proxy EVM address (testnet). Underlying token is MockUSDC.
        let janusErc20Proxy = EVM.addressFromString("FD8F82bE1782AF1F85f4673065e94fb3F8D5387d")
        let result = self.coa.call(
            to:       janusErc20Proxy,
            data:     evmCalldata.decodeHex(),
            gasLimit: gasLimit,
            value:    EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "send_shielded_tip_musdc: JanusERC20.shieldedTransfer reverted — "
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
            tokenContract: "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
            tokenSymbol:   "mUSDC"
        )
    }
}
