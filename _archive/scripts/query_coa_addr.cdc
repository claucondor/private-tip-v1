import EVM from 0x8c5303eaa26202d6

access(all) fun main(addr: Address): String? {
    let acct = getAccount(addr)
    if let cap = acct.capabilities.get<&EVM.CadenceOwnedAccount>(/public/evm) {
        let coa = cap.borrow()!
        return coa.address().toString()
    }
    return nil
}
