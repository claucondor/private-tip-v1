# PrivateTip

Native-FLOW tipping on Flow Cadence with named tips, optional public memos, and
custody held by a router contract until claimed.

> **Sprint status (v0.2.1, Phase 7)**: PrivateTip was rebuilt as a router/impl pair
> to fix vulnerability 015 (`claimTip` used `self.account.address` instead of the
> transaction signer; only the deployer could claim, and the deployer could claim
> anyone's tips). See [`.opencode/plans/PLAN.md`](./.opencode/plans/PLAN.md) and
> the per-task stories under `.opencode/plans/stories/` (T13–T21 are the Phase 7
> entries). The earlier T11 blocker is preserved as evidence of how the upstream
> vuln 014 was discovered during smoke testing.

## Current testnet deployment

| Contract                | Address                                              |
|-------------------------|------------------------------------------------------|
| `PrivateTip.cdc` router | `0xb9ac529c14a4c5a1`                                 |
| `PrivateTipImpl.cdc`    | `0xb9ac529c14a4c5a1`                                 |
| `IPrivateTipImpl.cdc`   | `0xb9ac529c14a4c5a1`                                 |

Deprecated, do not use: `0xd807a3992d7be612` (the original monolith — vuln 015).

## What it does

A sender calls `PrivateTip.sendTip(signer, recipient, payment, memo)`. The
router moves the `@FlowToken.Vault` into per-tip custody (`@{UInt64:
FlowToken.Vault}`) and records the metadata. The recipient later calls
`claimTip(signer, tipID)` and the router returns the vault — but only if
`signer.address == tip.recipient`. Cadence enforces that the `auth(BorrowValue)
&Account` reference can only be constructed for the actual transaction signer.

This separation gives you:

- A tip ledger you can iterate (`getTipsByRecipient`, `getTipsBySender`).
- Native-FLOW custody until the recipient claims, no escrow service needed.
- An emergency pause + 48h time-locked impl swap (in case the validation logic
  itself ever needs a fix).
- Composition with the rest of OpenJanus: amounts are intentionally on-chain in
  this layer; use `JanusFlow` + `JanusToken` (Layer 1/2) when you want the
  amount cryptographically hidden as well.

## Repo layout

See [`.opencode/plans/PLAN.md`](./.opencode/plans/PLAN.md) for the complete
phase/story breakdown and [`canonical-addresses.md`](https://github.com/openjanus/openjanus-ai-tools/blob/main/plugins/openjanus/skills/openjanus-deploy/references/canonical-addresses.md)
in `openjanus-ai-tools` for the cross-repo deprecated-address table.

```
cadence/
├── contracts/         IPrivateTipImpl.cdc, PrivateTipImpl.cdc, PrivateTip.cdc
├── transactions/      send_tip, claim_tips, admin_pause, admin_upgrade, +helpers
└── scripts/           read-only queries
scripts/
└── test-router-claim.mjs   functional test (vuln 015 verification)
flow.json
```

## Quick start

```bash
# Charlie sends Alice 1.5 FLOW with a memo
flow transactions send cadence/transactions/send_tip.cdc \
  --args-json '[
    {"type":"Address","value":"0x7599043aea001283"},
    {"type":"UFix64","value":"1.50000000"},
    {"type":"String","value":"hello alice"}
  ]' \
  --signer testnet-charlie --network testnet --gas-limit 9999

# Alice claims tipID 3
flow transactions send cadence/transactions/claim_tips.cdc \
  --args-json '[{"type":"Array","value":[{"type":"UInt64","value":"3"}]}]' \
  --signer testnet-claucondor --network testnet --gas-limit 9999

# Re-run the functional test (proves vuln 015 fix)
node scripts/test-router-claim.mjs
```

## Off-chain SDK

The TypeScript SDK lives at [`@openjanus/sdk`](https://www.npmjs.com/package/@openjanus/sdk).
Starting from `0.2.1` the SDK ships the new JanusToken proxy address, the new
JanusFlow router address, and helpers for FLOW unit conversion + BabyJubJub
random scalars. PrivateTip is currently exposed via raw Cadence transactions;
a typed wrapper class is a follow-up.

## Security notes

- **Vuln 015 fix (this sprint)**: `claimTip` authorization is now signer-bound
  via `auth(BorrowValue) &Account`. Non-recipients can no longer claim, and the
  deployer no longer has implicit claim rights.
- **Amount privacy is NOT a property of this contract.** Sender, recipient,
  amount and memo are visible on chain. For confidential amounts, compose with
  the JanusFlow router. PrivateTip is the "named tips" UX layer.
- **Admin model**: `AdminResource` with `Pause | Upgrade` entitlements is
  currently in the router's own storage. Multisig delegation is a follow-up.
- **Impl swap**: 48h time-lock from `proposeImplSwap` to `finalizeImplSwap`.
  Cancellation is immediate (no lock).
