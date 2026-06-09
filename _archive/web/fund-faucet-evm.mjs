/**
 * fund-faucet-evm.mjs
 * 1. Transfer FLOW from faucet COA → faucet EOA (0xB54A603Cd7A46dfe7951CC3D218e73BBB6fd62C3) for gas
 * 2. Print the COA EVM address for reference
 */

import * as fcl from "@onflow/fcl";
import ellipticPkg from "elliptic";
const { ec: EC } = ellipticPkg;
import sha3Pkg from "sha3";
const { SHA3 } = sha3Pkg;
import crypto from "crypto";

const TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";

const FAUCET_ADDR = "62696428106552cf";
const FAUCET_PKEY = "be0a96640090b30a18e2b159656cb46ca42cdf49dc276f06568ae85c2a7a3518";
const FAUCET_KEY_INDEX = 0;

// EOA derived from same pkey via secp256k1 (what the faucet route uses)
const FAUCET_EOA = "0xB54A603Cd7A46dfe7951CC3D218e73BBB6fd62C3";

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

// Send FLOW from COA to an arbitrary EVM EOA via coa.call with value
const TRANSFER_COA_TO_EOA_TX = `
import EVM from 0x8c5303eaa26202d6

transaction(toEvmAddr: String, attoflow: UInt) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA found — run task3a first")
  }

  execute {
    let addrBytes = toEvmAddr.decodeHex()
    assert(addrBytes.length == 20, message: "EVM address must be 20 bytes")
    var arr: [UInt8; 20] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
    var i = 0
    while i < 20 {
      arr[i] = addrBytes[i]
      i = i + 1
    }
    let dest = EVM.EVMAddress(bytes: arr)
    let result = self.coa.call(
      to: dest,
      data: [],
      gasLimit: 21000,
      value: EVM.Balance(attoflow: attoflow)
    )
    assert(result.status == EVM.Status.successful, message: "EVM call failed")
  }
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
  console.log(`  TX sealed: ${txId}`);
  return txId;
}

async function main() {
  // Transfer 0.5 FLOW (in attoflow = 0.5 * 10^18) from COA to faucet EOA
  // 0.5 FLOW = 500000000000000000 attoflow  (UInt, not UInt256)
  const attoflow = "500000000000000000"; // 0.5 FLOW as UInt string
  const addrHex = FAUCET_EOA.replace(/^0x/, "").toLowerCase();

  console.log(`\n=== Transfer 0.5 FLOW from COA → EOA ${FAUCET_EOA} ===`);
  try {
    const txId = await sendTx(
      TRANSFER_COA_TO_EOA_TX,
      (arg, t) => [
        arg(addrHex, t.String),
        arg(attoflow, t.UInt),
      ],
      faucetAuthz
    );
    console.log(`RESULT coa_to_eoa: ${txId}`);
  } catch (e) {
    console.error("COA→EOA transfer error:", e.message);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
