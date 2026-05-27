/// Unwraps confidential FLOW from JanusToken back to the signer's FlowToken vault.
///
/// The caller:
/// 1. Proves knowledge of the decryption (via ZK decrypt_open proof)
/// 2. Calls JanusToken.unwrap() via COA — FLOW sent to recipient EVM address
/// 3. Withdraws the received FLOW from COA back to Cadence FlowToken vault
///
/// JanusToken.unwrap() requires:
///   - A valid ZK decrypt_open proof
///   - publicInputs[6] == amount (the claimed total)
///   - The proof must match caller's registered pubkey and current slot
///
/// Function signature:
///   unwrap(uint256 amount, address recipient, uint256[7] publicInputs, uint256[8] decryptProof)
///
/// @param amount         Total attoflow to unwrap (must match decrypt proof's claimed_value)
/// @param publicInputs   7-element array: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y, claimed_value]
/// @param decryptProof   8-element Groth16 proof: [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]

import "EVM"
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UInt256,
    publicInputs: [UInt256],
    decryptProof: [UInt256]
) {
    let coa: auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount
    let receiver: &{FungibleToken.Receiver}
    let coaAddress: EVM.EVMAddress

    prepare(signer: auth(BorrowValue) &Account) {
        // Validate array lengths
        if publicInputs.length != 7 {
            panic("publicInputs must have exactly 7 elements, got ".concat(publicInputs.length.toString()))
        }
        if decryptProof.length != 8 {
            panic("decryptProof must have exactly 8 elements, got ".concat(decryptProof.length.toString()))
        }

        // Borrow COA with Call + Withdraw entitlements
        self.coa = signer.storage.borrow<auth(EVM.Call, EVM.Withdraw) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm for ".concat(signer.address.toString()))

        self.coaAddress = self.coa.address()

        // Borrow FlowToken receiver to deposit withdrawn FLOW
        self.receiver = signer.capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("No FlowToken.Receiver")

        // Build unwrap() calldata
        // Signature: unwrap(uint256 amount, address recipient, uint256[7] publicInputs, uint256[8] decryptProof)
        let calldata = EVM.encodeABIWithSignature(
            "unwrap(uint256,address,uint256[7],uint256[8])",
            [amount, self.coaAddress, publicInputs, decryptProof]
        )

        // Call unwrap() via COA (no msg.value needed — JanusToken releases its held FLOW)
        let result = self.coa.call(
            to: EVM.addressFromString("0xb12E600fFcde967210cFD81CF9f32bBB6e68a499"),
            data: calldata,
            gasLimit: 500_000,
            value: EVM.Balance(attoflow: 0)
        )

        if result.status != EVM.Status.successful {
            let errMsg = "JanusToken.unwrap() failed: errorCode="
                .concat(result.errorCode.toString())
                .concat(" msg=")
                .concat(result.errorMessage)
            panic(errMsg)
        }

        // After unwrap, the COA has received FLOW. Withdraw it back to Cadence.
        let coaBalance = self.coa.balance()
        let withdrawable: UInt = coaBalance.attoflow
        if withdrawable == 0 {
            // Unexpected: unwrap succeeded but no FLOW in COA?
            // This could happen if the COA had zero balance before AND the FLOW went elsewhere
            // Just return without withdrawing
            return
        }

        let withdrawBal = EVM.Balance(attoflow: withdrawable)
        let vault <- self.coa.withdraw(balance: withdrawBal)
        self.receiver.deposit(from: <-vault)
    }
}
