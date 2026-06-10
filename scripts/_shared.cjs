"use strict";
/**
 * _shared.cjs — Shared constants, helpers, and providers for PrivateTip v0.8 scripts.
 *
 * All scripts require() this module. Never imported directly by the front-end.
 * Front-end consumes the JSON stdout from each script.
 */

const { ethers } = require("ethers");
const { execSync }  = require("child_process");
const { sdk, ShieldedInboxClient, ShieldedCheckpointClient,
        deriveMemoKeyFromSignature, pubkeyFromPrivkey,
        FLOW_EVM_RPC, TOKEN_REGISTRY,
        orchestrateShieldedTransfer } = require("@claucondor/sdk");

// ── Deployed addresses (v0.8 testnet, chainId 545) ──────────────────────────

const ADDRESSES = {
  janusFlow:          "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
  janusERC20:         "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
  mockUSDC:           "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524",
  memoRegistry:       "0x361bD4d037838A3a9c5408AE465d36077800ee6c",
  shieldedInbox:      "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6",
  shieldedCheckpoint: "0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76",
  cadenceDeployer:    "0x4b6bc58bc8bf5dcc",  // JanusFT, JanusFT, PrivateTip
  deployCOA:          "0x0000000000000000000000020885d7ad3582356a",
};

// Token symbol → depositor address (for inbox note disambiguation)
const TOKEN_BY_DEPOSITOR = {
  [ADDRESSES.janusFlow.toLowerCase()]:  { symbol: "FLOW",   decimals: 18 },
  [ADDRESSES.janusERC20.toLowerCase()]: { symbol: "mUSDC",  decimals: 6  },
  [ADDRESSES.cadenceDeployer]:          { symbol: "MockFT", decimals: 8  },
};

// Deployer EOA (Alice) — used by faucet + admin scripts
const DEPLOYER_EOA_KEY = "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
const DEPLOYER_EOA_ADDR = "0xFc47B35f79d26A060B652E112c53d7c6057d05FF";

// ── EVM provider ─────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(FLOW_EVM_RPC);

function makeWallet(privkey) {
  if (!privkey) throw new Error("--evm-key is required for this operation");
  const k = privkey.startsWith("0x") ? privkey : "0x" + privkey;
  return new ethers.Wallet(k, provider);
}

// ── BabyJub keypair helpers ───────────────────────────────────────────────────

const MEMOKEY_SIGN_MSG = "OpenJanus MemoKey v1";

/**
 * Derive BabyJub keypair from EVM wallet signature (deterministic).
 * Use this for new key generation — the same wallet always produces the same keypair.
 */
async function deriveMemoKeypair(wallet) {
  const sig = await wallet.signMessage(MEMOKEY_SIGN_MSG);
  return deriveMemoKeyFromSignature(ethers.getBytes(sig));
}

/**
 * Build a keypair from an explicit BabyJub private key (bigint or decimal string).
 */
async function keypairFromPriv(privStr) {
  const priv = BigInt(privStr);
  const pub = await pubkeyFromPrivkey(priv);
  return { privkey: priv, pubkey: pub };
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) external returns (bool)",
  "function mint(address,uint256) external",
];

const MEMO_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y) external",
  "function rotateMemoKey(uint256 newX, uint256 newY) external",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];

const JANUS_VIEW_ABI = [
  "function balanceOfCommitmentXY(address) view returns (uint256,uint256)",
  "function totalLocked() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function feeBps() view returns (uint16)",
];

const SHIELDED_FLOW_TRANSFER_ABI = [
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
];

// ── Flow CLI helper ──────────────────────────────────────────────────────────

const REPO_ROOT = "/home/oydual3/zkapps/private-tip-v1";

/**
 * Run a `flow` CLI subcommand against testnet.
 * Returns stdout as a string. Throws on non-zero exit code.
 */
function flowCLI(args) {
  const cmd = `flow ${args} --network testnet`;
  return execSync(cmd, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Execute a Cadence script and return raw stdout.
 * scriptPath is relative to REPO_ROOT.
 */
function flowScript(scriptPath, argsStr = "") {
  return flowCLI(`scripts execute ${scriptPath}${argsStr ? " " + argsStr : ""}`);
}

/**
 * Send a Cadence transaction and return the tx ID.
 * txPath is relative to REPO_ROOT. signerAccount is from flow.json.
 */
function flowTx(txPath, signerAccount, argsStr = "") {
  const out = flowCLI(
    `transactions send ${txPath} ${argsStr} --signer ${signerAccount}`
  );
  const match = out.match(/ID\s+([0-9a-f]{64})/i);
  return { txId: match ? match[1] : null, stdout: out };
}

// ── Cadence arg builders ──────────────────────────────────────────────────────

/**
 * Build --arg flags for flow CLI from an array of { type, value } objects.
 * flow transactions send foo.cdc --arg 'Type:value' ...
 */
function buildArgs(argDefs) {
  return argDefs.map(({ type, value }) => `--arg '${type}:${value}'`).join(" ");
}

// ── JSON output ───────────────────────────────────────────────────────────────

/**
 * Serialize bigints as strings in JSON output.
 */
function bigintReplacer(key, val) {
  return typeof val === "bigint" ? val.toString() : val;
}

function jsonOutput(data) {
  process.stdout.write(JSON.stringify(data, bigintReplacer, 2) + "\n");
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatDecimals(wei, decimals) {
  const factor = 10n ** BigInt(decimals);
  const whole   = wei / factor;
  const frac    = ((wei % factor) * 1000000n / factor).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${whole}.${frac}`;
}

// ── Shared re-exports ──────────────────────────────────────────────────────────

module.exports = {
  // SDK pieces
  sdk,
  ShieldedInboxClient,
  ShieldedCheckpointClient,
  orchestrateShieldedTransfer,
  // helpers
  provider,
  makeWallet,
  deriveMemoKeypair,
  keypairFromPriv,
  flowCLI,
  flowScript,
  flowTx,
  buildArgs,
  jsonOutput,
  bigintReplacer,
  formatDecimals,
  // ABIs
  ERC20_ABI,
  MEMO_REGISTRY_ABI,
  JANUS_VIEW_ABI,
  SHIELDED_FLOW_TRANSFER_ABI,
  // constants
  ADDRESSES,
  TOKEN_BY_DEPOSITOR,
  DEPLOYER_EOA_KEY,
  DEPLOYER_EOA_ADDR,
  MEMOKEY_SIGN_MSG,
};
