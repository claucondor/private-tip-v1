/// record_tip.cdc — Test helper: record a tip in PrivateTip.
/// Used by PrivateTip_test.cdc to call PrivateTip.recordTip atomically.

import "PrivateTip"

transaction(recipient: Address, tokenContract: String, tokenSymbol: String) {
    let senderRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderRef = signer
    }

    execute {
        PrivateTip.recordTip(
            sender:        self.senderRef,
            recipient:     recipient,
            tokenContract: tokenContract,
            tokenSymbol:   tokenSymbol
        )
    }
}
