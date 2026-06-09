import EVM from 0x8c5303eaa26202d6

access(all) fun main(addr: Address): String {
    let acct = getAccount(addr)
    let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
        ?? panic("No COA")
    return coa.address().toString()
}
