# PrivateTip v0.8 — Pre-sprint Audit

> Generated: 2026-06-09
> Reference: openjanus-sdk v0.8.0-alpha.1 + v0.8 contracts at `0x4b6bc58bc8bf5dcc`
> Scope: contracts + scripts only (web/ NOT audited)
> Constraint: do NOT modify or break current deployed PrivateTip at `0xb9ac529c14a4c5a1`

---

## Executive Summary

- **16 source/config files audited** (cadence/contracts + admin-transactions + flow.json; web/ and _archive/ excluded)
- **1 KEEP** (setup_coa.cdc — COA setup pattern unchanged), **6 REWRITE** (conceptually valid, deeply incompatible APIs), **9 DROP** (legacy v0.2/v0.3 patterns with no v0.8 equivalent)
- **cadence/scripts/ and cadence/transactions/ directories do not exist** — zero Cadence query scripts or user-facing transaction templates to audit; sprint must create them from scratch
- **No root scripts/ directory** — all SDK-driven orchestration scripts are missing; sprint must create 8 new .cjs scripts
- **Estimated sprint: ~8-9 hours** across 4 phases

---

## Classification by Directory

### cadence/contracts/

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| `PrivateTip.cdc` | REWRITE | v0.4.2 monolith carrying v0.2/v0.3 compat baggage: deprecated `MemoKey` resource (now JanusFlow primitive), `MemoStore` resource (now Inbox-delivered cipher), `TipRecord` w/ `amount`/`memo`/`claimed` fields (zero-valued stubs for compat), legacy `TipSent`/`TipClaimed` events (unfireable stubs), `tipVaults @{UInt64: FlowToken.Vault}` (v0.2 escrow, always empty), IPrivateTipImpl swap + 48h time-lock machinery, `ciphertextRef [UInt256]` in recordTip (Pedersen C_tx — no longer stored; lives in Inbox cipher). None of these compat layers can be removed on upgrade at `0xb9ac529c14a4c5a1` (validator blocks removal). At `0x4b6bc58bc8bf5dcc` this is a brand-new deploy — start clean. Core concept (thin metadata index) remains valid. | Full rewrite as metadata-only contract (see architecture section). |
| `IPrivateTipImpl.cdc` | DROP | Swappable impl pattern (validate* methods, 48h time-lock) was defensive architecture for an upgradeable proxy. Fresh deploy at new account has no history to protect; Cadence upgrade mechanics are sufficient. | Delete. |
| `PrivateTipImpl.cdc` | DROP | Pure logic for IPrivateTipImpl; goes with the interface. `validateRecordTip`/`validateSendTip`/`validateClaim` are either inlined trivially or no longer needed. | Delete. |

### cadence/transactions/

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| *(directory does not exist)* | — | No user-facing transaction templates exist. | Sprint creates: `install_inbox_checkpoint.cdc`, `send_shielded_tip_flow.cdc`, `send_shielded_tip_musdc.cdc`, `send_shielded_tip_mockft.cdc`, `update_checkpoint.cdc`. |

### cadence/scripts/

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| *(directory does not exist)* | — | No query scripts exist. | Sprint creates: `get_tips_by_sender.cdc`, `get_tips_by_recipient.cdc`, `get_tip.cdc`, `get_inbox_count.cdc`, `get_checkpoint_metadata.cdc`. |

### scripts/ (root)

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| *(directory does not exist)* | — | No SDK-driven orchestration scripts exist. All v0.8 scripts must be built from scratch using SDK v0.8.0-alpha.1 patterns (combo-*.cjs reference). | Sprint creates: `01-onboarding.cjs` through `99-e2e-full-cycle.cjs` (8 files). |

### admin-transactions/

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| `admin_drain_legacy_vault.cdc` | DROP | Drains leftover v0.2 `@FlowToken.Vault` from `tipVaults` dict. v0.8 PrivateTip has no vault storage. | Delete. |
| `admin_force_set_impl_version.cdc` | DROP | Sets `activeImplVersion` string — impl versioning pattern removed entirely in v0.8. | Delete. |
| `admin_pause.cdc` | REWRITE | Pause/unpause admin pattern is still valid and should carry over. Needs: new import address (`0x4b6bc58bc8bf5dcc`), updated entitlement references, remove dead storage path references. | Rewrite importing new PrivateTip; logic (pause/unpause if-branch) stays identical. |
| `admin_upgrade.cdc` | DROP | Manages IPrivateTipImpl time-locked swap (propose/finalize/cancel). This machinery does not exist in v0.8 PrivateTip. | Delete. |
| `jf_unwrap.cdc` | DROP | Imports `JanusFlow from 0x5dcbeb41055ec57e` (v0.7.1 Cadence router, now offline for v0.8 accounts). v0.8 unwrap goes via SDK-orchestrated EVM calldata (JanusFlow proxy at `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3`) submitted through the signer's COA in `07-unwrap.cjs`. No equivalent Cadence-only tx needed. | Delete; replaced by `scripts/07-unwrap.cjs`. |
| `jf_unwrap_to_vault.cdc` | DROP | Same: v0.7.1 Cadence router import. Pattern (COA balance delta → Cadence vault deposit) is handled inside SDK adapter in v0.8. | Delete. |
| `jf_wrap.cdc` | DROP | Imports `JanusFlow from 0x5dcbeb41055ec57e`. v0.8 wrap is EVM-native; SDK builds amount-disclose proof + calldata and submits via COA. No Cadence router needed. | Delete; wrap is step 1 inside `02-send-tip-flow.cjs`. |
| `jf_wrap_from_coa.cdc` | DROP | COA-source wrap variant; same reason as above. | Delete. |
| `send_shielded_tip.cdc` | REWRITE | Concept (combined shieldedTransfer + recordTip in one atomic Cadence tx) is exactly right for v0.8. Current version is incompatible: imports `JanusFlow from 0x5dcbeb41055ec57e`, uses 9-arg shieldedTransfer (v0.7.x ABI, removed in v0.8), passes `ciphertextRef`/`memoEphPubkeyX`/`memoEphPubkeyY` to `PrivateTip.recordTip` (no longer part of recordTip signature), missing checkpoint update step. v0.8 version: COA submits 6-arg `shieldedTransfer` calldata to JanusFlow EVM proxy; inbox deposit is automatic; recordTip only receives (sender, recipient, tokenContract); separate `update_checkpoint.cdc` handles ShieldedCheckpoint. | Full rewrite per v0.8 ABI. Sprint creates three variants: FLOW, mUSDC, MockFT. |
| `setup_account.cdc` | REWRITE | Combined COA + MemoKey setup in one tx — the "single onboarding tx" concept is correct and should carry forward. Current version installs deprecated `PrivateTip.MemoKey` resource. v0.8 version must: (1) create COA, (2) install `@ShieldedInbox.NoteInbox` at `/storage/shieldedInbox` + publish `&{Receiver}` at `/public/shieldedInbox` from `0x4b6bc58bc8bf5dcc`, (3) install `@ShieldedCheckpoint.Checkpoint` at `/storage/shieldedCheckpoint` from `0x4b6bc58bc8bf5dcc`, (4) publish BabyJub pubkey via EVM MemoKeyRegistry (not JanusFlow.publishMemoKey). | Rewrite for v0.8 four-step onboarding. Becomes the Cadence side of `01-onboarding.cjs`. |
| `setup_coa.cdc` | KEEP | COA creation at `/storage/evm` + capability at `/public/evm`. Idempotent guard present. No address dependencies — `EVM` system contract alias is network-resolved. Pattern is unchanged in v0.8. | No changes. Used as-is in `01-onboarding.cjs`. |
| `setup_memo_key.cdc` | REWRITE | v0.5.3 version correctly separates Cadence resource from EVM pubkey publish, and uses `load<@AnyResource>` eviction (correct migration pattern). However: imports `JanusFlow from 0x5dcbeb41055ec57e` (old address), calls `JanusFlow.publishMemoKey` on old EVM address `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078`. In v0.8, pubkey is registered via EVM `MemoKeyRegistry` at `0x361bD4d037838A3a9c5408AE465d36077800ee6c` (new shared registry across all tokens). Cadence resource type may shift depending on whether JanusFT exposes a MemoKey interface. | Rewrite with new import address and new registry call target. Logic (evict-load, save, publish cap, COA call) is structurally reusable. |

### Root config / misc

| File | Verdict | Reason | Action |
|------|---------|--------|--------|
| `flow.json` | REWRITE | All contract aliases point to `0xb9ac529c14a4c5a1`. Must add: `JanusFT`, `ShieldedInbox`, `ShieldedCheckpoint` at `0x4b6bc58bc8bf5dcc`; new `PrivateTip` deployment target at `0x4b6bc58bc8bf5dcc`; remove `IPrivateTipImpl`/`PrivateTipImpl` from deployments (dropped). Add new v0.8 account entry for deployer. | Rewrite deployments + dependencies block. |
| `.tmp_test_script.cdc` | DROP | Temp debugging artifact left in repo root. | Delete. |
| `emulator-account.pkey` | KEEP | Emulator key file; needed if emulator-based testing is added. | No changes. |

---

## Key Design Decisions

### Decision 1 — PrivateTip v0.8 as thin metadata-only contract

**Ruling: ADOPT**

v0.8 Inbox delivers the cipher (amount + memo ECIES-encrypted) directly to the recipient's `NoteInbox`. The previous pattern of storing `MemoCiphertext` blobs in a `MemoStore` resource on the contract account duplicated data that is now in Inbox, and `ciphertextRef [Cx, Cy]` linked the on-chain record to the EVM event — unnecessary with the Inbox audit trail.

New `PrivateTip.recordTip` accepts only: `sender auth(BorrowValue) &Account`, `recipient: Address`, `tokenContract: Address`. Returns `tipID: UInt64`. Caller is always the combined-tip Cadence transaction (atomicity guaranteed).

The `tokenContract` field is new and critical for multi-token support: it distinguishes JanusFlow (`0xA64340C1d356835A2450306Ffd290Ed52c001Ad3`), JanusERC20 (`0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d`), and JanusFT (`0x4b6bc58bc8bf5dcc`) tips in query results.

### Decision 2 — Drop SenderSnapshotStore / MemoStore

**Ruling: CONFIRMED DROP**

Both `MemoStore` (encrypted memo blobs keyed by tipID) and the legacy self-tip "sender snapshot" pattern are superseded:
- Recipient's cipher: lives in `ShieldedInbox.NoteInbox` (drain → ECIES decode)
- Sender's state: lives in `ShieldedCheckpoint` (encryptAndUpdate → readAndDecrypt on recovery)

PrivateTip v0.8 stores zero encrypted data. It is a pure lookup index.

### Decision 3 — Drop IPrivateTipImpl swappable impl pattern

**Ruling: CONFIRMED DROP**

The 48h time-lock impl swap was designed to protect an already-deployed contract at a fixed address. At a fresh deploy address (`0x4b6bc58bc8bf5dcc`), standard Cadence upgrade mechanics apply. The validation logic (length checks on ciphertextRef, memo bounds) either disappears (ciphertextRef gone) or is trivially inlined. No pluggable strategy layer needed.

### Decision 4 — EvmRecipientStore.cdc (referenced in audit brief)

**Ruling: ALREADY GONE — file never existed at this commit**

No `EvmRecipientStore.cdc` or equivalent is present in the repo (checked all non-archived paths). It was likely removed in an earlier cleanup sprint or never materialized. v0.8 Inbox is EVM-native and makes an EVM-specific recipient activation store redundant anyway.

### Decision 5 — Cadence transactions vs SDK-driven .cjs scripts

**Ruling: BOTH ARE NEEDED, different purposes**

- **Cadence `.cdc` transactions** (in `admin-transactions/` or new `cadence/transactions/`): for the atomic combined-tx (shieldedTransfer + recordTip + checkpoint update) submitted as a single Cadence transaction. Required for production because it's the only way to guarantee atomicity.
- **SDK `.cjs` scripts** (new `scripts/01-99`): orchestration layer — build proofs, derive keys, compute blinding, submit transactions via flow CLI subprocess, decode results. These are test/demo harnesses, not production transaction templates.

The split in the combo-*.cjs pattern (call EVM via ethers + submit Cadence tx via `execFileSync('flow', ['transactions', 'send', ...])`) is the correct model.

### Decision 6 — Multi-token recordTip

**Ruling: ADD tokenContract field**

Current PrivateTip is JanusFlow-only (v0.5.3 started decoupling but was never completed). The v0.8 rewrite must be multi-token from day one. `tokenContract: Address` in `TipMetadata` lets the frontend/indexer render the correct token logo and amount precision without needing a separate lookup. The `bySender`/`byRecipient` indexes cover all tokens in one contract — no per-token sharding needed at this usage scale.

---

## Proposed PrivateTip.cdc v0.8 Architecture

```cadence
// PrivateTip.cdc — v0.8 minimal metadata index.
//
// Deployed at: 0x4b6bc58bc8bf5dcc (openjanus-v08).
// NOT an upgrade of 0xb9ac529c14a4c5a1 — new account, clean state.
//
// Privacy model:
//   - Amount per tip:     HIDDEN (lives in ShieldedInbox cipher)
//   - Memo content:       HIDDEN (lives in ShieldedInbox cipher)
//   - Sender/recipient:   VISIBLE (public linkage is PrivateTip's stated trade-off)
//   - Token type:         VISIBLE (via tokenContract field)
//
// No resources, no encrypted blobs, no escrow vaults, no impl swap machinery.

access(all) contract PrivateTip {

    // ─── Entitlements ──────────────────────────────────────────────────────────
    access(all) entitlement Pause

    // ─── Storage paths ─────────────────────────────────────────────────────────
    access(all) let AdminStoragePath: StoragePath

    // ─── State ─────────────────────────────────────────────────────────────────
    access(self) var nextTipID:    UInt64
    access(self) var byTipID:      {UInt64: TipMetadata}
    access(self) var bySender:     {Address: [UInt64]}
    access(self) var byRecipient:  {Address: [UInt64]}
    access(self) var paused:       Bool

    // ─── Structs ───────────────────────────────────────────────────────────────
    access(all) struct TipMetadata {
        access(all) let tipID:         UInt64
        access(all) let sender:        Address
        access(all) let recipient:     Address
        access(all) let timestamp:     UFix64
        access(all) let tokenContract: Address  // JanusFlow/JanusERC20/JanusFT proxy address

        init(tipID: UInt64, sender: Address, recipient: Address,
             timestamp: UFix64, tokenContract: Address) {
            self.tipID = tipID; self.sender = sender; self.recipient = recipient
            self.timestamp = timestamp; self.tokenContract = tokenContract
        }
    }

    // ─── Events ────────────────────────────────────────────────────────────────
    access(all) event TipRecorded(
        tipID: UInt64, sender: Address, recipient: Address, tokenContract: Address
    )
    access(all) event Paused()
    access(all) event Unpaused()

    // ─── Admin resource ────────────────────────────────────────────────────────
    access(all) resource AdminResource {
        access(Pause) fun pause()   { pre { !PrivateTip.paused }; PrivateTip.paused = true;  emit Paused() }
        access(Pause) fun unpause() { pre { PrivateTip.paused  }; PrivateTip.paused = false; emit Unpaused() }
    }

    // ─── Write ─────────────────────────────────────────────────────────────────

    /// Called from combined tip transaction after shieldedTransfer completes.
    /// Both must succeed or the Cadence transaction aborts — atomicity guaranteed.
    access(all) fun recordTip(
        sender:        auth(BorrowValue) &Account,
        recipient:     Address,
        tokenContract: Address
    ): UInt64 {
        pre { !self.paused: "PrivateTip: paused" }

        let tipID    = self.nextTipID
        let metadata = TipMetadata(
            tipID: tipID, sender: sender.address, recipient: recipient,
            timestamp: getCurrentBlock().timestamp, tokenContract: tokenContract
        )
        self.nextTipID = self.nextTipID + 1
        self.byTipID[tipID] = metadata

        if let ids = self.bySender[sender.address] {
            self.bySender[sender.address] = ids.concat([tipID])
        } else { self.bySender[sender.address] = [tipID] }

        if let ids = self.byRecipient[recipient] {
            self.byRecipient[recipient] = ids.concat([tipID])
        } else { self.byRecipient[recipient] = [tipID] }

        emit TipRecorded(tipID: tipID, sender: sender.address,
                         recipient: recipient, tokenContract: tokenContract)
        return tipID
    }

    // ─── Read ──────────────────────────────────────────────────────────────────
    access(all) view fun getTip(tipID: UInt64): TipMetadata? { return self.byTipID[tipID] }
    access(all) view fun getTotalCount(): UInt64 { return self.nextTipID - 1 }
    access(all) view fun isPaused(): Bool { return self.paused }

    access(all) fun getTipsBySender(sender: Address): [TipMetadata] {
        let ids = self.bySender[sender] ?? []
        var out: [TipMetadata] = []
        for id in ids { if let m = self.byTipID[id] { out.append(m) } }
        return out
    }

    access(all) fun getTipsByRecipient(recipient: Address): [TipMetadata] {
        let ids = self.byRecipient[recipient] ?? []
        var out: [TipMetadata] = []
        for id in ids { if let m = self.byTipID[id] { out.append(m) } }
        return out
    }

    // ─── Init ──────────────────────────────────────────────────────────────────
    init() {
        self.AdminStoragePath = /storage/privateTipAdmin
        self.nextTipID = 1
        self.byTipID = {}; self.bySender = {}; self.byRecipient = {}
        self.paused = false
        self.account.storage.save(<-create AdminResource(), to: self.AdminStoragePath)
    }
}
```

**Comparison to current PrivateTip.cdc (790 lines):** The v0.8 contract is approximately 90 lines. The delta is entirely compat baggage that no longer applies at the new account.

---

## Action Plan for PrivateTip Sprint

### Phase 1: New PrivateTip.cdc + Cadence templates (~2–3h)

1. Write `cadence/contracts/PrivateTip.cdc` (v0.8 minimal, ~90 lines per design above)
2. Delete `IPrivateTipImpl.cdc`, `PrivateTipImpl.cdc`
3. Write Cadence transactions (new `cadence/transactions/` directory):
   - `install_inbox_checkpoint.cdc` — install `@ShieldedInbox.NoteInbox` + `@ShieldedCheckpoint.Checkpoint` (idempotent)
   - `send_shielded_tip_flow.cdc` — COA submits JanusFlow EVM 6-arg shieldedTransfer calldata + calls `PrivateTip.recordTip`
   - `send_shielded_tip_musdc.cdc` — same for JanusERC20 (mUSDC)
   - `send_shielded_tip_mockft.cdc` — Cadence-native JanusFT shieldedTransfer + recordTip
   - `update_checkpoint.cdc` — sender updates ShieldedCheckpoint via COA after transfer
4. Write Cadence scripts (new `cadence/scripts/` directory):
   - `get_tip.cdc`, `get_tips_by_sender.cdc`, `get_tips_by_recipient.cdc`
   - `get_inbox_count.cdc`, `get_checkpoint_metadata.cdc`
5. Rewrite `admin-transactions/admin_pause.cdc` (new import, new address)
6. Rewrite `admin-transactions/setup_account.cdc` (four-step onboarding: COA + Inbox + Checkpoint + MemoKey)
7. Rewrite `admin-transactions/setup_memo_key.cdc` (new MemoKeyRegistry address)
8. Delete: `admin_drain_legacy_vault.cdc`, `admin_force_set_impl_version.cdc`, `admin_upgrade.cdc`, `jf_unwrap.cdc`, `jf_unwrap_to_vault.cdc`, `jf_wrap.cdc`, `jf_wrap_from_coa.cdc`, `.tmp_test_script.cdc`

### Phase 2: Deploy to v0.8 account `0x4b6bc58bc8bf5dcc` (~30min)

1. Rewrite `flow.json`:
   - Add `PrivateTip` contract entry (source: new .cdc, alias testnet: `4b6bc58bc8bf5dcc`)
   - Add dependency aliases for `JanusFT`, `ShieldedInbox`, `ShieldedCheckpoint` at `0x4b6bc58bc8bf5dcc`
   - Update account entry `openjanus-v08` with address `4b6bc58bc8bf5dcc`
   - Remove `IPrivateTipImpl`, `PrivateTipImpl` from deployments
   - Keep `openjanus-privatetip-router` entry for reference (do NOT redeploy)
2. `flow accounts add-contract PrivateTip cadence/contracts/PrivateTip.cdc --network testnet --signer openjanus-v08`
3. Verify: `flow scripts execute cadence/scripts/get_tip.cdc 0 --network testnet`

### Phase 3: Build scripts/01-99 using SDK v0.8 (~4–5h)

Pattern: each script uses `ethers` + `flow` CLI subprocess, following `combo-B.cjs` structure.

| Script | What it does |
|--------|-------------|
| `scripts/01-onboarding.cjs` | Derives BabyJub keypair; submits `setup_account.cdc` (COA + Inbox + Checkpoint); calls `MemoKeyRegistry.publishMemoKey` via EVM; verifies all four resources installed |
| `scripts/02-send-tip-flow.cjs` | SDK `JanusFlowAdapter.wrap()` + `shieldedTransfer()` → submit `send_shielded_tip_flow.cdc` (COA calldata + recordTip) → submit `update_checkpoint.cdc`; print tipID |
| `scripts/03-send-tip-musdc.cjs` | Same pattern for `JanusERC20Adapter` (mUSDC); includes ERC20 `mint + approve` preflight |
| `scripts/04-send-tip-mockft.cjs` | `JanusFTAdapter` — pure Cadence path; submit `send_shielded_tip_mockft.cdc` |
| `scripts/05-claim-tips.cjs` | `ShieldedInboxClient.drainAndDecrypt()` via COA; decode each note (`amt`, `memo`); correlate with `PrivateTip.getTipsByRecipient` for tipID lookup; print table |
| `scripts/06-sender-history.cjs` | `ShieldedCheckpointClient.readAndDecrypt()` to recover own balance; `PrivateTip.getTipsBySender` for sent tipIDs; print summary |
| `scripts/07-unwrap.cjs` | SDK `JanusFlowAdapter.unwrap()` (amount-disclose proof + EVM unwrap calldata via COA); print unwrapped amount |
| `scripts/99-e2e-full-cycle.cjs` | Shell-calls scripts 01–07 in sequence with assertion checkpoints; exits non-zero on first failure; prints PASS/FAIL per step |

### Phase 4: E2E full cycle + commits (~1h)

1. Run `scripts/99-e2e-full-cycle.cjs` against testnet
2. Verify: Inbox drained, PrivateTip tipIDs match, Checkpoint readable, unwrap settles
3. Commit on `feat/v0.8-fresh` branch

---

## Estimated Total: ~8–9 hours

| Phase | Estimate |
|-------|----------|
| Phase 1: Cadence contract + templates | 2–3h |
| Phase 2: Deploy | 30min |
| Phase 3: SDK scripts (01–99) | 4–5h |
| Phase 4: E2E + cleanup | 1h |

---

## Files to Delete

- `cadence/contracts/IPrivateTipImpl.cdc`
- `cadence/contracts/PrivateTipImpl.cdc`
- `admin-transactions/admin_drain_legacy_vault.cdc`
- `admin-transactions/admin_force_set_impl_version.cdc`
- `admin-transactions/admin_upgrade.cdc`
- `admin-transactions/jf_unwrap.cdc`
- `admin-transactions/jf_unwrap_to_vault.cdc`
- `admin-transactions/jf_wrap.cdc`
- `admin-transactions/jf_wrap_from_coa.cdc`
- `.tmp_test_script.cdc`

---

## New Files to Create

### Cadence contracts (rewrite)
- `cadence/contracts/PrivateTip.cdc` (v0.8 metadata-only, ~90 lines)

### Cadence transactions (new directory)
- `cadence/transactions/install_inbox_checkpoint.cdc`
- `cadence/transactions/send_shielded_tip_flow.cdc`
- `cadence/transactions/send_shielded_tip_musdc.cdc`
- `cadence/transactions/send_shielded_tip_mockft.cdc`
- `cadence/transactions/update_checkpoint.cdc`

### Cadence scripts (new directory)
- `cadence/scripts/get_tip.cdc`
- `cadence/scripts/get_tips_by_sender.cdc`
- `cadence/scripts/get_tips_by_recipient.cdc`
- `cadence/scripts/get_inbox_count.cdc`
- `cadence/scripts/get_checkpoint_metadata.cdc`

### Admin transactions (rewrite in place)
- `admin-transactions/admin_pause.cdc` (new import address)
- `admin-transactions/setup_account.cdc` (four-step: COA + Inbox + Checkpoint + MemoKey)
- `admin-transactions/setup_memo_key.cdc` (new MemoKeyRegistry at `0x361bD4d037838A3a9c5408AE465d36077800ee6c`)

### SDK orchestration scripts (new directory)
- `scripts/01-onboarding.cjs`
- `scripts/02-send-tip-flow.cjs`
- `scripts/03-send-tip-musdc.cjs`
- `scripts/04-send-tip-mockft.cjs`
- `scripts/05-claim-tips.cjs`
- `scripts/06-sender-history.cjs`
- `scripts/07-unwrap.cjs`
- `scripts/99-e2e-full-cycle.cjs`

### Config
- `flow.json` (rewrite: new account + v0.8 contract aliases)

---

## v0.8 Address Reference (sprint cheat-sheet)

| Contract | Network | Address |
|----------|---------|---------|
| PrivateTip v0.8 (new deploy target) | Cadence testnet | `0x4b6bc58bc8bf5dcc` |
| JanusFT, ShieldedInbox, ShieldedCheckpoint, MockFT | Cadence testnet | `0x4b6bc58bc8bf5dcc` |
| JanusFlow proxy (EVM) | Flow EVM testnet | `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3` |
| JanusERC20 proxy (EVM) | Flow EVM testnet | `0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d` |
| ShieldedInbox (EVM) | Flow EVM testnet | `0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6` |
| ShieldedCheckpoint (EVM) | Flow EVM testnet | `0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76` |
| MemoKeyRegistry (EVM) | Flow EVM testnet | `0x361bD4d037838A3a9c5408AE465d36077800ee6c` |
| MockUSDC (EVM) | Flow EVM testnet | `0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524` |
| **DO NOT TOUCH** — live demo | Cadence testnet | `0xb9ac529c14a4c5a1` |
