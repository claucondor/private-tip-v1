import "EVM"

access(all) fun main(flowAddress: Address): UInt? {
    if let coa = getAccount(flowAddress).capabilities
        .borrow<&EVM.CadenceOwnedAccount>(/public/evm) {
        return coa.address().balance().inAttoFLOW()
    }
    return nil
}
