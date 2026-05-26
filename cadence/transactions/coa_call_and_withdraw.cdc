/// COA call to EVM, then withdraw all received FLOW back to Cadence FlowToken vault.
///
/// Use for unwrap-style operations where the EVM contract sends FLOW to the COA.
/// Steps:
///   1. Calls the EVM function (pre-encoded calldata as hex)
///   2. After successful EVM call, withdraws ALL COA native balance back to Cadence
///
/// @param contractAddress  EVM contract address
/// @param calldataHex      Hex-encoded calldata WITHOUT 0x prefix
/// @param gasLimit         Gas limit

import "EVM"
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    contractAddress: String,
    calldataHex: String,
    gasLimit: UInt64
) {
    prepare(signer: auth(BorrowValue) &Account) {
        // Borrow COA with both Call and Withdraw entitlements
        let coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm for ".concat(signer.address.toString()))

        let receiver = signer.capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("No FlowToken.Receiver")

        let calldata: [UInt8] = calldataHex.decodeHex()

        // Record COA balance BEFORE the EVM call
        let balanceBefore = coa.balance().attoflow

        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldata,
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM call failed: errorCode="
                .concat(result.errorCode.toString())
                .concat(" msg=").concat(result.errorMessage)
        )

        // Withdraw ALL COA balance (original + received from EVM call)
        let balanceAfter = coa.balance().attoflow
        // Minimum withdrawable amount is 1e10 attoflow (Cadence/EVM bridge requirement)
        // UFix64 has 8 decimal places; 1e10 attoflow = 0.00000001 FLOW (minimum representable)
        let MIN_ATTOFLOW: UInt = 10_000_000_000
        if balanceAfter < MIN_ATTOFLOW {
            // Balance too small to withdraw (below 1e10 attoflow minimum) — skip
            return
        }

        let withdrawBal = EVM.Balance(attoflow: balanceAfter)
        let vault <- coa.withdraw(balance: withdrawBal)
        receiver.deposit(from: <-vault)
    }
}
