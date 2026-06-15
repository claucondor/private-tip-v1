# C.1 Browser Smoke Checklist

Manual steps to run on next `npm run dev` start from `web/`.

## Pre-flight
- [ ] `npm run dev` starts clean, no console errors on load

## /portfolio
- [ ] Page loads for connected wallet (no JS crash)
- [ ] FLOW row shows "Shielded" balance (from per-token checkpoint, NOT duplicated)
- [ ] mUSDC row shows "Shielded" balance independently (different value from FLOW)
- [ ] MockFT row shows `—` with `(beta — Cadence path)` label
- [ ] Hovering MockFT shielded cell shows tooltip: "Cadence per-token checkpoint deferred — see release notes for v0.8.3"

## /wrap (FLOW)
- [ ] Wrap page loads for FLOW token
- [ ] Existing FLOW shielded balance is read correctly from new per-token checkpoint
- [ ] Wrap of 1 FLOW succeeds and tx hash appears in success panel
- [ ] After wrap, returning to /portfolio shows updated FLOW shielded balance
- [ ] mUSDC shielded balance in /portfolio is UNCHANGED after FLOW wrap (per-token isolation confirmed)
