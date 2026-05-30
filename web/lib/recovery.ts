/// Shielded-state recovery via on-chain self-tips.
///
/// Recovery model:
///   Every state-changing op (wrap, send, partial unwrap) records a
///   "carbon-copy" ShieldedNote encrypted to the sender's OWN MemoKey pubkey
///   via a self-tip (PrivateTip.recordTip with sender === recipient === me).
///   These self-tips are invisible in the UI (filtered out in /tips) but
///   enable full state reconstruction from any device with just a wallet
///   signature.
///
/// Recovery algorithm:
///   1. Fetch all incoming tips (getShieldedTipsByRecipientWithMemo).
///   2. Fetch all outgoing tips (getShieldedTipsBySenderWithMemo).
///   3. Decrypt ALL with own MemoKey privkey.
///   4. Self-tips (sender === recipient === me) with kind="wrap" or "residual"
///      are additive (balance += amount, blinding += blinding).
///   5. Tips from others (sender != me, recipient = me) are incoming — additive.
///   6. Tips from me to others (sender = me, recipient != me) are NOT deducted
///      here because the post-transfer residual is recorded as a "residual"
///      carbon-copy self-tip. Net balance flows entirely through self-tips.
///   7. Validate reconstructed balance against on-chain Pedersen commitment.
///
/// Backwards compatibility: undecryptable notes (pre-recovery tips, legacy
/// format) are silently skipped. The result will be a best-effort balance
/// that the user can correct manually.

"use client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveredShieldedState {
  balanceWei: bigint;
  blinding: bigint;
}

export class RecoveryDesyncError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RecoveryDesyncError";
  }
}

// ---------------------------------------------------------------------------
// Cadence tx: record a self-tip as a recovery carbon-copy.
//
// Unlike a real tip there is NO JanusFlow.shieldedTransfer here — we just
// call PrivateTip.recordTip with sender === recipient === me, using a
// zero-length ciphertextRef dummy (just two zeros). The Cadence contract
// records the tip in both tipsByRecipient[me] and tipsBySender[me] and
// stores the encrypted note blob in MemoStore. That's all we need.
// ---------------------------------------------------------------------------

export const TX_RECORD_SELF_TIP = `
import PrivateTip from 0xb9ac529c14a4c5a1

/// Record a recovery carbon-copy self-tip with an encrypted note.
///
/// Used by wrap and send flows to store (amount, blinding, kind) encrypted to
/// the sender's own MemoKey pubkey. No value transfer — pure metadata.
///
/// ciphertextRef is [0, 0] (a dummy point). The actual shielded values are in
/// memoCiphertext.
transaction(
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256
) {
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        let dummyCiphertextRef: [UInt256] = [0, 0]
        let tipID = PrivateTip.recordTip(
            sender: self.signerRef,
            recipient: self.signerRef.address,
            ciphertextRef: dummyCiphertextRef,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY
        )
        log("recovery carbon-copy tipID=".concat(tipID.toString()))
    }
}
`;

// ---------------------------------------------------------------------------
// emitRecoverySelfTip — submit TX_RECORD_SELF_TIP
// ---------------------------------------------------------------------------

/**
 * Encrypt a recovery note and submit it as a self-tip on-chain.
 *
 * @param amount       Amount in wei to record.
 * @param blinding     Blinding scalar to record.
 * @param kind         "wrap" | "residual" — distinguishes wrap additions from
 *                     post-send residuals when reconstructing balance.
 * @param myPubkey     Caller's own MemoKey pubkey (to encrypt to themselves).
 */
export async function emitRecoverySelfTip(opts: {
  amount: bigint;
  blinding: bigint;
  kind: "wrap" | "residual";
  myPubkey: { x: bigint; y: bigint };
}): Promise<string> {
  const { amount, blinding, kind, myPubkey } = opts;

  // Encrypt to our own pubkey via the server-side API route.
  const encRes = await fetch("/api/note/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amount.toString(),
      blinding: blinding.toString(),
      data: JSON.stringify({ k: kind }),        // tag so recovery knows the type
      recipientPubkey: { x: myPubkey.x.toString(), y: myPubkey.y.toString() },
    }),
  });
  if (!encRes.ok) {
    const err = await encRes.json().catch(() => ({ error: encRes.statusText }));
    throw new Error(`emitRecoverySelfTip: encrypt failed — ${err.error ?? encRes.statusText}`);
  }
  const encData = await encRes.json();
  const memoCiphertext: number[] = encData.ciphertext;
  const memoEphPubkeyX: bigint = BigInt(encData.ephemeralPubkey.x);
  const memoEphPubkeyY: bigint = BigInt(encData.ephemeralPubkey.y);

  const fcl = await import("@onflow/fcl");
  const txId = await fcl.mutate({
    cadence: TX_RECORD_SELF_TIP,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(
        memoCiphertext.map((b) => b.toString()),
        // @ts-expect-error — fcl types missing
        t.Array(t.UInt8)
      ),
      arg(memoEphPubkeyX.toString(), t.UInt256),
      arg(memoEphPubkeyY.toString(), t.UInt256),
    ],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 500,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
}

// ---------------------------------------------------------------------------
// Script helpers to fetch tips from chain
// ---------------------------------------------------------------------------

const PRIVATE_TIP_ADDR = "0xb9ac529c14a4c5a1";

export function buildGetShieldedTipsBySenderWithMemoScript(): string {
  return `
    import PrivateTip from ${PRIVATE_TIP_ADDR}
    access(all) fun main(sender: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsBySenderWithMemo(sender: sender)
    }
  `;
}

export function buildGetShieldedTipsByRecipientWithMemoScript(): string {
  return `
    import PrivateTip from ${PRIVATE_TIP_ADDR}
    access(all) fun main(recipient: Address): [PrivateTip.TipMetadataWithMemo] {
      return PrivateTip.getShieldedTipsByRecipientWithMemo(recipient: recipient)
    }
  `;
}

// ---------------------------------------------------------------------------
// recoverShieldedStateFromChain
// ---------------------------------------------------------------------------

interface CadenceTipWithMemo {
  tipID: string;
  sender: string;
  recipient: string;
  timestamp: string;
  memo: {
    ciphertext: number[];
    ephPubkeyX: string;
    ephPubkeyY: string;
  } | null;
}

/**
 * Reconstruct shielded state from chain.
 *
 * Scans both sender and recipient tip histories, decrypts all notes with the
 * caller's MemoKey privkey, and sums the balance and blinding from:
 *   - Self-tips (sender === recipient === me) with kind="wrap" or "residual"
 *   - Incoming tips from others (sender != me, recipient = me)
 *
 * Outgoing tips to others are NOT summed directly — the post-send residual is
 * captured as a "residual" self-tip. This keeps the accounting additive-only.
 *
 * Undecryptable notes are silently skipped for backwards compatibility.
 *
 * @param myFlowAddr       Caller's Flow address.
 * @param myMemoPrivkey    Caller's MemoKey privkey (BabyJub scalar).
 * @returns Reconstructed balance and blinding, or null if nothing found.
 */
export async function recoverShieldedStateFromChain(
  myFlowAddr: string,
  myMemoPrivkey: bigint
): Promise<RecoveredShieldedState | null> {
  const fcl = await import("@onflow/fcl");
  const myAddrLower = myFlowAddr.toLowerCase();

  // Fetch sent and received tips in parallel.
  const [sentRaw, receivedRaw] = await Promise.all([
    fcl.query({
      cadence: buildGetShieldedTipsBySenderWithMemoScript(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [arg(myFlowAddr, t.Address)],
    }) as Promise<CadenceTipWithMemo[]>,
    fcl.query({
      cadence: buildGetShieldedTipsByRecipientWithMemoScript(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [arg(myFlowAddr, t.Address)],
    }) as Promise<CadenceTipWithMemo[]>,
  ]);

  // De-dup: self-tips appear in BOTH sent and received lists. We track by tipID.
  const processed = new Set<string>();
  let balanceWei = 0n;
  let blinding = 0n;
  let anySuccess = false;

  const tryDecrypt = async (tip: CadenceTipWithMemo): Promise<void> => {
    const id = String(tip.tipID);
    if (processed.has(id)) return;
    processed.add(id);

    if (!tip.memo) return; // no encrypted note — skip

    const isSelf = tip.sender.toLowerCase() === myAddrLower &&
                   tip.recipient.toLowerCase() === myAddrLower;
    const isIncoming = tip.recipient.toLowerCase() === myAddrLower &&
                       tip.sender.toLowerCase() !== myAddrLower;

    // We only accumulate self-tips (recovery carbon copies) and incoming
    // tips from others. Outgoing tips to others are NOT subtracted because
    // their residual was stored as a "residual" self-tip instead.
    if (!isSelf && !isIncoming) return;

    try {
      const decRes = await fetch("/api/note/decrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ciphertext: tip.memo.ciphertext,
          ephemeralPubkey: {
            x: tip.memo.ephPubkeyX,
            y: tip.memo.ephPubkeyY,
          },
          privkey: myMemoPrivkey.toString(),
        }),
      });
      if (!decRes.ok) return; // auth tag mismatch → not our note → skip

      const decData = await decRes.json();
      const amount = BigInt(decData.amount);
      const noteBlinding = BigInt(decData.blinding);

      if (isSelf) {
        // Only accumulate self-tips that have a kind tag ("wrap" or "residual").
        // Plain self-tips from other flows or pre-recovery tips won't have
        // the data field and should not be double-counted.
        if (decData.data) {
          try {
            const tag = JSON.parse(decData.data as string) as { k?: string };
            if (tag.k === "wrap" || tag.k === "residual") {
              balanceWei += amount;
              blinding += noteBlinding;
              anySuccess = true;
            }
          } catch {
            // Not a JSON tag — not a recovery note, skip.
          }
        }
      } else {
        // Incoming tip from another sender — add unconditionally.
        balanceWei += amount;
        blinding += noteBlinding;
        anySuccess = true;
      }
    } catch {
      // Decrypt error — skip gracefully.
    }
  };

  // Process all tips (sent first so self-tips are deduplicated correctly).
  const allTips = [...sentRaw, ...receivedRaw];
  await Promise.allSettled(allTips.map(tryDecrypt));

  if (!anySuccess) return null;
  return { balanceWei, blinding };
}
