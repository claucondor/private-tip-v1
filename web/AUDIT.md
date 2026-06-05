# PrivateTip v0.7 Exhaustive Audit
## Date: 2026-06-05
## SDK: @claucondor/sdk@0.7.1 (aggregate-pedersen 2-gen)
## Scope: all proof routes, lib helpers, UI pages

Format: `[CATEGORY] file:line — finding — action`

---

## FIXED in this sprint

**[CIRCUIT-PATH] app/api/proof/wrap/route.ts:22 — pointed at `circuits/v0.3` (nonexistent in v0.7.1 SDK). Amount-disclose proof would fail at runtime on any wrap.**
Action: FIXED — updated to `circuits/aggregate/amount_disclose_aggregate.{wasm,zkey}`.

**[CIRCUIT-PATH] app/api/proof/shielded-transfer/route.ts:24 — same stale `circuits/v0.3` path for ConfidentialTransfer.**
Action: FIXED — updated to `circuits/aggregate/confidential_transfer_aggregate.{wasm,zkey}`.

**[CIRCUIT-PATH] app/api/proof/unwrap/route.ts:31 — stale `circuits/v0.3` for both AmountDisclose and ConfidentialTransfer.**
Action: FIXED — both updated to `circuits/aggregate/`.

**[CIRCUIT-PATH] app/api/proof/encrypt/route.ts:42 — stale `circuits/v0.5.1` path.**
Action: FIXED — updated to `circuits/aggregate/`.

**[CIRCUIT-PATH] app/api/proof/decrypt/route.ts:44 — stale `circuits/v0.5.1` path.**
Action: FIXED — updated to `circuits/aggregate/`.

**[CIRCUIT-PATH] app/api/proof/commit/route.ts:26 — stale `circuits/v0.5.1` path + used `buildAmountDiscloseProof` to compute a commitment (heavy ZK path for a pure-math operation).**
Action: FIXED — replaced with direct `computeCommitment` call (no ZK proof needed, no WASM path).

**[PUBLIC-INPUT-COUNT] app/api/proof/wrap/route.ts — v0.7 AmountDisclose has 4 public inputs `[amount, Cx, Cy, nonce]`, not 3. Route was missing `nonce` in body + response.**
Action: FIXED — route now accepts `nonce` (defaults to 1n), returns 4-element `publicInputs`.

**[PUBLIC-INPUT-COUNT] app/api/proof/unwrap/route.ts — same 3→4 signal change for AmountDisclose half of unwrap.**
Action: FIXED — `nonce` param added (defaults to 0n per SDK Phase B.5 behavior), response includes 4-element `amountPublicInputs`.

**[PUBLIC-INPUT-CAST] lib/tip-actions.ts:675,728 — `amountPublicInputs` cast as `[bigint,bigint,bigint]` (3-tuple) but SDK's `UnwrapViaCoaPrebuiltProofs.amountPublicInputs` requires `[bigint,bigint,bigint,bigint]` (4-tuple).**
Action: FIXED — both occurrences updated to 4-tuple cast.

**[NONCE-MISSING] lib/tip-actions.ts (wrapActionLegacy) — `prebuiltProof` passed to `wrapViaCoa` was missing `nonce` field (required by `WrapViaCoaPrebuiltProof` in v0.7 SDK).**
Action: FIXED — `nonce` read from localStorage per-user per-token, passed to API route and `prebuiltProof`.

**[NONCE-MISSING] lib/tip-actions.ts (unwrapAction) — `prebuiltProofs` passed to `unwrapViaCoa` was missing `nonce` field.**
Action: FIXED — `nonce: 0n` added (SDK defaults to 0n for unwrap anti-replay, Phase B.5).

**[PEER-DEP-MISSING] package.json — @claucondor/sdk@0.7.1 has peer dep `@openjanus/commitment` (local workspace dep in SDK). Tarball install breaks the symlink, causing `Module not found: @openjanus/commitment` build error.**
Action: FIXED — `@openjanus/commitment@0.1.0` packed from SDK node_modules and installed explicitly.

**[TOKEN-REMOVED] lib/tip-actions.ts:85 — `TOKEN_REGISTRY.wflow.proxy` referenced but `wflow` was removed from TOKEN_REGISTRY in v0.7.**
Action: FIXED — `TOKEN_PROXIES` object dropped the `wflow` key.

**[TOKEN-REMOVED] lib/tip-actions.ts:419 — cast `as typeof TOKEN_REGISTRY["wflow"]` (no longer exists in v0.7).**
Action: FIXED — changed to `typeof TOKEN_REGISTRY["mockusdc"]`.

**[TOKEN-REMOVED] e2e/smoke.test.ts:84 — hardcoded `"wflow"` in tokenIds array.**
Action: FIXED — removed `wflow` from test token list.

**[BANNER-MISLEADING] components/MainnetCountdown.tsx — countdown target was 2026-06-11, already past. Banner would show "PrivateTip is live on mainnet" even though mainnet was never launched and audit is incomplete.**
Action: FIXED — replaced countdown with persistent "Testnet demo · Flow EVM testnet (chainId 545) · Funds have no real value · Mainnet pending audit" banner.

**[VERSION-LABEL] app/client-layout.tsx:540 — footer showed `v0.6.5`.**
Action: FIXED — updated to `v0.7.1`.

---

## FLAGGED as mainnet-blockers

**[MAINNET-BLOCKER-1] lib/memo-mirror.ts:148 — `ingestTipIfNew` writes to `openjanus:shielded:<addr>` (old v1 format, no token ID, no proxy fingerprint). The `sweepStaleShieldedCache()` call on every mount (client-layout.tsx) DELETES any `openjanus:shielded:` key that doesn't match the v2 format. Users who received tips via the /tips page but never wrapped will lose their ingested balances on next session.**
- Affected path: /tips page decrypt → ingestTipIfNew → save to v1 key → sweeped on next mount
- Status: **FIXED** in commit `2603eb4`. `ingestTipIfNew` now delegates to `store.ts` `saveShieldedState` (v2 key format: `openjanus:shielded:v2:<addr>:<tokenId>:<fingerprint>`). Default `tokenId="flow"`. Added `migrateV1ShieldedKeyIfPresent()` that runs on first call per address: decodes any existing v1 key, writes to v2, deletes v1. Users with prior ingested balances are migrated automatically.

**[MAINNET-BLOCKER-2] lib/fcl-config.ts:65-66 — Cadence contract aliases `0xJanusFlow: 0x5dcbeb41055ec57e` and `0xPrivateTip: 0xb9ac529c14a4c5a1` are hardcoded. These are the correct testnet addresses but are not validated against the SDK's network config. If a testnet re-deploy changes the Cadence router address, the TX_SMART_SETUP transaction (tip-actions.ts:279-280) and all PrivateTip Cadence scripts will silently use the stale address. Before mainnet, Cadence contract aliases must come from the SDK's exported network constants or flow.json, not hardcoded strings.**
- Severity: testnet OK (addresses currently correct), mainnet is a different chain → addresses will change.
- Status: **FIXED** in commit `e72a33f`. Added `JanusFlow` contract entry to `web/flow.json` with testnet alias. `resolveAlias()` in `fcl-config.ts` reads per-network entries from `flow.json` at module load time — same source used by `FlowProvider` in `client-layout.tsx`. To port to mainnet: add `"mainnet"` alias entries in `web/flow.json` and update `accessNodeUrl` + `discoveryWallet`.

**[MAINNET-BLOCKER-3] lib/fcl-config.ts:78 — `ADDRESSES.JANUS_FLOW_EVM: "0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156"` is a stale v0.3 address. Not currently imported by any production code (grep confirms), but a dead export. If a future developer imports it they'll use the wrong proxy. Remove or update.**
- Status: **FIXED** in commit `e72a33f`. `ADDRESSES.JANUS_FLOW_EVM` removed. `ADDRESSES` now only exports `JANUS_FLOW_CADENCE` and `PRIVATE_TIP_CADENCE`, both sourced from `flow.json`. Callers needing the EVM proxy should use `TOKEN_REGISTRY.flow.proxy` from `@claucondor/sdk`.

---

## FLAGGED as future / non-blocking

**[FUTURE-1] lib/memo-mirror.ts:199-211 — `ingestTipIfNew` accumulates blindings with simple addition (`newBlinding = BigInt(current.blinding) + opts.blinding`). Pedersen commitments are additively homomorphic so this is mathematically correct for accumulating blinding factors. However, if the user has multiple tokens or complex state, this accumulation in the old shielded key may diverge from on-chain commitment. Tracked in MAINNET-BLOCKER-1.**

**[FUTURE-2] app/api/proof/encrypt/route.ts + app/api/proof/decrypt/route.ts — legacy route aliases kept for backward compat. No callers in the app use them (all calls go to /api/proof/wrap and /api/proof/shielded-transfer). These can be removed post-v0.7 to reduce confusion. WONT-DO for this sprint.**

**[FUTURE-3] app/portfolio/page.tsx:220 — `console.log("[portfolio] load start", { userAddress })` and similar debug logs. These log the user's Flow address on every portfolio load in production. Not sensitive (public address) but noisy. Should be removed or gated behind `isDev` before mainnet. WONT-DO for this sprint (no PII, not a security issue).**

**[FUTURE-4] lib/tip-actions.ts:80 — `PRIVATE_TIP_CADENCE = "0xb9ac529c14a4c5a1"` is hardcoded. This is the PrivateTip Cadence contract address used in on-chain scripts. Correct for testnet. Must be updated (or environment-variable-driven) before mainnet. Part of MAINNET-BLOCKER-2 theme.**

**[FUTURE-5] lib/memo-key-session.ts — privkey stored in sessionStorage as plaintext bigint decimal. This is the design tradeoff (session-scoped, cleared on tab close). Not a mainnet blocker (accepted architecture). For mainnet hardening: consider wrapping with Web Crypto AES-GCM keyed from a browser-native key handle.**

**[FUTURE-6] app/api/proof/wrap/route.ts — nonce default of 1n (first wrap). If the user has wrapped before (from another browser/device) the contract's `usedNonces` will have nonce=1 already, and passing nonce=1 will revert with "nonce already used". The correct fix is to read the current nonce from the contract on-chain before building the proof, or track the nonce server-side. Current localStorage tracking is best-effort and device-local. This is a known UX limitation — the wrap will revert on second device. User must export/import nonce state or use contract read. FLAGGED for mainnet hardening.**

---

## NOT COVERED in this audit (explicitly declared)

- `app/tips/page.tsx` — full content not read end-to-end (only the `ingestTipIfNew` call site checked)
- `app/learn/page.tsx` — static content page, not audited
- `app/page.tsx` (home) — landing page, not audited
- `lib/ft-setup.ts` — Cadence FT setup helpers, not audited
- `lib/fcl-config.ts` — partially audited (addresses found, see above)
- `components/` (non-MainnetCountdown) — UI components not audited for business logic
- `app/api/faucet/route.ts` — faucet route partially checked (MockUSDC address verified correct, full logic not audited)
- `app/api/note/`, `app/api/memo/`, `app/api/keypair/` — not audited (no v0.7 circuit dependency)

---

## Summary

Total findings: 17
- FIXED in sprint: 14
- MAINNET-BLOCKERS not fixed: 3
- FUTURE / non-blocking: 6
- NOT COVERED: 9 files/areas

### Mainnet-blocker count: 3

The 3 mainnet-blockers are:
1. `memo-mirror.ts` ingestTipIfNew writes to old v1 localStorage key that gets swept → tip-only users lose shielded state
2. Cadence contract aliases hardcoded in `fcl-config.ts` (testnet correct, mainnet will differ)
3. Stale `ADDRESSES.JANUS_FLOW_EVM` in `fcl-config.ts` (dead code but dangerous)

**For testnet deploy: blockers 2 and 3 are testnet-correct (addresses match current deployment) and do not affect testnet operation. Blocker 1 affects tip-only users on testnet today.**

---

## Final status — v0.7 sprint

All 3 mainnet-blockers closed as of 2026-06-05. Commits: `2603eb4`, `e72a33f`.

**READY-FOR-MAINNET-PORT: TBD**

Remaining external dependencies before actual mainnet launch (not testnet blockers):

1. **OFAC compliance hook** — Chainalysis Oracle integration in wrap/unwrap path (per mainnet-compliance-ofac.md). "Privacy not impunity" stance, legal differentiator vs mixers.
2. **Multi-party ceremony** — The ZK circuit trusted setup (Pedersen aggregate) requires a multi-party ceremony for mainnet. Current `.zkey` files are for testnet/dev only.
3. **Mainnet contract addresses** — Deploy JanusFlow and PrivateTip to mainnet, add `"mainnet"` alias entries in `web/flow.json`, update `accessNodeUrl` + `discoveryWallet` in `fcl-config.ts`.
4. **Nonce UX hardening** — FUTURE-6 (wrap nonce collision on second device) should be resolved before mainnet via on-chain nonce read before proof generation.
