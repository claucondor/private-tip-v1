/// Wraps FLOW into a confidential ciphertext for a recipient's slot on JanusToken.
///
/// The caller:
/// 1. Withdraws FLOW from their FlowToken vault
/// 2. Deposits it into their COA (Cadence → EVM bridge)
/// 3. Calls JanusToken.wrap() via COA with msg.value = the wrapped amount
///
/// JanusToken.wrap() requires:
///   - A valid ZK encrypt_consistency proof
///   - The ciphertext encrypted to the RECIPIENT's registered BabyJubJub pubkey
///   - A nonce matching the sender's current nonce[msg.sender] on JanusToken
///
/// Function signature:
///   wrap(address to, (uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct,
///        uint256 senderNonce, uint256[6] publicInputs, uint256[8] encryptProof)
///
/// @param recipientEVMAddr  Recipient's COA EVM address (padded to 40 hex chars)
/// @param amount            FLOW amount to wrap (UFix64)
/// @param C1x, C1y         ElGamal ciphertext component C1 = r*G
/// @param C2x, C2y         ElGamal ciphertext component C2 = v*G + r*PK
/// @param senderNonce       Sender's current nonce on JanusToken (nonce[msg.sender])
/// @param publicInputs      6-element array: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y]
/// @param encryptProof      8-element Groth16 proof: [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]

import "EVM"
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    recipientEVMAddr: String,
    amount: UFix64,
    C1x: UInt256,
    C1y: UInt256,
    C2x: UInt256,
    C2y: UInt256,
    senderNonce: UInt256,
    publicInputs: [UInt256],
    encryptProof: [UInt256]
) {
    let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        // Validate array lengths
        if publicInputs.length != 6 {
            panic("publicInputs must have exactly 6 elements, got ".concat(publicInputs.length.toString()))
        }
        if encryptProof.length != 8 {
            panic("encryptProof must have exactly 8 elements, got ".concat(encryptProof.length.toString()))
        }

        // Borrow COA
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm for ".concat(signer.address.toString()))

        // Withdraw FLOW from vault and deposit into COA
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault")
        let wrapVault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
        self.coa.deposit(from: <-wrapVault)

        // Compute attoflow for msg.value
        // UFix64 has 8 decimal places, attoflow has 18 decimal places
        // attoflow = UFix64_amount * 10^10
        let flowUnits = UInt64(amount * 100_000_000.0)
        let attoflow: UInt = UInt(flowUnits) * 10_000_000_000

        // Build wrap() calldata
        // Signature: wrap(address to, (uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct,
        //                 uint256 senderNonce, uint256[6] publicInputs, uint256[8] encryptProof)
        let recipientEVM = EVM.addressFromString(recipientEVMAddr)
        let calldata = EVM.encodeABIWithSignature(
            "wrap(address,(uint256,uint256,uint256,uint256),uint256,uint256[6],uint256[8])",
            [recipientEVM, [C1x, C1y, C2x, C2y], senderNonce, publicInputs, encryptProof]
        )

        // Call wrap() with msg.value
        let result = self.coa.call(
            to: EVM.addressFromString("0xb12E600fFcde967210cFD81CF9f32bBB6e68a499"),
            data: calldata,
            gasLimit: 700_000,
            value: EVM.Balance(attoflow: attoflow)
        )

        if result.status != EVM.Status.successful {
            let errMsg = "JanusToken.wrap() failed: errorCode="
                .concat(result.errorCode.toString())
                .concat(" msg=")
                .concat(result.errorMessage)
            panic(errMsg)
        }
    }
}
