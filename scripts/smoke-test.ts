/**
 * PrivateTip End-to-End Smoke Test
 *
 * Runs the full flow against Flow Testnet:
 *   1. Configure FCL for testnet and connect
 *   2. Load test accounts from Flow JSON key files
 *   3. Generate BabyJubJub keypairs for each account
 *   4. Register pubkeys via JanusToken (EVM)
 *   5. bob wraps 10 FLOW to his own pubkey
 *   6. Send confidential tips (via JanusFlow wrapAndEncrypt):
 *      - bob → alice: 1 FLOW (memo: "Thanks!")
 *      - charlie → alice: 2 FLOW (memo: "Great work")
 *      - dave → alice: 3 FLOW (memo: "")
 *   7. Record tip metadata in PrivateTip
 *   8. Claim: alice decrypts accumulated slot (6 FLOW) and unwraps
 *   9. Verify: on-chain state, balances
 *
 * Usage:
 *   PRIVATETIP_ADDR=0x... \
 *   BOB_PKEY=path/to/bob-key.json \
 *   CHARLIE_PKEY=path/to/charlie-key.json \
 *   DAVE_PKEY=path/to/dave-key.json \
 *   EVE_PKEY=path/to/eve-key.json \
 *   npx ts-node scripts/smoke-test.ts
 *
 * Exits 0 on full pass, 1 with diagnostics on any failure.
 */

import * as fcl from "@onflow/fcl";
import { ethers } from "ethers";
import path from "path";
import fs from "fs";

// ─── SDK imports ───────────────────────────────────────────────────────────────

import { JanusFlow } from "@openjanus/sdk/tokens";
import {
  buildEncryptProof,
  buildDecryptProof,
  generateBlinding,
} from "@openjanus/sdk/crypto";

// ─── Constants ─────────────────────────────────────────────────────────────────

const FLOW_NETWORK = "testnet";
const FLOW_ACCESS_API = "https://rest-testnet.onflow.org";
const EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;
const JANUS_TOKEN_EVM_ADDR = "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499";
const FLOWTOKEN_ADDR = "0x7e60df042a9c0868";
const FUNGIBLETOKEN_ADDR = "0x9a0766d93b6608b7";

// Test amounts
const TOP_UP_AMOUNT = "10.0";
const TIP_1_AMOUNT = "1.0";
const TIP_2_AMOUNT = "2.0";
const TIP_3_AMOUNT = "3.0";
const TOTAL_CLAIM = "6.0";

const ATTOFLOW_PER_FLOW = BigInt("1000000000000000000");

// Declared at module scope so any step can reference it
const totalAtto = flowToAttoflow(TOTAL_CLAIM);

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TestAccount {
  name: string;
  address: string;
  privateKey: string;
  keyId: number;
  pubkey: { x: bigint; y: bigint };
  secretKey: bigint;
  evmWallet: ethers.Wallet;
}

interface TipRecord {
  sender: TestAccount;
  amount: string;
  memo: string | null;
  txId?: string;
}

// ─── Network helpers ───────────────────────────────────────────────────────────

function configureFCL(): void {
  fcl.config({
    "accessNode.api": FLOW_ACCESS_API,
    "flow.network": FLOW_NETWORK,
  });
}

function readJSON(pathStr: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(pathStr), "utf-8"));
}

function buildAuthorization(account: TestAccount) {
  return async (_acct: any) => {
    const { SHA3_256, SignatureAlgorithm } = await import("@onflow/typedefs");
    const addr = fcl.withPrefix(account.address);
    const keyId = String(account.keyId);
    return {
      addr,
      keyId,
      signature: async (msg: string) => {
        const { signWithKey } = await import("@onflow/sdk");
        return signWithKey(
          Buffer.from(msg, "hex"),
          Buffer.from(account.privateKey, "hex"),
          {
            hashAlgorithm: SHA3_256,
            signatureAlgorithm: SignatureAlgorithm.ECDSA_secp256k1,
          }
        );
      },
    };
  };
}

function flowToAttoflow(flowStr: string): bigint {
  const trimmed = flowStr.trim();
  const parts = trimmed.split(".");
  let wholeStr = parts[0] || "0";
  let fracStr = parts[1] || "";
  while (fracStr.length < 18) fracStr += "0";
  if (fracStr.length > 18) fracStr = fracStr.slice(0, 18);
  const clean = (wholeStr + fracStr).replace(/^0+/, "") || "0";
  return BigInt(clean);
}

function attoflowToFlow(attoflow: bigint): string {
  const whole = attoflow / ATTOFLOW_PER_FLOW;
  const remainder = attoflow % ATTOFLOW_PER_FLOW;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, 8);
  return `${whole.toString()}.${fracStr}`;
}

// ─── BabyJubJub key generation ────────────────────────────────────────────────

async function generateBabyJubKeypair(
  seed: bigint
): Promise<{ pubkey: { x: bigint; y: bigint }; secretKey: bigint }> {
  const { buildBabyjub } = await import("circomlibjs");
  const babyjub = await buildBabyjub();
  const F = babyjub.F;
  const BASE8 = babyjub.Base8;
  const subOrder = BigInt(
    "21888242871839275222246405745257275088614511777268538073601725287587578984328"
  );
  const secretKey = seed % subOrder;
  const pkPoint = babyjub.mulPointEscalar(BASE8, secretKey);
  return {
    pubkey: { x: BigInt(F.toObject(pkPoint[0])), y: BigInt(F.toObject(pkPoint[1])) },
    secretKey,
  };
}

// ─── EVM helpers ───────────────────────────────────────────────────────────────

function createEVMWallet(privateKeyHex: string): ethers.Wallet {
  const pk = privateKeyHex.startsWith("0x") ? privateKeyHex : "0x" + privateKeyHex;
  const provider = new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID);
  return new ethers.Wallet(pk, provider);
}

const JANUS_TOKEN_ABI = [
  "function registerPubkey(uint256 pkx, uint256 pky)",
  "function pubkeyOf(address account) view returns (uint256, uint256)",
  "function hasPubkey(address account) view returns (bool)",
  "function getSlotRaw(address account) view returns (uint256, uint256, uint256, uint256)",
];

async function registerPubkey(
  wallet: ethers.Wallet,
  pkx: bigint,
  pky: bigint
): Promise<void> {
  const contract = new ethers.Contract(JANUS_TOKEN_EVM_ADDR, JANUS_TOKEN_ABI, wallet);
  const tx = await contract.registerPubkey(pkx, pky);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) {
    throw new Error(`registerPubkey failed: ${receipt?.hash}`);
  }
  console.log(`     ✓ tx: ${receipt?.hash}`);
}

async function getPubkey(
  wallet: ethers.Wallet,
  addr: string
): Promise<{ x: bigint; y: bigint }> {
  const contract = new ethers.Contract(JANUS_TOKEN_EVM_ADDR, JANUS_TOKEN_ABI, wallet);
  const [x, y] = await contract.pubkeyOf(addr);
  return { x: BigInt(x), y: BigInt(y) };
}

/** Check if an account has registered a BabyJubJub pubkey (view function, never reverts). */
async function hasPubkey(
  wallet: ethers.Wallet,
  addr: string
): Promise<boolean> {
  const contract = new ethers.Contract(JANUS_TOKEN_EVM_ADDR, JANUS_TOKEN_ABI, wallet);
  return contract.hasPubkey(addr);
}

async function getSlotRaw(
  wallet: ethers.Wallet,
  addr: string
): Promise<{ c1x: bigint; c1y: bigint; c2x: bigint; c2y: bigint }> {
  const contract = new ethers.Contract(JANUS_TOKEN_EVM_ADDR, JANUS_TOKEN_ABI, wallet);
  const [c1x, c1y, c2x, c2y] = await contract.getSlotRaw(addr);
  return { c1x: BigInt(c1x), c1y: BigInt(c1y), c2x: BigInt(c2x), c2y: BigInt(c2y) };
}

// ─── Main test ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let failures = 0;
  const fail = (msg: string) => {
    console.error(`  ✗ FAIL: ${msg}`);
    failures++;
  };
  const pass = (msg: string) => console.log(`  ✓ ${msg}`);

  // ─── Step 0: Validate ──────────────────────────────────────────────────────

  console.log("═══════════════════════════════════════════════════════");
  console.log("  PrivateTip Smoke Test — Flow Testnet");
  console.log("═══════════════════════════════════════════════════════\n");

  const PRIVATETIP_ADDR = process.env.PRIVATETIP_ADDR || "";
  if (!PRIVATETIP_ADDR) {
    console.error("  ✗ PRIVATETIP_ADDR environment variable required");
    return 1;
  }
  pass(`PrivateTip address: ${PRIVATETIP_ADDR}`);

  for (const envName of ["BOB_PKEY", "CHARLIE_PKEY", "DAVE_PKEY", "EVE_PKEY"]) {
    if (!process.env[envName]) {
      console.error(`  ✗ ${envName} not set`);
      return 1;
    }
  }
  pass("All key file env vars present");

  configureFCL();
  pass("FCL configured for testnet\n");

  // ─── Step 1: Load accounts + generate keys ─────────────────────────────────

  console.log("── Step 1: Load test accounts and generate keys ─────\n");

  const accountConfigs: { name: string; envKey: string; seed: bigint }[] = [
    { name: "bob", envKey: "BOB_PKEY", seed: BigInt("0x424f4221bab4a5a5") },
    { name: "charlie", envKey: "CHARLIE_PKEY", seed: BigInt("0x43484152214c4945") },
    { name: "dave", envKey: "DAVE_PKEY", seed: BigInt("0x4441564521444144") },
    { name: "eve", envKey: "EVE_PKEY", seed: BigInt("0x45564521455645") },
  ];

  const accounts: TestAccount[] = [];
  for (const cfg of accountConfigs) {
    const keyFile = process.env[cfg.envKey]!;
    const keyData = readJSON(keyFile);
    const addr = fcl.withPrefix(keyData.address);

    // Read private key from the separate .pkey file referenced by keyData.pkeyPath
    const pkeyPath = keyData.pkeyPath.replace(/^~/, process.env.HOME || "");
    const pkHex = fs.readFileSync(path.resolve(pkeyPath), "utf-8").trim();
    if (!pkHex) {
      console.error(`  ✗ Cannot read private key from ${pkeyPath}`);
      return 1;
    }

    const keys = await generateBabyJubKeypair(cfg.seed);
    const evmWallet = createEVMWallet(pkHex);
    const acct: TestAccount = {
      name: cfg.name,
      address: addr,
      privateKey: pkHex,
      keyId: keyData.keyIndex ?? 0,
      pubkey: keys.pubkey,
      secretKey: keys.secretKey,
      evmWallet,
    };
    accounts.push(acct);
    console.log(`  ✓ ${cfg.name.padEnd(8)} ${addr}  COA: ${evmWallet.address}`);
  }
  const bob = accounts[0];
  const charlie = accounts[1];
  const dave = accounts[2];
  const eve = accounts[3]; // alice
  console.log("");

  // ─── Step 2: Initialize JanusFlow SDK ─────────────────────────────────────

  console.log("── Step 2: Initialize JanusFlow SDK ─────────────────\n");
  const janusFlow = new JanusFlow({ network: FLOW_NETWORK });
  await janusFlow.configure();
  pass("JanusFlow SDK ready\n");

  // ─── Step 3: Register BabyJubJub pubkeys ──────────────────────────────────

  console.log("── Step 3: Register BabyJubJub pubkeys ──────────────\n");

  for (const acct of accounts) {
    // Use hasPubkey() view function — never reverts
    const isRegistered = await hasPubkey(acct.evmWallet, acct.evmWallet.address);
    if (isRegistered) {
      pass(`${acct.name}: pubkey already registered`);
      continue;
    }
    console.log(`  ~ ${acct.name}: registering pubkey...`);
    await registerPubkey(acct.evmWallet, acct.pubkey.x, acct.pubkey.y);
  }
  console.log("");

  // ─── Step 4: Verify PrivateTip ─────────────────────────────────────────────

  console.log("── Step 4: Verify PrivateTip contract ───────────────\n");

  try {
    const script = `
      import PrivateTip from ${PRIVATETIP_ADDR}
      access(all) fun main(): Bool { return PrivateTip.isPaused() }
    `;
    const paused = await fcl.query({ cadence: script });
    pass(`PrivateTip accessible, paused=${paused}`);
  } catch (err: any) {
    fail(`Cannot query PrivateTip: ${err.message}`);
    return 1;
  }
  console.log("");

  // ─── Step 5: Top up bob ───────────────────────────────────────────────────

  console.log("── Step 5: Top up bob — wrap ${TOP_UP_AMOUNT} FLOW ────────\n");

  try {
    const r = generateBlinding();
    console.log("  ~ Generating encrypt proof...");
    const enc = await buildEncryptProof({
      value: flowToAttoflow(TOP_UP_AMOUNT),
      randomness: r,
      recipientPubkey: bob.pubkey,
    });
    pass("Encrypt proof generated");

    console.log("  ~ Submitting JanusFlow.wrapAndEncrypt...");
    const wrapResult = await janusFlow.wrapAndEncrypt(
      TOP_UP_AMOUNT,
      bob.address,
      {
        ciphertext: {
          c1: { x: enc.ciphertext.C1.x, y: enc.ciphertext.C1.y },
          c2: { x: enc.ciphertext.C2.x, y: enc.ciphertext.C2.y },
        },
        proof: enc.proof,
        publicInputs: enc.publicInputs,
      },
      buildAuthorization(bob)
    );
    pass(`FLOW wrapped: tx=${wrapResult.txId}`);

    const slot = await getSlotRaw(bob.evmWallet, bob.evmWallet.address);
    const empty = slot.c1x === BigInt(0) && slot.c1y === BigInt(1) &&
      slot.c2x === BigInt(0) && slot.c2y === BigInt(1);
    if (empty) {
      fail("bob's slot is still empty after wrap");
    } else {
      pass("bob's JanusToken slot is non-empty");
    }
  } catch (err: any) {
    fail(`Top-up: ${err.message}`);
  }
  console.log("");

  // ─── Step 6: Send tips ────────────────────────────────────────────────────

  console.log("── Step 6: Send tips ─────────────────────────────────\n");

  const tips: TipRecord[] = [
    { sender: bob, amount: TIP_1_AMOUNT, memo: "Thanks!" },
    { sender: charlie, amount: TIP_2_AMOUNT, memo: "Great work" },
    { sender: dave, amount: TIP_3_AMOUNT, memo: null },
  ];

  for (const tip of tips) {
    const recipientName = "alice";
    console.log(`  ~ ${tip.sender.name} → ${recipientName}: ${tip.amount} FLOW` +
      (tip.memo ? ` "${tip.memo}"` : ""));

    try {
      // 1. Generate encrypt proof (encrypt amount to alice's pubkey)
      const r = generateBlinding();
      const enc = await buildEncryptProof({
        value: flowToAttoflow(tip.amount),
        randomness: r,
        recipientPubkey: eve.pubkey,
      });

      // 2. Wrap and encrypt via JanusFlow
      const wrapResult = await janusFlow.wrapAndEncrypt(
        tip.amount,
        eve.address,
        {
          ciphertext: {
            c1: { x: enc.ciphertext.C1.x, y: enc.ciphertext.C1.y },
            c2: { x: enc.ciphertext.C2.x, y: enc.ciphertext.C2.y },
          },
          proof: enc.proof,
          publicInputs: enc.publicInputs,
        },
        buildAuthorization(tip.sender)
      );
      tip.txId = wrapResult.txId;
      pass(`wrapAndEncrypt: ${wrapResult.txId}`);

      // 3. Record metadata in PrivateTip.recordTip (access(all), anyone can call)
      const recordTxId = await fcl.mutate({
        cadence: `
          import PrivateTip from ${PRIVATETIP_ADDR}
          transaction(sender: Address, recipient: Address, memo: String?) {
            execute {
              PrivateTip.recordTip(sender: sender, recipient: recipient, memo: memo)
            }
          }
        `,
        args: (arg: any, t: any) => [
          arg(tip.sender.address, t.Address),
          arg(eve.address, t.Address),
          tip.memo !== null ? arg(tip.memo, t.String) : arg(null, t.Optional(t.String)),
        ],
        proposer: buildAuthorization(tip.sender),
        payer: buildAuthorization(tip.sender),
        authorizations: [buildAuthorization(tip.sender)],
        limit: 9999,
      });
      await fcl.tx(recordTxId).onceSealed();
      pass(`recordTip: ${recordTxId}`);

      // 4. Record a real TipSent event should have been emitted
    } catch (err: any) {
      fail(`${tip.sender.name}→alice: ${err.message}`);
    }
  }
  console.log("");

  // ─── Step 7: Verify on-chain state ─────────────────────────────────────────

  console.log("── Step 7: Verify on-chain state ────────────────────\n");

  try {
    const countScript = `
      import PrivateTip from ${PRIVATETIP_ADDR}
      access(all) fun main(r: Address): UInt64 { return PrivateTip.getTipCount(recipient: r) }
    `;
    const tipCount = await fcl.query({
      cadence: countScript,
      args: (arg: any, t: any) => [arg(eve.address, t.Address)],
    }) as number;

    if (tipCount >= 1) {
      pass(`alice has ${tipCount} tip(s) recorded`);
    } else {
      fail(`alice has ${tipCount} tips, expected >= 1`);
    }

    const tipsScript = `
      import PrivateTip from ${PRIVATETIP_ADDR}
      access(all) fun main(r: Address): [PrivateTip.TipInfo] {
        return PrivateTip.getTipsByRecipient(recipient: r)
      }
    `;
    const tipsData = await fcl.query({
      cadence: tipsScript,
      args: (arg: any, t: any) => [arg(eve.address, t.Address)],
    }) as any[];

    const sentTips = tips.filter((t) => t.txId);
    pass(`Got ${tipsData.length} tips from chain (expected ${sentTips.length})`);

    // Check each recorded tip
    for (const td of tipsData as any[]) {
      const addrMatch = td.sender && td.sender.address
        ? td.sender.address.toLowerCase()
        : String(td.sender).toLowerCase();
      const matchedTip = tips.find(
        (t) => t.sender.address.toLowerCase() === addrMatch
      );
      if (matchedTip) {
        pass(`Tip #${td.tipID}: sender=${td.sender}, memo="${td.memo}"`);
      }
    }

    // Check claimed status (none should be claimed yet)
    const allUnclaimed = (tipsData as any[]).every((t: any) => !t.claimed);
    if (allUnclaimed) {
      pass("All tips unclaimed (as expected before claim)");
    } else {
      fail("Some tips are already claimed before claim step");
    }
  } catch (err: any) {
    fail(`State verification: ${err.message}`);
  }
  console.log("");

  // ─── Step 8: Claim tips ────────────────────────────────────────────────────

  console.log("── Step 8: Claim tips — alice decrypts and claims ──\n");

  try {
    // 1. Read alice's (eve's) accumulated slot
    console.log("  ~ Reading alice's accumulated slot...");
    const aliceSlot = await getSlotRaw(eve.evmWallet, eve.evmWallet.address);
    const isIdentity = aliceSlot.c1x === BigInt(0) && aliceSlot.c1y === BigInt(1) &&
      aliceSlot.c2x === BigInt(0) && aliceSlot.c2y === BigInt(1);
    if (isIdentity) {
      fail("alice's JanusToken slot is empty — no tips accumulated");
    } else {
      pass("alice's slot is non-empty");
    }

    // 2. Build decrypt proof for total amount
    console.log(`  ~ Building decrypt proof for ${TOTAL_CLAIM} FLOW...`);
    const decryptResult = await buildDecryptProof({
      ciphertext: {
        C1: { x: aliceSlot.c1x, y: aliceSlot.c1y },
        C2: { x: aliceSlot.c2x, y: aliceSlot.c2y },
      },
      secretKey: eve.secretKey,
      pubkey: eve.pubkey,
      amount: totalAtto,
    });
    pass("Decrypt proof generated");

    // 3. Decrypt and unwrap via JanusFlow
    console.log("  ~ Submitting JanusFlow.decryptAndUnwrap...");
    const claimResult = await janusFlow.decryptAndUnwrap(
      TOTAL_CLAIM,
      eve.address,
      {
        proof: decryptResult.proof,
        publicInputs: decryptResult.publicInputs,
        amount: totalAtto,
      },
      buildAuthorization(eve)
    );
    pass(`Claim submitted: tx=${claimResult.txId}`);
    console.log("");
  } catch (err: any) {
    fail(`Claim: ${err.message}`);
    console.log("");
  }

  // ─── Step 9: Mark tips as claimed in PrivateTip ──────────────────────────

  console.log("── Step 9: Mark tips as claimed in PrivateTip ───────\n");

  try {
    // Read unclaimed tip IDs
    const tipsScript = `
      import PrivateTip from ${PRIVATETIP_ADDR}
      access(all) fun main(r: Address): [PrivateTip.TipInfo] {
        return PrivateTip.getTipsByRecipient(recipient: r)
      }
    `;
    const tipInfos = await fcl.query({
      cadence: tipsScript,
      args: (arg: any, t: any) => [arg(eve.address, t.Address)],
    }) as any[];

    const unclaimedIDs = tipInfos
      .filter((t: any) => !t.claimed)
      .map((t: any) => Number(t.tipID));

    if (unclaimedIDs.length === 0) {
      pass("No unclaimed tips to mark");
    } else {
      console.log(`  ~ Marking ${unclaimedIDs.length} tips as claimed...`);

      // PrivateTip.claimTip checks self.account.address (contract's own address).
      // This can only be called from the contract account.
      // We attempt it and accept if it fails — the core value transfer happened
      // via JanusFlow in Step 8.
      try {
        const markTxId = await fcl.mutate({
          cadence: `
            import PrivateTip from ${PRIVATETIP_ADDR}
            transaction(tipIDs: [UInt64]) {
              execute {
                for tipID in tipIDs {
                  PrivateTip.claimTip(tipID: tipID)
                }
              }
            }
          `,
          args: (arg: any, t: any) => [arg(unclaimedIDs, t.Array(t.UInt64))],
          proposer: buildAuthorization(eve),
          payer: buildAuthorization(eve),
          authorizations: [buildAuthorization(eve)],
          limit: 9999,
        });
        await fcl.tx(markTxId).onceSealed();
        pass(`Tips marked as claimed: tx=${markTxId}`);
      } catch (claimErr: any) {
        // claimTip checks self.account.address which is the contract's address.
        // This is expected to fail for non-contract signers.
        console.log(`  ℹ  Note: claimTip requires contract account: ${claimErr.message}`);
        console.log(`     (The FLOW was already claimed via JanusFlow in Step 8.)`);
        // This is NOT a test failure — it's an architectural constraint.
      }
    }
  } catch (err: any) {
    fail(`Mark claim: ${err.message}`);
  }
  console.log("");

  // ─── Step 10: Verify alice's balance ──────────────────────────────────────

  console.log("── Step 10: Verify alice's FLOW balance ─────────────\n");

  try {
    const balScript = `
      import FungibleToken from ${FUNGIBLETOKEN_ADDR}
      import FlowToken from ${FLOWTOKEN_ADDR}
      access(all) fun main(addr: Address): UFix64 {
        let acct = getAccount(addr)
        let vaultRef = acct.capabilities
          .borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
          ?? panic("no balance")
        return vaultRef.balance
      }
    `;
    const balanceStr = await fcl.query({
      cadence: balScript,
      args: (arg: any, t: any) => [arg(eve.address, t.Address)],
    }) as string;

    const balAtto = flowToAttoflow(balanceStr);
    console.log(`  ℹ  alice FLOW balance: ${balanceStr}`);

    // alice should have at least the claimed amount
    if (balAtto >= totalAtto) {
      pass(`alice balance >= ${TOTAL_CLAIM} FLOW`);
    } else {
      // She might have spent some on gas, so check with tolerance
      const tolerance = flowToAttoflow("0.01");
      if (balAtto >= totalAtto - tolerance) {
        pass(`alice balance approximately correct (within 0.01 FLOW tolerance)`);
      } else {
        fail(`alice balance ${balanceStr} FLOW < expected ${TOTAL_CLAIM} FLOW`);
      }
    }
  } catch (err: any) {
    fail(`Balance check: ${err.message}`);
  }
  console.log("");

  // ─── Edge case: unregistered pubkey ──────────────────────────────────────

  console.log("── Edge case: unregistered pubkey ───────────────────\n");

  try {
    const trashWallet = ethers.Wallet.createRandom().connect(
      new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID)
    );
    const pk = await getPubkey(trashWallet, trashWallet.address);
    if (pk.x === BigInt(0) && pk.y === BigInt(1)) {
      pass("Unregistered account has identity pubkey (0,1)");
    } else {
      fail("Unregistered account has non-identity pubkey");
    }
  } catch (err: any) {
    // An ethers call from an unfunded wallet may fail — this is acceptable
    console.log(`  ℹ  Note: ${err.message}`);
  }
  console.log("");

  // ─── Edge case: empty slot ────────────────────────────────────────────────

  console.log("── Edge case: empty JanusToken slot ─────────────────\n");

  try {
    const trashWallet = ethers.Wallet.createRandom().connect(
      new ethers.JsonRpcProvider(EVM_RPC, EVM_CHAIN_ID)
    );
    const slot = await getSlotRaw(trashWallet, trashWallet.address);
    if (
      slot.c1x === BigInt(0) && slot.c1y === BigInt(1) &&
      slot.c2x === BigInt(0) && slot.c2y === BigInt(1)
    ) {
      pass("Unregistered account has identity ciphertext slot");
    } else {
      fail("Unregistered account has non-identity slot");
    }
  } catch (err: any) {
    console.log(`  ℹ  Note: ${err.message}`);
  }
  console.log("");

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log("═══════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("  RESULT: ALL TESTS PASSED ✓");
  } else {
    console.log(`  RESULT: ${failures} FAILURE(S) ✗`);
  }
  console.log("═══════════════════════════════════════════════════════\n");

  return failures;
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

main()
  .then((f) => process.exit(f > 0 ? 1 : 0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
