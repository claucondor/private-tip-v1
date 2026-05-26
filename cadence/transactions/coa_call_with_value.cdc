/// Generic COA call to EVM with pre-encoded calldata and FLOW value.
///
/// Use when the EVM function is payable (msg.value > 0).
/// Calldata is pre-ABI-encoded off-chain (using ethers.js) and passed as a hex string.
/// This avoids Cadence's EVM.encodeABIWithSignature limitations with fixed-size arrays.
///
/// @param contractAddress  EVM contract address (e.g., "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499")
/// @param calldataHex      Hex-encoded calldata WITHOUT 0x prefix
/// @param gasLimit         Gas limit for the EVM call
/// @param flowAmount       FLOW amount to send as msg.value (UFix64)

import "EVM"
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    contractAddress: String,
    calldataHex: String,
    gasLimit: UInt64,
    flowAmount: UFix64
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm for ".concat(signer.address.toString()))

        // Withdraw FLOW and deposit into COA for msg.value
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault")

        let wrapVault <- flowVault.withdraw(amount: flowAmount) as! @FlowToken.Vault
        coa.deposit(from: <-wrapVault)

        // Compute attoflow for msg.value
        // UFix64 has 8 decimal places; attoflow has 18 decimal places
        // attoflow = UFix64_units * 10^10
        let flowUnits = UInt64(flowAmount * 100_000_000.0)
        let attoflow: UInt = UInt(flowUnits) * 10_000_000_000

        let calldata: [UInt8] = calldataHex.decodeHex()

        let result = coa.call(
            to: EVM.addressFromString(contractAddress),
            data: calldata,
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: attoflow)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM call with value failed: errorCode="
                .concat(result.errorCode.toString())
                .concat(" msg=").concat(result.errorMessage)
        )
    }
}
