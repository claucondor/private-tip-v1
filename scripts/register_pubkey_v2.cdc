import EVM from 0x8c5303eaa26202d6

/// Calls JanusToken.registerPubkey(uint256,uint256) via the signer's COA on Flow EVM.
transaction(pkx: UInt256, pky: UInt256) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm")
        
        let janusToken = EVM.addressFromString("0xb12E600fFcde967210cFD81CF9f32bBB6e68a499")
        
        let encoded = EVM.encodeABIWithSignature(
            "registerPubkey(uint256,uint256)",
            [pkx, pky]
        )
        
        let result = coa.call(
            to: janusToken,
            data: encoded,
            gasLimit: 500_000,
            value: EVM.Balance(attoflow: 0)
        )
        
        if result.status != EVM.Status.successful {
            let msg = "EVM call failed: code="
                .concat(result.errorCode.toString())
                .concat(" msg=")
                .concat(result.errorMessage)
            panic(msg)
        }
    }
}
