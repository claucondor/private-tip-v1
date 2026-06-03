/**
 * PrivateTip v0.6 E2E Smoke Test — multi-token SDK 0.6.5
 *
 * Tests the full wrap → shieldedTransfer → decrypt → unwrap cycle
 * across all 4 tokens (flow, wflow, mockusdc, mockft).
 *
 * Requirements:
 *   ALICE_EVM_PKEY — Alice's EVM private key (has COA + MemoKey published)
 *   BOB_EVM_PKEY   — Bob's EVM private key (has COA + MemoKey published)
 *   ALICE_FLOW_ADDR — Alice's Flow Cadence address
 *   BOB_FLOW_ADDR   — Bob's Flow Cadence address
 *
 * Usage:
 *   npx ts-node --transpile-only web/e2e/smoke.test.ts
 *   # or: node --loader ts-node/esm web/e2e/smoke.test.ts
 */

import { sdk, decryptNote } from "@claucondor/sdk";
import { createEvmWallet, getCoaEvmAddress, configureFCL } from "@claucondor/sdk/network";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ESM __dirname shim.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALICE_FLOW_ADDR = process.env.ALICE_FLOW_ADDR ?? "0x7599043aea001283";  // lab alice
const BOB_FLOW_ADDR   = process.env.BOB_FLOW_ADDR   ?? "0xd807a3992d7be612";  // bob

const ALICE_EVM_PKEY = process.env.ALICE_EVM_PKEY ?? "";
const BOB_EVM_PKEY   = process.env.BOB_EVM_PKEY   ?? "";

// A deterministic test memo privkey (from known sig bytes — for non-wallet smoke test).
// In real app this comes from wallet signature.
const TEST_MEMO_PRIVKEY_ALICE = BigInt("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
const TEST_MEMO_PRIVKEY_BOB   = BigInt("0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321");

// Small wrap amounts (in each token's native units).
const WRAP_AMOUNTS: Record<string, bigint> = {
  flow:     1n * 10n ** 18n,   // 1 FLOW
  wflow:    1n * 10n ** 18n,   // 1 WFLOW
  mockusdc: 1n * 10n ** 6n,   // 1 mUSDC
  mockft:   1n * 10n ** 8n,   // 1 MockFT
};

const SEND_AMOUNTS: Record<string, bigint> = {
  flow:     5n * 10n ** 17n,  // 0.5 FLOW
  wflow:    5n * 10n ** 17n,
  mockusdc: 5n * 10n ** 5n,   // 0.5 mUSDC
  mockft:   5n * 10n ** 7n,   // 0.5 MockFT
};

interface TokenTestResult {
  token: string;
  wrapStatus: "PASS" | "FAIL" | "SKIP";
  sendStatus: "PASS" | "FAIL" | "SKIP";
  decryptStatus: "PASS" | "FAIL" | "SKIP";
  unwrapStatus: "PASS" | "FAIL" | "SKIP";
  wrapTxHash?: string;
  sendTxHash?: string;
  unwrapTxHash?: string;
  error?: string;
}

async function checkPreConditions(): Promise<boolean> {
  if (!ALICE_EVM_PKEY || !BOB_EVM_PKEY) {
    console.warn("[smoke] No EVM private keys provided. Running API surface check only.");
    return false;
  }
  return true;
}

async function runSmokeTest(): Promise<void> {
  // Configure FCL before any operations.
  await configureFCL("testnet");

  console.log("=== PrivateTip v0.6 Multi-Token Smoke Test ===");
  console.log(`SDK tokens available: ${sdk.tokens().join(", ")}`);

  const canRunTx = await checkPreConditions();

  const results: TokenTestResult[] = [];
  const tokenIds = ["flow", "wflow", "mockusdc", "mockft"] as const;

  for (const tokenId of tokenIds) {
    console.log(`\n--- Token: ${tokenId} ---`);
    const result: TokenTestResult = {
      token: tokenId,
      wrapStatus: "SKIP",
      sendStatus: "SKIP",
      decryptStatus: "SKIP",
      unwrapStatus: "SKIP",
    };

    try {
      const adapter = sdk.token(tokenId);
      console.log(`  Adapter: ${adapter.id} (variant=${adapter.variant}, decimals=${adapter.decimals})`);

      // Verify getMemoKey API works (read-only).
      try {
        const aliceCoa = await getCoaEvmAddress(ALICE_FLOW_ADDR);
        const memoKey = await adapter.getMemoKey(
          adapter.variant === "cadence-ft" ? ALICE_FLOW_ADDR : aliceCoa
        );
        console.log(`  Alice MemoKey: ${memoKey ? `(${memoKey.x.toString(16).slice(0,8)}…)` : "null"}`);

        if (!memoKey) {
          result.wrapStatus = "SKIP";
          result.error = "Alice has no MemoKey — run setup first";
          results.push(result);
          continue;
        }
      } catch (err) {
        console.warn(`  MemoKey read failed: ${err}`);
        result.error = `MemoKey read: ${err}`;
        results.push(result);
        continue;
      }

      if (!canRunTx) {
        result.wrapStatus = "SKIP";
        result.sendStatus = "SKIP";
        result.decryptStatus = "SKIP";
        result.unwrapStatus = "SKIP";
        results.push(result);
        continue;
      }

      const aliceWallet = await createEvmWallet(ALICE_EVM_PKEY, "testnet");
      const bobWallet   = await createEvmWallet(BOB_EVM_PKEY, "testnet");

      // Alice's memoKeypair (for snapshot encryption).
      const aliceMemo = { privkey: TEST_MEMO_PRIVKEY_ALICE, pubkey: { x: 0n, y: 1n } }; // placeholder

      // 1. Wrap
      try {
        console.log(`  Wrapping ${WRAP_AMOUNTS[tokenId]} raw units...`);
        const wrapRes = await adapter.wrap(
          { grossAmount: WRAP_AMOUNTS[tokenId] },
          aliceWallet
        );
        result.wrapStatus = "PASS";
        result.wrapTxHash = wrapRes.txHash;
        console.log(`  Wrap PASS: ${wrapRes.txHash} (net=${wrapRes.netAmount})`);
      } catch (err) {
        result.wrapStatus = "FAIL";
        result.error = `wrap: ${err}`;
        console.error(`  Wrap FAIL: ${err}`);
        results.push(result);
        continue;
      }

      // Get Alice's post-wrap state.
      const aliceCoa = await getCoaEvmAddress(ALICE_FLOW_ADDR);
      const bobCoa   = await getCoaEvmAddress(BOB_FLOW_ADDR);
      const snap = await adapter.latestSnapshot(
        adapter.variant === "cadence-ft" ? ALICE_FLOW_ADDR : aliceCoa,
        TEST_MEMO_PRIVKEY_ALICE
      );
      console.log(`  Post-wrap balance: ${snap.balance} (blinding=${snap.blinding.toString().slice(0,8)}…)`);

      // 2. Shielded transfer to Bob.
      const recipientAddr = adapter.variant === "cadence-ft" ? BOB_FLOW_ADDR : bobCoa;
      try {
        console.log(`  Sending ${SEND_AMOUNTS[tokenId]} raw units to Bob...`);
        const sendRes = await adapter.shieldedTransfer(
          {
            recipient: recipientAddr,
            amount: SEND_AMOUNTS[tokenId],
            currentBalance: snap.balance,
            currentBlinding: snap.blinding,
            memo: `test-${tokenId}`,
          },
          aliceWallet
        );
        result.sendStatus = "PASS";
        result.sendTxHash = sendRes.txHash;
        console.log(`  Send PASS: ${sendRes.txHash}`);
      } catch (err) {
        result.sendStatus = "FAIL";
        result.error = `shieldedTransfer: ${err}`;
        console.error(`  Send FAIL: ${err}`);
        results.push(result);
        continue;
      }

      // 3. Decrypt incoming note on Bob's side.
      try {
        const deposits = await adapter.scanDeposits(
          adapter.variant === "cadence-ft" ? BOB_FLOW_ADDR : bobCoa
        );
        console.log(`  Bob deposits found: ${deposits.length}`);
        if (deposits.length > 0) {
          const latest = deposits[deposits.length - 1];
          const note = await adapter.decryptNoteTo(
            latest.ciphertext,
            latest.ephPubkey,
            TEST_MEMO_PRIVKEY_BOB
          );
          if (note.memo === `test-${tokenId}`) {
            result.decryptStatus = "PASS";
            console.log(`  Decrypt PASS: memo="${note.memo}", amount=${note.amount}`);
          } else {
            result.decryptStatus = "FAIL";
            result.error = `Memo mismatch: expected test-${tokenId}, got ${note.memo}`;
          }
        } else {
          result.decryptStatus = "FAIL";
          result.error = "No deposits found for Bob";
        }
      } catch (err) {
        result.decryptStatus = "FAIL";
        result.error = `decrypt: ${err}`;
        console.error(`  Decrypt FAIL: ${err}`);
      }

      // 4. Bob unwraps.
      try {
        const bobSnap = await adapter.latestSnapshot(
          adapter.variant === "cadence-ft" ? BOB_FLOW_ADDR : bobCoa,
          TEST_MEMO_PRIVKEY_BOB
        );
        const unwrapRes = await adapter.unwrap(
          {
            claimedAmount: bobSnap.balance,
            recipient: adapter.variant === "cadence-ft" ? BOB_FLOW_ADDR : bobCoa,
            currentBalance: bobSnap.balance,
            currentBlinding: bobSnap.blinding,
          },
          bobWallet
        );
        result.unwrapStatus = "PASS";
        result.unwrapTxHash = unwrapRes.txHash;
        console.log(`  Unwrap PASS: ${unwrapRes.txHash} (net=${unwrapRes.netToRecipient})`);
      } catch (err) {
        result.unwrapStatus = "FAIL";
        result.error = `unwrap: ${err}`;
        console.error(`  Unwrap FAIL: ${err}`);
      }

    } catch (err) {
      result.error = `Unexpected: ${err}`;
      console.error(`  Token ${tokenId} FATAL: ${err}`);
    }

    results.push(result);
  }

  // Summary
  console.log("\n=== SMOKE TEST SUMMARY ===");
  console.log("Token     | Wrap | Send | Decrypt | Unwrap");
  console.log("--------- | ---- | ---- | ------- | ------");
  for (const r of results) {
    console.log(
      `${r.token.padEnd(9)} | ${r.wrapStatus.padEnd(4)} | ${r.sendStatus.padEnd(4)} | ${r.decryptStatus.padEnd(7)} | ${r.unwrapStatus}`
    );
    if (r.error) console.log(`           | ERROR: ${r.error}`);
  }

  // Save results.
  const outPath = path.join(__dirname, "smoke-results.json");
  const output = {
    timestamp: new Date().toISOString(),
    sdk_version: "0.6.5",
    can_run_tx: canRunTx,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  // Exit code.
  const anyFail = results.some(r =>
    r.wrapStatus === "FAIL" ||
    r.sendStatus === "FAIL" ||
    r.decryptStatus === "FAIL" ||
    r.unwrapStatus === "FAIL"
  );
  if (anyFail && canRunTx) {
    process.exit(1);
  }
}

runSmokeTest().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
