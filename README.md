# PrivateTip

Confidential tipping demo on Flow.

A reference app showing how to build privacy-preserving payments on Flow using
`@openjanus/sdk`. Send FLOW tips with the amount hidden on-chain. The recipient
sees an encrypted note with the value and memo. Multi-device by design. Browser
UI included.

> **Testnet only — do not use for real value.** The openjanus stack and
> PrivateTip are deployed on Flow EVM testnet for demonstration purposes.
> **Not recommended for production use until third-party audit completes**
> (audit pending). Admin functions `adminResetSlot` and `adminWipeTipsByRecipient`
> are present on testnet and flagged for removal before any mainnet deployment.

> **Fee model (v0.5.4+)**: wrap and unwrap each carry a **0.1% fee** at the
> boundary; shielded tips between users are **free**. OFAC sanctions screening
> via Chainalysis Oracle will be wired in for mainnet — privacy, not impunity.

---

## What it is

PrivateTip is a pure **metadata orchestrator** — it records sender, recipient,
timestamp, and an encrypted payload, but **never custodies FLOW**. The privacy
work is done by JanusFlow:

- **Amount hiding**: Pedersen commitments on BabyJubJub, gated by Groth16 proofs.
  Amounts never appear in calldata, events, or storage.
- **Memo hiding**: ECIES + AES-GCM, encrypted to the recipient's MemoKey pubkey.
- **Account-model balance**: one accumulated shielded balance per recipient in
  JanusFlow — not a per-tip escrow. Tips accumulate in the recipient's slot; they
  unwrap the full balance when they're ready.
- **Sign-derive MemoKey**: the recipient's decryption key is derived deterministically
  from a single wallet signature. Any device with the same wallet recovers the
  same MemoKey automatically.

---

## Live deployment

| Contract | Network | Address |
|---|---|---|
| PrivateTip.cdc (router + impl) | Flow Cadence testnet | `0xb9ac529c14a4c5a1` |
| JanusFlow EVM proxy (via PrivateTip) | Flow EVM testnet | `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078` |

SDK consumed: `@openjanus/sdk`

No public web URL yet — run it locally (see Quick start below) or deploy your
own instance.

---

## What's hidden vs. what's visible

| | Hidden | Visible |
|---|---|---|
| **Amount** | Yes — Pedersen commitment, never in events or calldata during shielded transfers | At wrap (gross in `msg.value`, net in `Wrapped` + `WrapWithSnapshot` events); at unwrap (claimedAmount in calldata + `Unwrapped` + `UnwrapWithSnapshot` events + internal FLOW transfer — see note below) |
| **Memo content** | Yes — ECIES encrypted to recipient's MemoKey | Only the encrypted blob's existence |
| **Shielded balance** | Yes — commitment is an opaque BabyJubJub point | The aggregate `totalLocked` pool (by design) |
| **Sender** | No | Visible on-chain |
| **Recipient** | No | Visible on-chain |
| **Timestamps** | No | Visible on-chain |

---

## Repo layout

```
cadence/
├── contracts/       PrivateTip.cdc (router), IPrivateTipImpl.cdc, PrivateTipImpl.cdc
├── transactions/    send_tip, claim_tips, admin_pause, admin_upgrade + helpers
└── scripts/         read-only queries

web/                 Next.js 16 browser app
├── app/             pages: /wrap, /send, /tips, /claim, /learn
├── lib/             tip-actions.ts, memo-key-session.ts, memo-key-derive.ts, store.ts
└── components/      ConnectWallet, TestnetBanner, BalanceDisplay, ui/

scripts/             e2e smoke tests
flow.json
```

---

## Quick start

```bash
cd web
npm install
npm run dev
# Visit http://localhost:3000 and connect a Flow wallet
```

Then, in order:

1. Click **"Set up now"** — signs one deterministic message to derive your MemoKey
   (no seed phrase, no on-chain transaction).
2. Click **Wrap** — select an amount, confirm in your wallet. Amount is visible
   at this boundary; everything after is hidden.
3. Click **Send tip** — pick a recipient, add a memo. Amount is hidden in the
   shielded transfer.
4. Switch to the recipient's wallet — incoming tips appear decrypted automatically
   (MemoKey recovered from the wallet signature).
5. Click **Withdraw** when ready — amount is visible again at this boundary.

For the theory behind each step, visit `/learn` in the running app.

---

## Architecture

PrivateTip's Cadence contracts handle metadata routing. JanusFlow does the privacy.

```
User wallet (FCL)
       |
PrivateTip.cdc (router)
  - records: sender, recipient, timestamp, encryptedNote
  - does NOT hold FLOW
       |
JanusFlow.cdc (cross-VM router, 0x5dcbeb41055ec57e)
       |
JanusFlow EVM proxy (0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078)
  - holds FLOW in custody
  - commitment[recipient] = Pedersen(balance, blinding)
  - shieldedTransfer: proof verified by Groth16 verifier
```

**MemoKey lifecycle**:

1. App prompts `wallet.signMessage("OpenJanus MemoKey v1")` — once, any device.
2. `deriveBabyJubKeypairFromBytes(sigBytes)` → deterministic BabyJub keypair.
3. `memoKey.pubkey` is published (on-chain or app-layer) so senders can encrypt to it.
4. `memoKey.privkey` stays in memory only — never persisted, never on-chain.
5. Any device with the same wallet recovers the identical keypair at step 2.

**ShieldedNote wire format** (what travels in the encrypted blob):

```json
{"v": 1, "a": "<amount in wei>", "b": "<blinding>", "d": "<memo text>"}
```

Encrypted with ECIES + AES-GCM; the recipient decrypts with their MemoKey privkey.

---

## Security notes

- **Amount privacy**: backed by JanusFlow's Groth16 + Pedersen scheme. Amounts
  never appear in calldata, events, or storage during shielded transfers.
- **Memo privacy**: ECIES + AES-GCM encrypted to the recipient's MemoKey pubkey.
  The app stores only the ciphertext; the plaintext is never transmitted or logged.
- **Sender/recipient privacy**: NOT hidden — both addresses are visible on-chain.
  Stealth addresses are a planned future feature.
- **Wrap/withdraw boundaries**: amounts are visible at `wrap` (`msg.value` carries
  the gross; `Wrapped(sender, netAmount)` and `WrapWithSnapshot(sender, netAmount, …)`
  events carry the net post-fee) and at `unwrap` (`claimedAmount` is a proof public
  input in calldata; `Unwrapped(sender, recipient, netToRecipient)` and
  `UnwrapWithSnapshot(sender, claimedAmount, …)` events are emitted; additionally the
  native FLOW transfer to the recipient is an internal transaction visible on any
  block explorer — removing events would not make unwraps private). This is
  amount privacy on shielded transfers, transparency at boundaries — by design,
  not by accident. The shielded pool is auditable for total custody via `totalLocked`.
  If you need post-withdraw unlinkability, use a fresh wallet to receive.
- **Admin functions** (testnet-only): `adminResetSlot`, `adminWipeTipsByRecipient`
  — convenience for testnet development. Both are flagged for removal before mainnet.
- **Impl upgrade model**: 48-hour time-lock from `proposeImplSwap` to
  `finalizeImplSwap`. Cancellation is immediate.

---

## License

MIT
