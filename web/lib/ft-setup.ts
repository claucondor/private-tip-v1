/// Fungible Token receiver-vault setup helpers — generic, mainnet-ready.
///
/// Custom Cadence FTs (MockFT, real USDC, USDT, etc.) require each user to
/// opt in by creating their own vault before they can receive the token.
/// FLOW is the only token whose receiver is auto-created at account creation.
///
/// Usage:
///   const cfg = FT_CONFIGS.mockft;
///   const ready = await checkReceiverCapability(addr, cfg);
///   if (!ready) await signSetupTx(cfg);

// ─── FT config type ────────────────────────────────────────────────────────────

export interface FTSetupConfig {
  /** Cadence contract address, e.g. "0x7599043aea001283" */
  contractAddress: string;
  /** Contract name, e.g. "MockFT" */
  contractName: string;
  /** FungibleToken core address (testnet) */
  fungibleTokenAddress: string;
  /** /storage/... path for the vault */
  vaultStoragePath: string;
  /** /public/... path for the Receiver capability */
  receiverPublicPath: string;
  /** /public/... path for the Balance capability */
  balancePublicPath: string;
}

// ─── Token configs ─────────────────────────────────────────────────────────────

/** Testnet FungibleToken address. Update to mainnet address on mainnet deploy. */
const FUNGIBLE_TOKEN_TESTNET = "0x9a0766d93b6608b7";

/**
 * Known FT configs. Add USDC, USDT etc. here for mainnet.
 * Paths follow Cadence convention: contractName lowercased for the path segment.
 *   MockFT → mockFTVault / mockFTReceiver / mockFTBalance
 */
export const FT_CONFIGS: Record<string, FTSetupConfig> = {
  mockft: {
    contractAddress: "0x7599043aea001283",
    contractName: "MockFT",
    fungibleTokenAddress: FUNGIBLE_TOKEN_TESTNET,
    vaultStoragePath: "/storage/mockFTVault",
    receiverPublicPath: "/public/mockFTReceiver",
    balancePublicPath: "/public/mockFTBalance",
  },
  // Extend here for mainnet:
  // usdc: {
  //   contractAddress: "0x...",
  //   contractName: "FiatToken",
  //   fungibleTokenAddress: "0x...",
  //   vaultStoragePath: "/storage/usdcVault",
  //   receiverPublicPath: "/public/usdcReceiver",
  //   balancePublicPath: "/public/usdcBalance",
  // },
};

// ─── Cadence script: check if receiver capability is published ─────────────────

/**
 * Returns the Cadence script text for checking whether `addr` has published
 * the receiver capability for the given FT. Works client-side (fcl.query)
 * or server-side.
 */
export function buildCheckReceiverScript(cfg: FTSetupConfig): string {
  return `
import FungibleToken from ${cfg.fungibleTokenAddress}

access(all) fun main(addr: Address): Bool {
  let acc = getAccount(addr)
  return acc.capabilities.get<&{FungibleToken.Receiver}>(${cfg.receiverPublicPath}).check()
}
`.trim();
}

/**
 * Check whether `addr` has the receiver capability published for the given FT.
 * Returns true (vault ready) or false (needs setup). Throws on script error.
 */
export async function checkReceiverCapability(
  addr: string,
  cfg: FTSetupConfig
): Promise<boolean> {
  // FCL is client-only — lazy import so server-side pages don't break.
  const fcl = await import("@onflow/fcl");
  const script = buildCheckReceiverScript(cfg);
  const result: boolean = await fcl.query({
    cadence: script,
    args: (arg: (v: unknown, t: unknown) => unknown, t: Record<string, unknown>) => [
      arg(addr, t.Address),
    ],
  });
  return result;
}

// ─── Cadence transaction: setup vault + capabilities ──────────────────────────

/**
 * Returns the Cadence transaction template for setting up the vault.
 * The tx is idempotent — safe to re-run if vault already exists.
 */
export function setupVaultTx(cfg: FTSetupConfig): string {
  return `
import FungibleToken from ${cfg.fungibleTokenAddress}
import ${cfg.contractName} from ${cfg.contractAddress}

transaction {
  prepare(signer: auth(SaveValue, Capabilities, IssueStorageCapabilityController, PublishCapability) &Account) {
    // Idempotent — skip if already set up
    if signer.storage.borrow<&${cfg.contractName}.Vault>(from: ${cfg.vaultStoragePath}) != nil {
      return
    }

    // Create empty vault
    let vault <- ${cfg.contractName}.createEmptyVault(vaultType: Type<@${cfg.contractName}.Vault>())
    signer.storage.save(<-vault, to: ${cfg.vaultStoragePath})

    // Publish receiver capability
    let receiverCap = signer.capabilities.storage.issue<&{FungibleToken.Receiver}>(${cfg.vaultStoragePath})
    signer.capabilities.publish(receiverCap, at: ${cfg.receiverPublicPath})

    // Publish balance capability
    let balanceCap = signer.capabilities.storage.issue<&{FungibleToken.Balance}>(${cfg.vaultStoragePath})
    signer.capabilities.publish(balanceCap, at: ${cfg.balancePublicPath})
  }
}
`.trim();
}

// ─── Sign + submit the setup tx ────────────────────────────────────────────────

export interface SetupTxResult {
  txId: string;
}

/**
 * Asks the connected Flow Wallet to sign the vault-setup transaction for `cfg`.
 * Awaits sealing before resolving.
 */
export async function signSetupTx(cfg: FTSetupConfig): Promise<SetupTxResult> {
  const fcl = await import("@onflow/fcl");
  const cadence = setupVaultTx(cfg);
  const txId = await fcl.mutate({
    cadence,
    args: () => [],
    proposer: fcl.authz,
    payer: fcl.authz,
    authorizations: [fcl.authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return { txId };
}
