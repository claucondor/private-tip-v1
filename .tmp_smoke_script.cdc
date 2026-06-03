
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

access(all) fun main(addr: Address): UFix64 {
    let acct = getAccount(addr)
    let vault = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
        ?? panic("no FlowToken balance cap")
    return vault.balance
}
