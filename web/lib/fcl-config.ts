/// FCL Configuration for PrivateTip on Flow Testnet — v0.3.
///
/// IMPORTANT: PrivateTip is configured for TESTNET only. Mainnet deployment
/// requires updating ALL contract addresses + accessNodeUrl + walletDiscovery
/// before use.
///
/// v0.3 canonical addresses (production set):
///   JanusFlow EVM UUPS proxy:  0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156
///   JanusFlow Cadence router:  0x5dcbeb41055ec57e
///   PrivateTip Cadence router: 0xb9ac529c14a4c5a1

import * as fcl from "@onflow/fcl";

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

const fclConfig = fcl
  .config()
  .put("accessNode.api", flowConfig.accessNodeUrl)
  .put("flow.network", flowConfig.flowNetwork)
  .put("discovery.wallet", flowConfig.discoveryWallet)
  .put("app.detail.title", flowConfig.appDetailTitle)
  .put("app.detail.description", flowConfig.appDetailDescription)
  .put("app.detail.url", flowConfig.appDetailUrl)
  .put("app.detail.icon", flowConfig.appDetailIcon)
  // Contract aliases for `import "JanusFlow"` etc. in inline cadence
  .put("0xJanusFlow", "0x5dcbeb41055ec57e")
  .put("0xPrivateTip", "0xb9ac529c14a4c5a1")
  // EVM core contract (needed for COA setup tx with `import "EVM"`)
  .put("0xEVM", "0x8c5303eaa26202d6");

if (WALLETCONNECT_PROJECT_ID) {
  fclConfig.put("walletconnect.projectId", WALLETCONNECT_PROJECT_ID);
}

/**
 * v0.3 canonical contract addresses.
 */
export const ADDRESSES = {
  JANUS_FLOW_EVM: "0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156",
  JANUS_FLOW_CADENCE: "0x5dcbeb41055ec57e",
  PRIVATE_TIP_CADENCE: "0xb9ac529c14a4c5a1",
} as const;

/** Helper to determine dev mode. */
export const isDev = process.env.NODE_ENV === "development";

/** Testnet banner message. */
export const TESTNET_BANNER = isDev
  ? "Testnet Mode — No real FLOW is used"
  : "Testnet — This app is for testing only";
