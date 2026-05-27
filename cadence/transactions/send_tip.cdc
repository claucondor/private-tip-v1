/// Sends a tip via the PrivateTip router.
///
/// The router holds the FLOW in custody until the recipient claims it.
/// The sender's authority is proven by the signer auth-ref passed to sendTip.
///
/// PRIVACY NOTE: This is the L3 native-FLOW path. For confidential-amount tipping
/// use the JanusFlow router + JanusToken pair (L2 path). This contract is the
/// simpler "named tips" UX layer where the amount is intentionally on-chain.
///
/// @param recipient  Flow address of the intended recipient
/// @param amount     Tip amount in FLOW (UFix64)
/// @param memo       Optional public memo (empty string = nil; max 280 chars)
///
import PrivateTip from "./../contracts/PrivateTip.cdc"
import "FungibleToken"
import "FlowToken"

transaction(recipient: Address, amount: UFix64, memo: String) {

    let payment: @FlowToken.Vault
    let senderRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        // Withdraw the tip amount from the sender's FlowToken vault.
        let vaultRef = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic(
            "Could not borrow FlowToken.Vault for signer ".concat(signer.address.toString())
        )
        self.payment <- (vaultRef.withdraw(amount: amount) as! @FlowToken.Vault)
        self.senderRef = signer
    }

    execute {
        let memoOpt: String? = memo.length > 0 ? memo : nil
        let tipID = PrivateTip.sendTip(
            sender: self.senderRef,
            recipient: recipient,
            payment: <- self.payment,
            memo: memoOpt
        )
        log("PrivateTip.sendTip created tipID=".concat(tipID.toString()))
    }
}
