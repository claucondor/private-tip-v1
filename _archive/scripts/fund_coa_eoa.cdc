import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

/// Funds a specific EVM address by bridging FLOW from the signer's vault
/// to the target EVM address (not the signer's COA, but the target EOA).
transaction(amount: UFix64, targetEVMAddrHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let vault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault")
        let coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm")
        let funds <- vault.withdraw(amount: amount) as! @FlowToken.Vault
        
        // Deposit to the signer's own COA first
        coa.deposit(from: <-funds)
        
        // Then transfer from COA to the target EVM address
        let targetAddr = EVM.addressFromString(targetEVMAddrHex)
        coa.transfer(to: targetAddr, value: EVM.Balance(attoflow: UInt(amount)))
    }
}
