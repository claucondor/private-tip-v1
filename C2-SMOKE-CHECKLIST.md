# C.2 — /send and /tips Smoke Checklist

Manual steps to run on next `npm run dev` start from `web/`.

## /send (FLOW)

- [ ] Token selector defaults to FLOW
- [ ] Page loads in "loading_balance" state, then resolves to "idle" (shielded balance shown) or "needs_unlock" (if memoPrivkey not cached)
- [ ] "Needs unlock" screen shows — click "Unlock (1 wallet signature)" — triggers memokey derivation — balance loads
- [ ] Recipient + amount valid form submits
- [ ] Success panel shows tx hash (Cadence tx ID) + "FLOW" label
- [ ] /portfolio after send — FLOW shielded balance decreased

## /send (mUSDC)

- [ ] Switch token selector to mUSDC
- [ ] "Loading balance" shows, then resolves to mUSDC shielded balance (not FLOW)
- [ ] Available balance shows mUSDC shielded balance
- [ ] Send 1 mUSDC to recipient — tx success
- [ ] Success panel shows "mUSDC" label
- [ ] /portfolio after — mUSDC balance decreased, FLOW unchanged

## /send (MockFT)

- [ ] Switch to MockFT — singleton-limitation banner visible (amber warning)
- [ ] Send still submits (may fail at proof/contract level — known v0.8.2 limitation)
- [ ] If send succeeds: tx hash shown in success panel with "MockFT" label
- [ ] (Known: shielded balance reading post-send may reflect singleton last-write)

## /tips

- [ ] Page loads with 3 sections: "FLOW tips received" / "mUSDC tips received" / "MockFT tips received"
- [ ] Each section shows correct depositor-filtered note count
- [ ] FLOW and mUSDC sections load inbox notes from ShieldedInboxClient.peekAll()
- [ ] MockFT section shows Cadence-path note explaining EVM inbox not applicable
- [ ] Click "Reveal amount" on an encrypted FLOW note → prompts wallet sign if needed → decrypts amount
- [ ] Decrypted note shows amount in correct decimals (18d for FLOW, 6d for mUSDC)
- [ ] Memo field shown if present in decrypted NoteContent
- [ ] Empty section shows "No tips received for X yet"
- [ ] Refresh button triggers re-fetch of inbox notes
- [ ] Historical Cadence-contract tips still visible in "Tip history" section below

## /status

- [ ] Page renders 3 CheckpointStatus rows: FLOW / mUSDC / MockFT
- [ ] FLOW row: shows checkpoint version + block if installed, "No shielded state yet" if not
- [ ] mUSDC row: shows checkpoint version + block if installed (independent from FLOW)
- [ ] MockFT row: shows "No shielded state yet (singleton — v0.8.3)" (correct — no EVM checkpoint for cadence-ft)
- [ ] Each row label prefixes token name: "FLOW: Checkpoint v3 · block 1234"

## tip-actions.ts routing

- [ ] sendTip native (FLOW): cadenceTx.sendTipAtomic uses FLOW proxy (from entry.proxy, not hardcoded TOKEN_PROXIES.flow)
- [ ] unwrapToken native (FLOW): cadenceTx.unwrapFlowAtomic uses FLOW proxy (from entry.proxy)
- [ ] sendTip cadence-ft (MockFT): console.warn emitted about singleton overwrite
