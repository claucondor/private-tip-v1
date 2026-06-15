/**
 * explorer.ts — Flowscan URL helpers for Cadence + EVM (v0.8)
 *
 * Build clickable URLs to view transactions and addresses on Flowscan testnet.
 *
 * Cadence transactions live at https://testnet.flowscan.io/tx/{id}.
 * EVM transactions live at https://evm-testnet.flowscan.io/tx/{hash}.
 *
 * These helpers are consumed by /wrap, /send, /claim result cards (Phases 4-6)
 * and already by /api/faucet (which currently inlines the URLs).
 */

export const FLOWSCAN_CADENCE_TX = (txId: string): string =>
  `https://testnet.flowscan.io/tx/${txId.startsWith("0x") ? txId.slice(2) : txId}`;

export const FLOWSCAN_EVM_TX = (hash: string): string =>
  `https://evm-testnet.flowscan.io/tx/${hash.startsWith("0x") ? hash : "0x" + hash}`;

export const FLOWSCAN_ACCOUNT = (addr: string): string =>
  `https://testnet.flowscan.io/account/${addr.startsWith("0x") ? addr.slice(2) : addr}`;

export const FLOWSCAN_EVM_ADDRESS = (addr: string): string =>
  `https://evm-testnet.flowscan.io/address/${addr.startsWith("0x") ? addr : "0x" + addr}`;
