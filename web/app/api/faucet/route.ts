/// Testnet faucet — multi-token (FLOW, mUSDC, MockFT) — v0.6.
///
/// Env required (set in Vercel):
///   FAUCET_FLOW_ADDR  — funded Cadence wallet address (with 0x prefix)
///   FAUCET_FLOW_PKEY  — 32-byte hex ECDSA_P256 + SHA3_256 private key
///   FAUCET_EVM_PKEY   — 32-byte hex EVM private key (for mUSDC ERC20 transfer)
///
/// Rate limit: per-IP, per-token, 24h cooldown.
///
/// Token-specific amounts:
///   flow     → 1.0 FLOW (via Cadence FCL tx)
///   mockusdc → 10 mUSDC (via ERC20 transfer from faucet EVM wallet)
///   mockft   → 10 MockFT (via Cadence FCL tx from faucet vault)

import * as fcl from "@onflow/fcl";
import { ec as EC } from "elliptic";
import { SHA3 } from "sha3";
import { ethers } from "ethers";

export const runtime = "nodejs";

const TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";
const FAUCET_KEY_INDEX = 0;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h per IP per token

const FAUCET_ADDR = process.env.FAUCET_FLOW_ADDR ?? "";
const FAUCET_PKEY = process.env.FAUCET_FLOW_PKEY ?? "";
const FAUCET_EVM_PKEY = process.env.FAUCET_EVM_PKEY ?? FAUCET_PKEY; // fallback to Flow pkey if same wallet

// In-memory rate limit. Map<`${ip}:${token}`, lastClaimMs>
const lastClaim = new Map<string, number>();

function rateLimitKey(ip: string, token: string): string {
  return `${ip}:${token}`;
}

// Configure FCL for testnet on first call.
let configured = false;
function configureFcl() {
  if (configured) return;
  fcl
    .config()
    .put("accessNode.api", TESTNET_ACCESS_NODE)
    .put("flow.network", "testnet");
  configured = true;
}

// ─── ECDSA_P256 + SHA3_256 signer for the funded faucet Cadence wallet ──────

function signWithFaucet(msgHex: string): string {
  const ec = new EC("p256");
  const key = ec.keyFromPrivate(Buffer.from(FAUCET_PKEY, "hex"));
  const sha = new SHA3(256);
  sha.update(Buffer.from(msgHex, "hex"));
  const digest = sha.digest();
  const sig = key.sign(digest);
  const n = 32;
  return Buffer.concat([
    sig.r.toArrayLike(Buffer, "be", n),
    sig.s.toArrayLike(Buffer, "be", n),
  ]).toString("hex");
}

interface FclAccount {
  tempId?: string;
  addr?: string;
  keyId?: number;
  signingFunction?: (signable: { message: string }) => unknown;
}

async function faucetAuthz(account: FclAccount): Promise<FclAccount> {
  const addrNoPrefix = FAUCET_ADDR.replace(/^0x/, "");
  return {
    ...account,
    tempId: `${addrNoPrefix}-${FAUCET_KEY_INDEX}`,
    addr: addrNoPrefix,
    keyId: FAUCET_KEY_INDEX,
    signingFunction: (signable: { message: string }) => ({
      addr: addrNoPrefix,
      keyId: FAUCET_KEY_INDEX,
      signature: signWithFaucet(signable.message),
    }),
  };
}

// ─── Cadence transaction templates ──────────────────────────────────────────

const TRANSFER_FLOW_TX = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(amount: UFix64, to: Address) {
  let sentVault: @{FungibleToken.Vault}

  prepare(signer: auth(BorrowValue) &Account) {
    let vault = signer.storage
      .borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
        from: /storage/flowTokenVault
      ) ?? panic("Faucet vault not borrowable")
    self.sentVault <- vault.withdraw(amount: amount)
  }

  execute {
    let recipient = getAccount(to)
    let receiver = recipient.capabilities
      .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
      ?? panic("Recipient has no FlowToken.Receiver capability")
    receiver.deposit(from: <-self.sentVault)
  }
}
`;

// MockFT transfer from faucet Cadence vault to recipient.
// v0.8: MockFT deployed at 0x4b6bc58bc8bf5dcc (TOKEN_REGISTRY.mockft.ftAddress).
const MOCKFT_CADENCE_ADDR = "0x4b6bc58bc8bf5dcc";
const MOCKFT_CONTRACT = "MockFT";

const TRANSFER_MOCKFT_TX = `
import FungibleToken from 0x9a0766d93b6608b7
import MockFT from ${MOCKFT_CADENCE_ADDR}

transaction(amount: UFix64, to: Address) {
  let sentVault: @{FungibleToken.Vault}

  prepare(signer: auth(BorrowValue) &Account) {
    let vault = signer.storage
      .borrow<auth(FungibleToken.Withdraw) &MockFT.Vault>(
        from: /storage/mockFTVault
      ) ?? panic("Faucet MockFT vault not found")
    self.sentVault <- vault.withdraw(amount: amount)
  }

  execute {
    let recipient = getAccount(to)
    let receiver = recipient.capabilities
      .borrow<&{FungibleToken.Receiver}>(/public/mockFTReceiver)
      ?? panic("Recipient has no MockFT receiver capability")
    receiver.deposit(from: <-self.sentVault)
  }
}
`;

// ─── EVM provider for mUSDC ─────────────────────────────────────────────────

const FLOW_EVM_RPC = "https://testnet.evm.nodes.onflow.org";
const EVM_CHAIN_ID = 545;

// mUSDC ERC20 address on Flow EVM testnet — v0.8 underlying (was 0x686E… v0.7).
// Faucet sends underlying mUSDC directly (not the shielded proxy).
const MOCK_USDC_ADDR = "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524";

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

// ─── Token amounts ──────────────────────────────────────────────────────────

const TOKEN_AMOUNTS: Record<string, { display: string; cadenceUFix64?: string; weiAmount?: bigint }> = {
  flow:     { display: "1.0 FLOW",    cadenceUFix64: "1.00000000" },
  mockusdc: { display: "10 mUSDC",    weiAmount: 10n * 10n ** 6n },     // 6 decimals
  mockft:   { display: "10 MockFT",   cadenceUFix64: "10.00000000" },
};

// ─── Request handler ─────────────────────────────────────────────────────────

interface FaucetRequest {
  address?: string;
  token?: string;
}

export async function POST(req: Request) {
  if (!FAUCET_ADDR || !FAUCET_PKEY) {
    return Response.json(
      { error: "Faucet not configured (server env missing)" },
      { status: 503 }
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  let body: FaucetRequest;
  try {
    body = (await req.json()) as FaucetRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const address = body.address?.trim() ?? "";
  const token = (body.token?.trim() ?? "flow").toLowerCase();

  if (!/^0x[a-fA-F0-9]{16}$/.test(address)) {
    return Response.json(
      { error: "Invalid Flow address — expected 0x + 16 hex chars" },
      { status: 400 }
    );
  }

  if (!["flow", "mockusdc", "mockft"].includes(token)) {
    return Response.json(
      { error: "Invalid token — must be flow|mockusdc|mockft" },
      { status: 400 }
    );
  }

  // Rate limit: per-IP per-token.
  const rlKey = rateLimitKey(ip, token);
  const last = lastClaim.get(rlKey);
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) {
    const remainingH = Math.ceil((COOLDOWN_MS - (now - last)) / 1000 / 60 / 60);
    return Response.json(
      { error: `Already claimed ${token} from this IP. Try again in ~${remainingH}h.` },
      { status: 429 }
    );
  }

  const tokenConfig = TOKEN_AMOUNTS[token];
  if (!tokenConfig) {
    return Response.json({ error: "Token not supported" }, { status: 400 });
  }

  configureFcl();

  // Optimistic rate-limit record.
  lastClaim.set(rlKey, now);

  try {
    // -- FLOW (send FLOW via Cadence) -----------------------------------------
    if (token === "flow") {
      const txId = await fcl.mutate({
        cadence: TRANSFER_FLOW_TX,
        args: (
          arg: (v: unknown, t: unknown) => unknown,
          t: Record<string, unknown>
        ) => [arg(tokenConfig.cadenceUFix64!, t.UFix64), arg(address, t.Address)],
        proposer: faucetAuthz as never,
        payer: faucetAuthz as never,
        authorizations: [faucetAuthz as never],
        limit: 1000,
      });

      return Response.json({
        txId,
        amount: tokenConfig.display,
        token,
        recipient: address,
        explorerUrl: `https://testnet.flowscan.io/tx/${txId}`,
      });
    }

    // -- MockFT (Cadence FT transfer) ------------------------------------------
    if (token === "mockft") {
      const txId = await fcl.mutate({
        cadence: TRANSFER_MOCKFT_TX,
        args: (
          arg: (v: unknown, t: unknown) => unknown,
          t: Record<string, unknown>
        ) => [arg(tokenConfig.cadenceUFix64!, t.UFix64), arg(address, t.Address)],
        proposer: faucetAuthz as never,
        payer: faucetAuthz as never,
        authorizations: [faucetAuthz as never],
        limit: 1000,
      });

      return Response.json({
        txId,
        amount: tokenConfig.display,
        token,
        recipient: address,
        explorerUrl: `https://testnet.flowscan.io/tx/${txId}`,
      });
    }

    // -- mUSDC (ERC20 transfer from faucet EVM wallet) -------------------------
    if (token === "mockusdc") {
      if (!FAUCET_EVM_PKEY) {
        return Response.json(
          { error: "FAUCET_EVM_PKEY not set — mUSDC faucet unavailable" },
          { status: 503 }
        );
      }

      const provider = new ethers.JsonRpcProvider(FLOW_EVM_RPC, EVM_CHAIN_ID);
      const wallet = new ethers.Wallet(FAUCET_EVM_PKEY, provider);
      const erc20 = new ethers.Contract(MOCK_USDC_ADDR, ERC20_TRANSFER_ABI, wallet);

      // Resolve recipient COA EVM address. mUSDC is ERC20 on Flow EVM.
      // The faucet sends mUSDC to the user's COA address.
      // For simplicity: send to a well-known address format — caller must have COA.
      // We call a Cadence script to get the COA address.
      let recipientEvmAddr: string;
      try {
        const { getCoaEvmAddress } = await import("@claucondor/sdk/network");
        const coa = await getCoaEvmAddress(address, "testnet");
        recipientEvmAddr = coa;
      } catch {
        return Response.json(
          { error: "Recipient has no COA (EVM bridge). Run setup first." },
          { status: 400 }
        );
      }

      const tx = await erc20.transfer(recipientEvmAddr, tokenConfig.weiAmount!);
      const receipt = await tx.wait();

      return Response.json({
        txId: receipt?.hash ?? tx.hash,
        amount: tokenConfig.display,
        token,
        recipient: address,
        recipientEvm: recipientEvmAddr,
        explorerUrl: `https://evm-testnet.flowscan.io/tx/${receipt?.hash ?? tx.hash}`,
      });
    }

    return Response.json({ error: "Unhandled token path" }, { status: 500 });

  } catch (err) {
    lastClaim.delete(rlKey); // rollback rate limit on error
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Faucet tx failed: ${msg}` }, { status: 500 });
  }
}

// ─── GET — faucet config ─────────────────────────────────────────────────────

export async function GET() {
  return Response.json({
    enabled: !!FAUCET_ADDR && !!FAUCET_PKEY,
    address: FAUCET_ADDR || null,
    cooldownHours: COOLDOWN_MS / 1000 / 60 / 60,
    tokens: {
      flow:     { amount: TOKEN_AMOUNTS.flow.display,     cooldownHours: 24 },
      mockusdc: { amount: TOKEN_AMOUNTS.mockusdc.display, cooldownHours: 24, requiresCOA: true },
      mockft:   { amount: TOKEN_AMOUNTS.mockft.display,   cooldownHours: 24 },
    },
  });
}
