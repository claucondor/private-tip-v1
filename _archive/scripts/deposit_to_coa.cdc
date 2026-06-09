import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

transaction(amount: UFix64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let vault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault")
        let coa = signer.storage.borrow<&EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm")
        let funds <- vault.withdraw(amount: amount) as! @FlowToken.Vault
        coa.deposit(from: <-funds)
    }
}
