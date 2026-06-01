/// Testnet FLOW faucet — sends 1 FLOW to the requested address from the
/// funded wallet (0x62696428106552cf). Rate limited by IP, 24h cooldown.
///
/// Env required (set in Vercel):
///   FAUCET_FLOW_ADDR  — funded wallet address (with 0x prefix)
///   FAUCET_FLOW_PKEY  — 32-byte hex private key (ECDSA_P256, SHA3_256)

import * as fcl from "@onflow/fcl";
import { ec as EC } from "elliptic";
import { SHA3 } from "sha3";

const TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";
const FAUCET_KEY_INDEX = 0;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h per IP
const AMOUNT_FLOW = "1.0"; // 1 FLOW per claim

const FAUCET_ADDR = process.env.FAUCET_FLOW_ADDR ?? "";
const FAUCET_PKEY = process.env.FAUCET_FLOW_PKEY ?? "";

// In-memory rate limit (resets on cold start — acceptable for testnet faucet).
// Map<ip, lastClaimMs>
const lastClaim = new Map<string, number>();

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

/// ECDSA_P256 + SHA3_256 signer for the funded faucet wallet.
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

// Explicit testnet contract addresses — FCL string imports require flow.json
// resolution which doesn't happen in this standalone route. Hardcoding the
// testnet aliases is safe since the faucet is testnet-only by design.
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

interface FaucetRequest {
  address?: string;
}

export async function POST(req: Request) {
  if (!FAUCET_ADDR || !FAUCET_PKEY) {
    return Response.json(
      { error: "Faucet not configured (server env missing)" },
      { status: 503 }
    );
  }

  // Rate limit by IP — first hop in x-forwarded-for, fallback to "unknown".
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const last = lastClaim.get(ip);
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) {
    const remainingMs = COOLDOWN_MS - (now - last);
    const remainingH = Math.ceil(remainingMs / 1000 / 60 / 60);
    return Response.json(
      {
        error: `Already claimed from this IP. Try again in ~${remainingH}h.`,
        retryAfterMs: remainingMs,
      },
      { status: 429 }
    );
  }

  let body: FaucetRequest;
  try {
    body = (await req.json()) as FaucetRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const address = body.address?.trim() ?? "";
  if (!/^0x[a-fA-F0-9]{16}$/.test(address)) {
    return Response.json(
      { error: "Invalid Flow address — expected 0x + 16 hex chars" },
      { status: 400 }
    );
  }

  configureFcl();

  try {
    const txId = await fcl.mutate({
      cadence: TRANSFER_FLOW_TX,
      args: (
        arg: (v: unknown, t: unknown) => unknown,
        t: Record<string, unknown>
      ) => [arg(AMOUNT_FLOW, t.UFix64), arg(address, t.Address)],
      proposer: faucetAuthz as never,
      payer: faucetAuthz as never,
      authorizations: [faucetAuthz as never],
      limit: 1000,
    });

    // Optimistic rate-limit — record immediately so concurrent requests
    // are gated even before the tx seals.
    lastClaim.set(ip, now);

    return Response.json({
      txId,
      amount: AMOUNT_FLOW,
      recipient: address,
      explorerUrl: `https://testnet.flowscan.io/tx/${txId}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Faucet tx failed: ${msg}` },
      { status: 500 }
    );
  }
}

/// GET — returns faucet config (for UI to show address + cooldown).
export async function GET() {
  return Response.json({
    enabled: !!FAUCET_ADDR && !!FAUCET_PKEY,
    address: FAUCET_ADDR || null,
    amountPerClaim: AMOUNT_FLOW,
    cooldownHours: COOLDOWN_MS / 1000 / 60 / 60,
  });
}
