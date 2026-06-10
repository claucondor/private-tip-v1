#!/usr/bin/env node
"use strict";
/**
 * 10-learn.cjs — Protocol reference dump (front view: /learn)
 *
 * Outputs comprehensive protocol documentation as JSON:
 *   - Contract addresses + roles
 *   - Token IDs + decimals
 *   - Script CLI reference
 *   - Privacy model summary
 *   - Key SDK exports
 *
 * No arguments required. Completely static — no network calls.
 *
 * Usage:
 *   node scripts/10-learn.cjs
 *
 * Output JSON: self-describing reference document.
 */

const { jsonOutput } = require("./_shared.cjs");

const REFERENCE = {
  _version: "0.8.0",
  _generated: new Date().toISOString(),

  protocol: {
    name:        "PrivateTip + OpenJanus",
    description: "Shielded tip platform built on Flow EVM + Cadence. " +
                 "Amounts are hidden via 2-generator Pedersen commitments and Groth16 ZK proofs. " +
                 "Only sender, recipient, and token type are public on-chain.",
    privacyModel: {
      hidden:  ["transfer amount", "blinding factor", "memo content"],
      visible: ["sender address", "recipient address", "token contract", "tip existence"],
    },
    tokenPath: {
      FLOW:   "EVM: JanusFlow.wrapWithProof → shieldedTransfer → unwrap",
      mUSDC:  "EVM: JanusERC20.wrapWithProof → shieldedTransfer → unwrap (ERC20 approve required)",
      MockFT: "Cadence: JanusFT.wrapWithProof → shieldedTransfer → unwrap (Cadence FT path)",
    },
  },

  addresses: {
    chainId: 545,
    evm: {
      janusFlow:          "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
      janusERC20:         "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
      mockUSDC:           "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
      memoKeyRegistry:    "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
      shieldedInbox:      "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
      shieldedCheckpoint: "0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76",
      transferVerifier:   "0x38e69fE7Ba7c2C586d64DFFc14742641A675666c",
      amountDiscloseVerifier: "0xf7B634D41259D0613345633eE1CD193A030A6329",
      deployerCOA:        "0x0000000000000000000000020885d7ad3582356a",
    },
    cadence: {
      deployer:    "0x4b6bc58bc8bf5dcc",
      contracts:   ["JanusFT", "MockFT", "ShieldedInbox", "ShieldedCheckpoint", "PrivateTip"],
    },
  },

  tokens: {
    flow: {
      symbol:     "FLOW",
      variant:    "native",
      decimals:   18,
      proxy:      "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
      wrap:       "SDK: sdk.token('flow').wrap({ grossAmount }, wallet)",
      transfer:   "SDK: sdk.token('flow').shieldedTransfer({ recipient, amount, memo, currentBalance, currentBlinding }, wallet)",
      unwrap:     "SDK: sdk.token('flow').unwrap({ claimedAmount, recipient, currentBalance, currentBlinding }, wallet)",
    },
    musdc: {
      symbol:     "mUSDC",
      variant:    "erc20",
      decimals:   6,
      underlying: "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
      proxy:      "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
      note:       "Approve JanusERC20 proxy before wrap. SDK handles this via adapter.approveUnderlying().",
    },
    mockft: {
      symbol:     "MockFT",
      variant:    "cadence-ft",
      decimals:   8,
      cadenceAddr:"0x4b6bc58bc8bf5dcc",
      contractName:"JanusFT",
      note:       "Cadence FT path. Operations use Flow CLI or FCL. Not directly callable from EVM-only wallet.",
    },
  },

  scripts: {
    "01-activate": {
      description: "Onboard a user: publish BabyJub memo key + install ShieldedInbox + ShieldedCheckpoint",
      args:   "--evm-key <hex> [--cadence-account <name>] [--evm-only]",
      output: "{ evmAddr, memokey: {x, y, publishedAt}, inboxInstalled, checkpointInstalled }",
    },
    "02-portfolio": {
      description: "Read shielded state: on-chain commitments + checkpoint balance + inbox pending count",
      args:   "--evm-key <hex> [--memokey-priv <decimal>]",
      output: "{ evmAddr, checkpoint, flow, musdc, mockft, inbox }",
    },
    "03-wrap": {
      description: "Wrap underlying → shielded commitment. Updates ShieldedCheckpoint automatically.",
      args:   "--token <flow|musdc|mockft> --amount <decimal> --evm-key <hex>",
      output: "{ token, grossAmount, netAmount, fee, wrapTxHash, checkpointTxHash, newBalance, newBlinding, commitment }",
    },
    "04-send-tip": {
      description: "Send shielded tip: zero-knowledge transfer to recipient's inbox",
      args:   "--token <flow|musdc> --evm-key <hex> --to <0xEVM> --amount <decimal> [--memo text] [--current-balance <bigint>] [--current-blinding <bigint>]",
      output: "{ tipId, token, evm: { txHash, recipient, amount, newBalance, checkpointTxHash }, cadence }",
    },
    "05-tips-received": {
      description: "Read/drain ShieldedInbox, decrypt notes, correlate with PrivateTip metadata",
      args:   "--receiver-evm <0x...> --memokey-priv <decimal> [--evm-key <hex> for drain] [--peek]",
      output: "{ receiverEvm, pendingCount, mode, notes: [{ tokenSymbol, amount, blinding, memo, tipMeta }] }",
    },
    "06-tips-sent": {
      description: "List tips sent, with PrivateTip metadata (tipID, recipient, token, timestamp)",
      args:   "--sender-cadence <0x...> [--evm-key <hex>] [--memokey-priv <decimal>]",
      output: "{ senderCadence, tipsSent: [{ tipId, recipient, tokenSymbol, timestamp }], currentShieldedState }",
    },
    "07-unwrap": {
      description: "Unwrap shielded balance → underlying (two-proof flow: amount-disclose + transfer)",
      args:   "--token <flow|musdc> --amount <decimal> --evm-key <hex> [--recipient <0x...>]",
      output: "{ token, claimedAmount, recipient, unwrapTxHash, netToRecipient, residualBalance }",
    },
    "08-status": {
      description: "Protocol health: contract versions, total locked, total tips, block number",
      args:   "(none)",
      output: "{ protocolVersion, chainId, contracts: { janusFlow, janusERC20, ..., privateTip }, network }",
    },
    "09-faucet": {
      description: "Testnet helper: mint mUSDC (ERC20) and/or MockFT (Cadence) to a target address",
      args:   "--to-evm <0x...> [--musdc-amount <N>] [--to-cadence <0x...>] [--mockft-amount <N>]",
      output: "{ toEvm, toCadence, musdc: { txHash }, mockft: { txId } }",
    },
    "10-learn": {
      description: "Protocol reference: addresses, token IDs, privacy model, script CLI docs",
      args:   "(none)",
      output: "this document",
    },
    "99-e2e-full-cycle": {
      description: "End-to-end integration test: activate → wrap → send → receive → unwrap",
      args:   "[--alice-key <hex>] [--bob-key <hex>] [--verbose]",
      output: "{ stages: [ { name, success, txHash, error } ], allPassed }",
    },
  },

  keyManagement: {
    memoKey: {
      what:    "BabyJubJub keypair used for ECIES note encryption/decryption",
      derive:  "const sig = await wallet.signMessage('OpenJanus MemoKey v1'); const kp = deriveMemoKeyFromSignature(ethers.getBytes(sig));",
      publish: "sdk.token('flow').publishMemoKey(keypair, wallet)",
      read:    "sdk.token('flow').getMemoKey(address)",
      note:    "One keypair covers all tokens (shared MemoKeyRegistry). Never store privkey.",
    },
    checkpoint: {
      what:   "Encrypted on-chain state store for sender balance recovery",
      read:   "new ShieldedCheckpointClient().readAndDecrypt(wallet, memoPrivKey)",
      write:  "new ShieldedCheckpointClient().update(checkpointPayload, cursor, wallet)",
      note:   "checkpointPayload comes from adapter.shieldedTransfer() SendResult",
    },
    inbox: {
      what:   "Per-user on-chain mailbox. Notes deposited atomically on shieldedTransfer.",
      drain:  "new ShieldedInboxClient().drainAndDecrypt(wallet, memoPrivKey)",
      peek:   "new ShieldedInboxClient().peekAll(address)",
      note:   "Must install Cadence NoteInbox resource before receiving MockFT notes",
    },
  },

  sdkPublicAPI: [
    "sdk.token(id)                        — get adapter for 'flow' | 'mockusdc' | 'mockft'",
    "adapter.wrap(params, wallet)         — wrap underlying into shielded",
    "adapter.shieldedTransfer(params, w)  — shielded transfer to recipient",
    "adapter.unwrap(params, wallet)       — unwrap shielded to underlying",
    "adapter.publishMemoKey(kp, wallet)   — register BabyJub pubkey",
    "adapter.getMemoKey(address)          — read registered pubkey",
    "adapter.getCommitment(address)       — read on-chain Pedersen commitment",
    "ShieldedInboxClient                  — drain + decrypt incoming notes",
    "ShieldedCheckpointClient             — read/write encrypted sender state",
    "deriveMemoKeyFromSignature(sigBytes) — deterministic keypair from wallet signature",
    "decryptNote(cipher, eph, privkey)    — decrypt a single inbox note",
    "decryptSnapshot(cipher, eph, priv)  — decrypt a checkpoint snapshot",
    "encryptSnapshot(snapshot, pubkey)   — encrypt for checkpoint update",
  ],
};

jsonOutput(REFERENCE);
