/// Returns the registered JanusToken BabyJubJub pubkey for a given user's COA EVM address.
///
/// Queries the JanusToken contract on Flow EVM via EVM.dryCall to read the pubkey
/// mapping for the given COA address. The pubkey is a single BabyJubJub curve point
/// registered off-chain via JanusToken.registerPubkey.
///
/// Returns a dictionary with keys {x, y} representing the public key point coordinates.
/// Returns an empty dictionary if the user has not registered a pubkey.
///
/// @param coaEVMAddrHex: The user's COA EVM address as a hex string (with or without 0x prefix)
///                       e.g. "0x1234..." or "1234..."
/// @return A dictionary {String: UInt256} with the pubkey point coordinates, or empty if unregistered.
///
import "EVM"

access(all) fun main(coaEVMAddrHex: String): {String: UInt256} {
    // JanusToken on Flow EVM (v0.2.0 ceremony-backed testnet deployment).
    let janusTokenAddr: String = "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499"
    // Resolve the JanusToken EVM address and the user's COA EVM address.
    let janusToken = EVM.addressFromString(janusTokenAddr)
    let coaAddress = EVM.addressFromString(coaEVMAddrHex)

    // Build calldata for the pubkeys mapping getter.
    // Solidity: mapping(address => Point) public pubkeys;
    // Point is (uint256 x, uint256 y)
    // ABI signature: pubkeys(address) returns (uint256, uint256)
    let calldata = EVM.encodeABIWithSignature(
        "pubkeys(address)",
        [coaAddress]
    )

    // Dry-call the JanusToken contract — pure read, no state change.
    let result = EVM.dryCall(
        from: EVM.addressFromString("0x0000000000000000000000000000000000000000"),
        to: janusToken,
        data: calldata,
        gasLimit: 100_000,
        value: EVM.Balance(attoflow: 0)
    )

    if result.status != EVM.Status.successful {
        // If the call failed (e.g. address not found), return empty dict.
        return {}
    }

    // Decode the returned data as two uint256 values: (x, y).
    let decoded = EVM.decodeABI(
        types: [Type<UInt256>(), Type<UInt256>()],
        data: result.data
    )

    if decoded.length < 2 {
        return {}
    }

    // decoded[0] is x (AnyStruct), decoded[1] is y (AnyStruct).
    // Use unsafeDowncast via force-cast through UInt256.
    let x = (decoded[0] as! UInt256)
    let y = (decoded[1] as! UInt256)

    // If both coordinates are zero, the pubkey is not registered.
    if x == UInt256(0) && y == UInt256(0) {
        return {}
    }

    return {
        "x": x,
        "y": y
    }
}
