/// FCL Configuration for PrivateTip.
///
/// Contract aliases (0xJanusFlow, 0xPrivateTip, 0xEVM) are sourced from
/// flow.json rather than hardcoded here. This ensures that a single edit
/// to flow.json propagates to all Cadence scripts and transactions — the
/// pattern mirrors how FlowProvider consumes flowJSON in client-layout.tsx.
///
/// To add mainnet support: add a "mainnet" alias entry for JanusFlow and
/// PrivateTip in web/flow.json and update accessNodeUrl + discoveryWallet.

import * as fcl from "@onflow/fcl";
import flowJSON from "../flow.json";

export interface PrivateTipConfig {
  accessNodeUrl: string;
  flowNetwork: "testnet";
  discoveryWallet: string;
  appDetailTitle: string;
  appDetailDescription: string;
  appDetailUrl: string;
  appDetailIcon: string;
}

/**
 * FlowProvider configuration for testnet (consumed by @onflow/react-sdk).
 */
export const flowConfig: PrivateTipConfig = {
  accessNodeUrl: "https://rest-testnet.onflow.org",
  flowNetwork: "testnet",
  discoveryWallet: "https://fcl-discovery.onflow.org/testnet/authn",
  appDetailTitle: "PrivateTip",
  appDetailDescription:
    "Confidential tipping on Flow — send and receive tips with hidden amounts",
  appDetailUrl: typeof window !== "undefined"
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_URL ?? "https://privatetip.condordev.xyz"),
  appDetailIcon: "https://lucide.dev/icons/gift",
};

/**
 * Explicit FCL config — ensures the underlying @onflow/fcl singleton is
 * initialised before any `fcl.query()` / `fcl.mutate()` calls fire (including
 * server-side proof routes that call fcl from Next.js API handlers).
 *
 * @onflow/react-sdk's FlowProvider also calls this, but only on client mount;
 * routes that hit fcl before mount (or from the server) would otherwise see
 * "Required value for accessNode.api not defined in config".
 */
// WalletConnect projectId: get one free at https://cloud.reown.com
// Without this, mobile/QR wallets (Lilico mobile, WalletConnect-based) won't work.
// Flow Wallet extension + Blocto still work without it.
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// ─── Resolve contract aliases from flow.json ────────────────────────────────
//
// flow.json is the single source of truth for per-network contract addresses.
// FlowProvider receives flowJSON directly (client-layout.tsx) and FCL itself
// resolves import aliases at runtime. We also feed the same values into the
// FCL singleton here so that server-side proof routes (which call fcl.query /
// fcl.mutate before client mount) see the same aliases.
//
// To support a new network: add alias entries in web/flow.json under the
// relevant network key. No changes needed in this file.

type FlowJsonContracts = typeof flowJSON.contracts;
type ContractEntry = { aliases?: Record<string, string> };

function resolveAlias(contractName: keyof FlowJsonContracts, network: string): string | undefined {
  const entry = (flowJSON.contracts as Record<string, ContractEntry>)[contractName as string];
  return entry?.aliases?.[network];
}

const network = flowConfig.flowNetwork; // "testnet" | future: "mainnet"

const janusFlowAddr  = resolveAlias("JanusFlow",  network);
const privateTipAddr = resolveAlias("PrivateTip",  network);
const evmAddr        = resolveAlias("EVM",         network);

const fclConfig = fcl
  .config()
  .put("accessNode.api", flowConfig.accessNodeUrl)
  .put("flow.network", flowConfig.flowNetwork)
  .put("discovery.wallet", flowConfig.discoveryWallet)
  .put("app.detail.title", flowConfig.appDetailTitle)
  .put("app.detail.description", flowConfig.appDetailDescription)
  .put("app.detail.url", flowConfig.appDetailUrl)
  .put("app.detail.icon", flowConfig.appDetailIcon);

// Contract aliases for `import "JanusFlow"` etc. in inline Cadence.
// Guarded so that missing flow.json entries don't silently put "undefined"
// into the FCL config (which would cause cryptic tx failures).
if (janusFlowAddr)  fclConfig.put("0xJanusFlow",  `0x${janusFlowAddr}`);
if (privateTipAddr) fclConfig.put("0xPrivateTip", `0x${privateTipAddr}`);
if (evmAddr)        fclConfig.put("0xEVM",        `0x${evmAddr}`);

if (WALLETCONNECT_PROJECT_ID) {
  fclConfig.put("walletconnect.projectId", WALLETCONNECT_PROJECT_ID);
}

/**
 * Current-network Cadence contract addresses, sourced from flow.json.
 * Use TOKEN_REGISTRY.flow.proxy (from @claucondor/sdk) for the EVM proxy address.
 */
export const ADDRESSES = {
  JANUS_FLOW_CADENCE: janusFlowAddr ? `0x${janusFlowAddr}` : "0x5dcbeb41055ec57e",
  PRIVATE_TIP_CADENCE: privateTipAddr ? `0x${privateTipAddr}` : "0xb9ac529c14a4c5a1",
} as const;

/** Helper to determine dev mode. */
export const isDev = process.env.NODE_ENV === "development";

/** Testnet banner message. */
export const TESTNET_BANNER = isDev
  ? "Testnet Mode — No real FLOW is used"
  : "Testnet — This app is for testing only";
