/**
 * fund-faucet-task3.mjs
 * Task 3a: Fund faucet EVM with 1.0 FLOW via CrossVM (COA deposit)
 * Then Task 3b mint mUSDC is done via cast send
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

fcl.config()
  .put("accessNode.api", TESTNET_ACCESS_NODE)
  .put("flow.network", "testnet");

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

const FUND_FAUCET_EVM_TX = `
import EVM from 0x8c5303eaa26202d6
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(amount: UFix64) {
  let coa: auth(EVM.Withdraw) &EVM.CadenceOwnedAccount
  let flowVault: auth(FungibleToken.Withdraw) &FlowToken.Vault

  prepare(signer: auth(SaveValue, BorrowValue, Capabilities) &Account) {
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

const GET_COA_ADDR_SCRIPT = `
import EVM from 0x8c5303eaa26202d6

access(all) fun main(cadenceAddr: Address): String {
  let acc = getAuthAccount<auth(BorrowValue) &Account>(cadenceAddr)
  let coa = acc.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm)
    ?? panic("No COA found")
  return coa.address().toString()
}
`;

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
  console.log("\n=== Task 3a: Fund faucet COA with 1.0 FLOW ===");
  try {
    const tx3 = await sendTx(
      FUND_FAUCET_EVM_TX,
      (arg, t) => [arg("1.00000000", t.UFix64)],
      faucetAuthz
    );
    console.log(`RESULT task3_coa_fund: ${tx3}`);
  } catch (e) {
    console.error("Task 3a error:", e.message);
    // Try to get COA address anyway
  }

  console.log("\n=== Get faucet COA EVM address ===");
  try {
    const coaAddr = await fcl.query({
      cadence: GET_COA_ADDR_SCRIPT,
      args: (arg, t) => [arg("0x62696428106552cf", t.Address)],
    });
    console.log(`Faucet COA EVM address: ${coaAddr}`);
  } catch (e) {
    console.error("COA address query error:", e.message);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
