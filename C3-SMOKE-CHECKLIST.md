# C.3 Browser Smoke Checklist

## /claim (FLOW)
- [ ] Token selector defaults to FLOW (visible above balance card)
- [ ] BatchClaimCTA visible only when inbox has ≥ 5 FLOW notes (filtered by JanusFlow depositor)
- [ ] Generate proof + claim batch — success with tx hash (Flowscan link)
- [ ] After claim, /portfolio FLOW shielded balance updated

## /claim (mUSDC)
- [ ] Switch token to mUSDC — token selector at top updates label
- [ ] Inbox count shows mUSDC-deposited notes (filtered by JanusERC20 depositor)
- [ ] Generate proof + claim batch — success with tx hash
- [ ] /portfolio mUSDC balance updated

## /claim (MockFT)
- [ ] Switch to MockFT — amber "MockFT — Cadence singleton checkpoint" banner visible above balance card
- [ ] BatchClaimCTA shows "MockFT batch claim — deferred (see v0.8.3)" banner instead of claim flow
- [ ] Claim batch button absent (deferred banner replaces it)
- [ ] Unwrap form still present and functional for MockFT (unwrapActionLegacy handles it)

## /claim — unwrap form (all tokens)
- [ ] Token selector at TOP of page (before balance card) — no duplicate inside form
- [ ] Switching token updates balance display (or "Can't see your balance" if no stored state)
- [ ] Amount input, fee disclosure, and unwrap button work correctly per-token

## /faucet
- [ ] Page loads without errors
- [ ] Mint FLOW button works (wallet balance increases)
- [ ] Mint mUSDC button works (wallet balance increases)
- [ ] Mint MockFT button disabled until "Setup MockFT receiver" vault created
- [ ] Setup MockFT receiver button works (one-time vault creation)
- [ ] "Claim all" quick-buttons send all 3 tokens (respecting setup state for MockFT)
- [ ] Success panel shows Flowscan link per token

## /learn
- [ ] Page loads without broken layout
- [ ] All 4 tabs render (How it works / Compare / Architecture / Roadmap)
- [ ] Architecture tab: "v0.8.2 — Multi-token isolation fix" callout visible
- [ ] Callout mentions: BabyJubJub + Groth16, per-token isolation, Cross-VM COA, v0.8.3 gap
- [ ] Header shows "Updated June 2026 (v0.8.2)"
- [ ] Animations (Pedersen interactive, Sign-derive, Account vs UTXO) work
