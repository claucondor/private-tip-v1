/**
 * fund-faucet.mjs
 * Task 1: Setup MockFT vault on faucet wallet (P-256, signed by faucet pkey)
 * Task 2: Mint 1000 MockFT from deployer → faucet (secp256k1, signed by deployer pkey)
 * Task 3: Fund faucet EVM with FLOW via CrossVM (faucet signs Cadence, COA sends FLOW to own EVM addr)
 *
 * Run from /home/oydual3/zkapps/private-tip-v1/web/
 */

import * as fcl from "@onflow/fcl";
import ellipticPkg from "elliptic";
const { ec: EC } = ellipticPkg;
import sha3Pkg from "sha3";
const { SHA3 } = sha3Pkg;
import crypto from "crypto";

const TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";

// Faucet wallet: P-256 + SHA3_256
const FAUCET_ADDR = "62696428106552cf";
const FAUCET_PKEY = "be0a96640090b30a18e2b159656cb46ca42cdf49dc276f06568ae85c2a7a3518";
const FAUCET_KEY_INDEX = 0;

// Deployer wallet: secp256k1 + SHA2_256
const DEPLOYER_ADDR = "7599043aea001283";
const DEPLOYER_PKEY = "677efa010bc081c6745d15c6118f19f7725ed5ef3c6e368c15e539d18bdfe133";
const DEPLOYER_KEY_INDEX = 0;

fcl.config()
  .put("accessNode.api", TESTNET_ACCESS_NODE)
  .put("flow.network", "testnet");

// ─── Signers ─────────────────────────────────────────────────────────────────

function makeSigner(pkey, curve, hashAlgo, addr, keyIndex) {
  const ec = new EC(curve);
  const key = ec.keyFromPrivate(Buffer.from(pkey, "hex"));

  function sign(msgHex) {
    let digest;
    if (hashAlgo === "SHA3_256") {
      const sha = new SHA3(256);
      sha.update(Buffer.from(msgHex, "hex"));
      digest = sha.digest();
    } else {
      // SHA2_256
      digest = crypto.createHash("sha256").update(Buffer.from(msgHex, "hex")).digest();
    }
    const sig = key.sign(digest);
    const n = 32;
    return Buffer.concat([
      sig.r.toArrayLike(Buffer, "be", n),
      sig.s.toArrayLike(Buffer, "be", n),
    ]).toString("hex");
  }

  return async (account) => ({
    ...account,
    tempId: `${addr}-${keyIndex}`,
    addr,
    keyId: keyIndex,
    signingFunction: (signable) => ({
      addr,
      keyId: keyIndex,
      signature: sign(signable.message),
    }),
  });
}

const faucetAuthz = makeSigner(FAUCET_PKEY, "p256", "SHA3_256", FAUCET_ADDR, FAUCET_KEY_INDEX);
const deployerAuthz = makeSigner(DEPLOYER_PKEY, "secp256k1", "SHA2_256", DEPLOYER_ADDR, DEPLOYER_KEY_INDEX);

// ─── Task 1: Setup MockFT vault on faucet ─────────────────────────────────────

const SETUP_MOCKFT_VAULT_TX = `
import FungibleToken from 0x9a0766d93b6608b7
import MockFT from 0x7599043aea001283

transaction {
  prepare(signer: auth(SaveValue, BorrowValue, Capabilities) &Account) {
    if signer.storage.borrow<&MockFT.Vault>(from: /storage/mockFTVault) != nil {
      return
    }
    signer.storage.save(<-MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>()), to: /storage/mockFTVault)
    let receiverCap = signer.capabilities.storage.issue<&{FungibleToken.Receiver}>(/storage/mockFTVault)
    signer.capabilities.publish(receiverCap, at: /public/mockFTReceiver)
    let balanceCap = signer.capabilities.storage.issue<&{FungibleToken.Balance}>(/storage/mockFTVault)
    signer.capabilities.publish(balanceCap, at: /public/mockFTBalance)
  }
}
`;

// ─── Task 2: Mint 1000 MockFT deployer → faucet ───────────────────────────────

const MINT_MOCKFT_TX = `
import FungibleToken from 0x9a0766d93b6608b7
import MockFT from 0x7599043aea001283

transaction(amount: UFix64, recipient: Address) {
  prepare(signer: auth(BorrowValue) &Account) {
    let minter = signer.storage.borrow<&MockFT.Minter>(from: /storage/mockFTMinter)
      ?? panic("No MockFT minter at /storage/mockFTMinter")
    let minted <- minter.mintTokens(amount: amount)
    let receiver = getAccount(recipient)
      .capabilities.borrow<&{FungibleToken.Receiver}>(/public/mockFTReceiver)
      ?? panic("recipient missing mockFTReceiver capability — setup first")
    receiver.deposit(from: <-minted)
  }
}
`;

// ─── Task 3a: Fund faucet EVM with FLOW via CrossVM ───────────────────────────
// Faucet wallet creates/ensures COA, then sends FLOW to its own EVM address

const FUND_FAUCET_EVM_TX = `
import EVM from 0x8c5303eaa26202d6
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(amount: UFix64) {
  let coa: auth(EVM.Withdraw) &EVM.CadenceOwnedAccount
  let flowVault: auth(FungibleToken.Withdraw) &FlowToken.Vault

  prepare(signer: auth(SaveValue, BorrowValue, Capabilities) &Account) {
    // Get or create COA
    if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) == nil {
      let newCoa <- EVM.createCadenceOwnedAccount()
      signer.storage.save(<-newCoa, to: /storage/evm)
      let coaCap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
      signer.capabilities.publish(coaCap, at: /public/evm)
    }
    self.coa = signer.storage.borrow<auth(EVM.Withdraw) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA")
    self.flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
      ?? panic("No FlowToken vault")
  }

  execute {
    let vault <- self.flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    self.coa.deposit(from: <-vault)
  }
}
`;

// ─── Verify script ────────────────────────────────────────────────────────────

const VERIFY_MOCKFT_SCRIPT = `
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7

access(all) fun main(): {String: AnyStruct} {
  let acc = getAccount(0x62696428106552cf)
  let cap = acc.capabilities.get<&{FungibleToken.Balance}>(/public/mockFTBalance)
  if !cap.check() { return {"setup": false} }
  let ref = cap.borrow() ?? panic("borrow failed")
  return {"setup": true, "balance": ref.balance.toString()}
}
`;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function sendTx(code, args, authz) {
  const txId = await fcl.mutate({
    cadence: code,
    args: (arg, t) => args(arg, t),
    proposer: authz,
    payer: authz,
    authorizations: [authz],
    limit: 9999,
  });
  console.log(`  TX submitted: ${txId}`);
  const result = await fcl.tx(txId).onceSealed();
  if (result.errorMessage) {
    throw new Error(`TX failed: ${result.errorMessage}`);
  }
  console.log(`  TX sealed: ${txId} (status ${result.status})`);
  return txId;
}

async function main() {
  console.log("\n=== Task 1: Setup MockFT vault on faucet (0x62696428106552cf) ===");
  try {
    const tx1 = await sendTx(SETUP_MOCKFT_VAULT_TX, (arg, t) => [], faucetAuthz);
    console.log(`RESULT task1: ${tx1}`);
  } catch (e) {
    console.error("Task 1 error:", e.message);
    process.exit(1);
  }

  console.log("\n=== Task 2: Mint 1000 MockFT deployer → faucet ===");
  try {
    const tx2 = await sendTx(
      MINT_MOCKFT_TX,
      (arg, t) => [arg("1000.00000000", t.UFix64), arg("0x62696428106552cf", t.Address)],
      deployerAuthz
    );
    console.log(`RESULT task2: ${tx2}`);
  } catch (e) {
    console.error("Task 2 error:", e.message);
    process.exit(1);
  }

  console.log("\n=== Verify: MockFT balance on faucet ===");
  try {
    const result = await fcl.query({ cadence: VERIFY_MOCKFT_SCRIPT });
    console.log("Verify result:", JSON.stringify(result));
  } catch (e) {
    console.error("Verify error:", e.message);
  }

  console.log("\n=== Task 3a: Fund faucet EVM with 1.0 FLOW via CrossVM COA ===");
  try {
    const tx3 = await sendTx(
      FUND_FAUCET_EVM_TX,
      (arg, t) => [arg("1.00000000", t.UFix64)],
      faucetAuthz
    );
    console.log(`RESULT task3_coa_fund: ${tx3}`);
  } catch (e) {
    console.error("Task 3a error:", e.message);
    process.exit(1);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
