/// Register a BabyJubJub pubkey on the JanusFlow Cadence router (which proxies
/// to JanusToken EVM proxy at 0x025efe7e89acdb8F315C804BE7245F348AA9c538).
///
/// @param pubkey       64-byte BabyJubJub public key (x || y, big-endian 32B each)
/// @param calldataHex  ABI-encoded calldata for JanusToken.registerPubkey(uint256,uint256)
import JanusFlow from 0x5dcbeb41055ec57e

transaction(pubkey: [UInt8], calldataHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.registerPubkey(
            signer: signer,
            pubkey: pubkey,
            calldataHex: calldataHex
        )
    }
}
