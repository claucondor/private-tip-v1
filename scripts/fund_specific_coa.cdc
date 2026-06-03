import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

/// Funds a specific EVM address by bridging FLOW through the signer's COA.
/// The signer's Cadence vault is debited, deposited to signer's COA,
/// then the COA sends FLOW to the target EVM EOA address.
transaction(amount: UFix64, targetEVMAddrHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let vault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault")
        let coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA")
        
        let funds <- vault.withdraw(amount: amount) as! @FlowToken.Vault
        coa.deposit(from: <-funds)
        let targetAddr = EVM.addressFromString(targetEVMAddrHex)
        coa.transfer(to: targetAddr, value: EVM.Balance(attoflow: UInt(amount)))
    }
}
