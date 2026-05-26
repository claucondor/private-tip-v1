/// Generic COA call to EVM with pre-encoded calldata (no FLOW value).
///
/// Use for view-like or state-changing EVM calls that don't require msg.value.
/// Calldata is pre-ABI-encoded off-chain (using ethers.js) and passed as a hex string.
///
/// @param contractAddress  EVM contract address (e.g., "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499")
/// @param calldataHex      Hex-encoded calldata WITHOUT 0x prefix
/// @param gasLimit         Gas limit for the EVM call

import "EVM"

transaction(
    contractAddress: String,
    calldataHex: String,
    gasLimit: UInt64
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm for ".concat(signer.address.toString()))

        let calldata: [UInt8] = calldataHex.decodeHex()

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
    }
}
