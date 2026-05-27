# PrivateTip v1 — Demo Readiness Report (v0.2.1)

**Date:** 2026-05-26
**Sprint phase:** 4a (final smoke + extended coverage + frontend startup)
**Verdict:** READY TO SHIP for backend/CLI demo. UI demo BLOCKED by Cadence
transaction signature mismatch between frontend and contract (see "Known
limitations" below).

---

## Summary

The v0.2.1 sprint addressed two on-chain bugs discovered in earlier smoke
tests and proved them fixed end-to-end on Flow EVM testnet:

| Vuln | Description | Fix | Verified |
|------|-------------|-----|----------|
| 014  | `JanusToken.unwrap()` released `claimedUnits` wei instead of `claimedUnits * 1e18` (the whole-FLOW unit / wei mismatch) | New UUPS proxy with `SCALE = 1e18` bridging the ZK whole-FLOW circuit value to wei | smoke-test.ts: 6 FLOW wrapped → 6 FLOW recovered, gas delta only |
| 015  | `PrivateTip.claimTip()` checked `self.account.address` (== deployer), so only the contract deployer could claim any tip | Router pattern: `claimTip` takes `auth(BorrowValue) &Account` and asserts `tip.recipient == signer.address` | test-router-claim.mjs + test-full-private-tip-cycle.mjs: Alice and Charlie (both non-deployer) claim successfully; Bob/Dave can never claim someone else's tip |

The core privacy primitives — ElGamal encrypt / homomorphic accumulator /
Groth16 verifier / BSGS decrypt / unwrap with FLOW release — are verified
working on the new addresses by four independent test scripts.

---

## Canonical v0.2.1 addresses (production set)

| Layer | Component | Address |
|-------|-----------|---------|
| EVM   | JanusToken UUPS proxy   | `0x025efe7e89acdb8F315C804BE7245F348AA9c538` |
| EVM   | JanusToken impl         | `0x28686066D28Eb86269190Eae76eD7170c21BB7FB` |
| EVM   | EVM proxy owner (COA)   | `0x0000000000000000000000022f6b30af48a94787` |
| EVM   | BabyJub                 | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| EVM   | EncryptConsistencyVerifier | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e` |
| EVM   | DecryptOpenVerifier     | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc` |
| Cadence | JanusFlow router      | `0x5dcbeb41055ec57e` |
| Cadence | PrivateTip router     | `0xb9ac529c14a4c5a1` |

**Deprecated (do NOT reuse):**

- JanusToken EVM (non-upgradeable): `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499`
- JanusFlow Cadence (router with 48h impl-swap lock blocking redeploy): `0xbef3c77681c15397`
- JanusFlow Cadence (Pedersen zombie, cannot remove): `0x28fef3d1d6a12800`
- PrivateTip (monolith with vuln 015): deployed at `0xd807a3992d7be612`

SDK: **@openjanus/sdk@0.2.1** (published to npm)

---

## Test results

### Backend smoke test — `scripts/smoke-test.ts`

Charlie wraps 1 + 2 + 3 FLOW to himself via direct EVM COA calls, BSGS-
decrypts the accumulated slot to total = 6, generates a `decrypt_open`
proof, and unwraps via `JanusToken.unwrap`. Asserts FLOW recovery.

**Verdict: PASS**

| Step | Tx hash |
|------|---------|
| wrap-1 (1 FLOW) | `4c054ca60f81e071e8b29d9292e5749dd67157035e190358b3ce458866e8733a` |
| wrap-2 (2 FLOW) | `1350f504503b1c9c537c1e9b942710b687d3a1f9d26f990d36c8a2080f2279bf` |
| wrap-3 (3 FLOW) | `1caad8e72893e8f4cf92f4aa4d17cff6adecfb578009f83f469bdf4354f5d9ad` |
| unwrap (6 units) | `5d08784e7f36ed69c8c7cc8e5b0519b1d84b43675e26a51c05e0f8daef90e426` |

- `SCALE() = 1e18` confirmed on proxy
- `locked[charlie_COA]` decreased by exactly `6 * 10^18` attoFLOW
- Slot reset to identity post-unwrap
- Cadence balance delta: **-0.00816 FLOW** (gas only — recovery successful)

### Extended test 1 — `scripts/test-multi-sender.mjs`

Alice (1 FLOW), Bob (2 FLOW), and Dave (3 FLOW) each wrap independently
to Charlie's pubkey. Charlie BSGS-decrypts the accumulated slot, generates
the unwrap proof, and recovers ~6 FLOW.

**Verdict: PASS**

| Step | Tx hash |
|------|---------|
| alice wrap (1 FLOW)  | `d92b12eb3f79e8725ee5116c19a3601a847dae04541a507790f94d9157c4884d` |
| bob wrap (2 FLOW)    | `8f8e161b9f4f420f9cefa09a2563e0f7abdebbacab6941d8b4cfed1743d7d326` |
| dave wrap (3 FLOW)   | `1e5e5db38bc53974cfc1f81b34a88651f157d91a992bf7e6815105aa9f8acbec` |
| charlie unwrap       | `991d6fd8f6d5e81ee3aefe2e24d6ee92884f95974dff37450db42cc1bce84421` |

- `locked[charlie_COA]` increased by exactly `6e18` attoFLOW
- BSGS recovers `total = 6` from the homomorphic sum
- Charlie's Cadence balance increased by **+5.9979 FLOW**
- Privacy property: per-sender amounts (1, 2, 3) are NOT recoverable —
  the contract overwrites the slot with the running sum on each wrap, so
  even an adversary with the recipient privkey can only decrypt the total.

### Extended test 2 — `scripts/test-cadence-wrap-unwrap.mjs`

Alice wraps 1 FLOW via the JanusFlow Cadence router at
`0x5dcbeb41055ec57e` (not direct EVM call). Verifies the EVM proxy's
`locked[]` increments, then unwraps via `JanusFlow.unwrap`.

**Verdict: PASS**

| Step | Tx hash |
|------|---------|
| alice registerPubkey | `ac475d026c10573460146bac1e715202ea021554d29e7fd4a4384ee1f1213af8` |
| alice wrap           | `2775a271780152d0b783532c4772f46eb380609f1bb2ac7c84e56cd8b33a4fb0` |
| alice unwrap         | `610ad1b4704268fe21e10372eac4b8f2606db1e077e44e79fa1c848f757e7042` |

- Cadence router properly proxies to the new EVM UUPS proxy
- EVM slot updated, FLOW recovered
- Alice's Cadence balance round-trip delta: **-0.00436 FLOW** (gas only)

### Extended test 3 — `scripts/test-full-private-tip-cycle.mjs`

Bob sends a 2 FLOW tip to Charlie via PrivateTip router. Five sub-tests:

1. Bob sends to Charlie — succeeds, tipID = 5 emitted
2. Dave tries to claim Charlie's tip — REJECTED (vuln 015 fix active)
3. Bob (sender) tries to claim his own outbound tip — REJECTED
4. Charlie claims his tip — succeeds
5. Charlie tries to re-claim — REJECTED (double-claim protection)

**Verdict: PASS**

| Step | Tx hash |
|------|---------|
| sendTip (Bob → Charlie 2 FLOW)  | `6113558b93142fad9caa31839b369b40e893ce7bb7886a2568d75f6564b1be10` |
| daveAttempt (rejected)          | `1d3dc0b92fde5253ea6f37d6258ea94830e7b01676e08fcfc2c3b08da1998858` |
| bobSelfClaim (rejected)         | `69c9f4b2523f38a594859916d4bd7df7e04a48a25ed9fe7ae2f56b6d0b194439` |
| charlieClaim (success)          | `cccac32831e1246e330ab9aa1a21b67eada4c47e053e0177975bda9e9da26e3f` |

- Charlie's balance delta: **+1.99918 FLOW** (≈ 2 FLOW minus claim gas)
- Vuln 015 verified fixed for arbitrary non-deployer recipients (Charlie,
  in addition to Alice from Phase 3 `test-router-claim.mjs`)

---

## Frontend startup confirmation

- `web/package.json` bumped from `@openjanus/sdk@^0.2.0` → `^0.2.1`
- Hardcoded address updates in `web/`:
  - 2× `0xbef3c77681c15397` → `0x5dcbeb41055ec57e` (JanusFlow router)
  - 4× `0xPRIVATETIP_ADDRESS` placeholders → `0xb9ac529c14a4c5a1`
- `npm install` succeeded
- `npm run dev` starts cleanly on `localhost:3000` (Next.js 16.2.6 + Turbopack)
- All four routes return 200: `/`, `/send`, `/claim`, `/tips`
- No runtime errors observed in dev log (one benign workspace-root warning)

---

## Known limitations

### BLOCKER for UI demo: frontend Cadence transactions reference non-existent methods

The Cadence transactions embedded in `web/app/send/page.tsx` and
`web/app/claim/page.tsx` call `JanusFlow.wrapAndEncrypt` and
`JanusFlow.decryptAndUnwrap`. The actual `JanusFlow.cdc` contract at
`0x5dcbeb41055ec57e` exposes `wrap` and `unwrap` (with completely
different argument shapes — see `cadence/transactions/jf_wrap.cdc` and
`jf_unwrap.cdc` for the correct signatures).

Until the frontend transactions are rewritten to match the actual
contract API, end-to-end UI flows for L2 (confidential FLOW wrapping)
will fail. The L3 path (named tips via PrivateTip router) is unaffected
and should work end-to-end in the browser because its Cadence transactions
match the deployed contract.

**Operator action item:** before the public UI demo, port the working
Cadence transactions from `scripts/test-cadence-wrap-unwrap.mjs` into the
frontend. The shape is: `JanusFlow.wrap(signer, vault, recipient,
toEVMHex, ciphertext, senderNonce, calldataHex)` and `JanusFlow.unwrap
(signer, claimedAmount, recipient, calldataHex)`.

### Non-blockers

- **Single-key admin control.** The PrivateTip router admin (Pause |
  Upgrade entitlements) is gated by an `AdminResource` saved at
  `/storage/privateTipAdmin` in the router-deployer account
  (`0xb9ac529c14a4c5a1`). A single Flow account key can pause the
  contract or finalize an impl swap. No multi-sig. Acceptable for
  testnet demo; production should issue the admin capability into a
  multi-sig account before mainnet.

- **48h impl-swap time-lock.** Once an impl swap is proposed it cannot
  be finalized for 48 hours. Cancellation is immediate. This is by
  design for safety, but means a hot-patch is not possible. Pause is
  immediate.

- **Amount per tip is visible on PrivateTip (L3).** This is intentional;
  L3 is the "named tips" UX layer. For confidential amounts the user
  must use the L2 JanusFlow / JanusToken pair.

- **Per-sender amount NOT recoverable from the encrypted slot.** The L2
  homomorphic accumulator only reveals the running sum to the recipient,
  not individual contributions — verified by `test-multi-sender.mjs`.

- **Charlie's COA on the new proxy still holds wrap-related state from
  prior runs.** Subsequent BSGS decrypts will return a cumulative total
  including any prior balance. Not a bug — just an artifact of running
  the same test multiple times without resetting state.

- **The web/ subdirectory was previously not under git management.** The
  v0.2.1 sprint committed only the files actually modified. The remaining
  web/ tree (components, app/api, configs, etc.) is still untracked. The
  operator should decide whether to bring the full frontend under git
  before the public demo.

---

## Operator manual test checklist (browser)

After the operator rewrites the frontend Cadence transactions per the
blocker above, the manual demo path is:

1. **Connect wallet**
   - Open `localhost:3000/` in browser
   - Click "Connect" → select Flow wallet (testnet)
   - Verify wallet address renders in the header

2. **Register pubkey (one-time per account)**
   - On a new account, the app should prompt for pubkey registration
   - Approve the Cadence transaction in the wallet
   - Verify the registered pubkey is shown on the recipient profile

3. **Send a tip (with amount hidden — L2 path)**
   - Navigate to `/send`
   - Enter recipient Flow address
   - Verify the recipient pubkey loads (encryption target)
   - Enter amount (e.g. 1 FLOW)
   - Add optional memo
   - Approve the wrap transaction in the wallet
   - Verify TipSent / Wrapped event in the wallet history

4. **Switch wallet to recipient**
   - Disconnect, switch to the recipient's Flow account
   - Reconnect

5. **Claim tip**
   - Navigate to `/claim` or `/tips`
   - Verify the incoming tip is listed
   - For L3 (PrivateTip): click "Claim" — approve the claim_tips
     transaction — verify FLOW balance increased by tip amount
   - For L2 (JanusFlow): the app needs to BSGS-decrypt the slot, generate
     a decrypt_open proof, and call unwrap — verify balance increased

6. **Verify balance change**
   - Open Flow account in flowscan.io or in-wallet
   - Confirm the sender's balance decreased by tip + gas
   - Confirm the recipient's balance increased by tip - claim_gas

7. **Negative tests**
   - Try to claim a tip you didn't receive — must reject
   - Try to re-claim a tip you already claimed — must reject
   - Try to send a tip larger than your balance — wallet should reject

---

## Ready-to-ship verdict

| Surface | Status |
|---------|--------|
| Smart contracts (EVM + Cadence)           | READY |
| SDK (`@openjanus/sdk@0.2.1`)              | READY (published) |
| Backend smoke tests                        | READY (4/4 PASS) |
| Frontend startup                           | READY (dev server clean) |
| Frontend UI flows                          | BLOCKED — see "Known limitations" |
| Documentation (this file + Phase 3 README) | READY |

**For a backend / CLI-driven demo: READY TO SHIP.**

**For a public browser demo: BLOCKED on rewriting frontend Cadence
transactions to match the deployed `JanusFlow.cdc` API.** The shape of
the rewrite is documented above and can be done by porting from
`scripts/test-cadence-wrap-unwrap.mjs`. ETA estimate: a few hours of
frontend / Cadence work.

---

*Generated by Phase 4a of the openjanus v0.2.1 fix sprint.*
