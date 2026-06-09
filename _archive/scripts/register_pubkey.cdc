import EVM from 0x8c5303eaa26202d6

/// Registers a BabyJubJub pubkey on JanusToken by calling
/// JanusToken.registerPubkey(uint256 pkx, uint256 pky) via the signer's COA.
transaction(pkx: UInt256, pky: UInt256) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA")
        
        let janusToken = EVM.addressFromString("0xb12E600fFcde967210cFD81CF9f32bBB6e68a499")
        let calldata = EVM.encodeABIWithSignature(
            "registerPubkey(uint256,uint256)",
            [EVM.addressFromString("0x")(), EVM.addressFromString("0x")()]
        )
        
        // Build registerPubkey calldata manually
        let pkxHex = pkx.toString(encoding: .hex)
        let pkyHex = pky.toString(encoding: .hex)
        let selector = "4339cf2f" // keccak256("registerPubkey(uint256,uint256)")[0:4]
        
        // ABI encode: 32-byte padded pkx + 32-byte padded pky
        let abiEncoded = selector
            .concat(pkx.toString(encoding: .hex).padLeft(64, padding: "0"))
            .concat(pky.toString(encoding: .hex).padLeft(64, padding: "0"))
        
        let result = coa.call(
            to: janusToken,
            data: EVM.decodeABI(types: [Type<[UInt8]>()], data: abiEncoded)[0] as! [UInt8],
            gasLimit: 300000,
            value: EVM.Balance(attoflow: 0)
        )
        
        if result.status != EVM.Status.successful {
            panic("EVM call failed: ".concat(result.errorMessage))
        }
    }
}
