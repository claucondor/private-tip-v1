"use client";

/// Testnet faucet — v0.6 multi-token.
/// Get testnet FLOW + tokens to try multi-token shielded tipping.

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Droplet, ExternalLink, ArrowRight, Wallet, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { TokenSelector, TokenBadge } from "@/components/TokenSelector";
import type { TokenId } from "@/lib/tokens";
import {
  FT_CONFIGS,
  checkReceiverCapability,
  signSetupTx,
  checkJanusFTRegistryState,
  signInstallJanusFTRegistryTx,
} from "@/lib/ft-setup";

type ClaimState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; txId: string; explorerUrl: string; amount: string; note?: string }
  | { status: "error"; error: string };

interface FaucetTokenInfo {
  amount: string;
  cooldownHours: number;
  requiresCOA?: boolean;
  note?: string;
}

interface FaucetInfo {
  enabled: boolean;
  address: string | null;
  cooldownHours: number;
  tokens: Record<string, FaucetTokenInfo>;
}

function isValidFlowAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(addr.trim());
}

function FaucetPageInner() {
  const { user } = useFlowCurrentUser();
  const userAddress = user?.addr ?? null;

  const searchParams = useSearchParams();
  const initialToken = (searchParams.get("token") ?? "flow") as TokenId;
  const [selectedToken, setSelectedToken] = useState<TokenId>(initialToken);

  const [recipient, setRecipient] = useState("");
  const [states, setStates] = useState<Partial<Record<TokenId, ClaimState>>>({});
  const [info, setInfo] = useState<FaucetInfo | null>(null);

  // MockFT vault state: null = unknown/checking, true = ready, false = needs setup
  const [hasMockFTVault, setHasMockFTVault] = useState<boolean | null>(null);
  const [isSettingUpVault, setIsSettingUpVault] = useState(false);

  // JanusFT registry state: null = unknown/checking, "none" | "current" | "stale" once known
  const [janusFTRegistryState, setJanusFTRegistryState] = useState<"none" | "current" | "stale" | null>(null);
  const [isInstallingRegistry, setIsInstallingRegistry] = useState(false);

  useEffect(() => {
    if (userAddress && !recipient) setRecipient(userAddress);
  }, [userAddress, recipient]);

  useEffect(() => {
    fetch("/api/faucet")
      .then((r) => r.json())
      .then((data: FaucetInfo) => setInfo(data))
      .catch(() => setInfo({ enabled: false, address: null, cooldownHours: 24, tokens: {} }));
  }, []);

  // Re-check MockFT vault whenever the wallet address changes or mockft is selected.
  const recheckMockFTVault = useCallback(async (addr: string) => {
    setHasMockFTVault(null);
    try {
      const ready = await checkReceiverCapability(addr, FT_CONFIGS.mockft);
      setHasMockFTVault(ready);
    } catch {
      // If the check fails (e.g. script error), assume not set up.
      setHasMockFTVault(false);
    }
  }, []);

  // Re-check JanusFT registry state (for shielded wrap activation).
  const recheckRegistryState = useCallback(async (addr: string) => {
    setJanusFTRegistryState(null);
    try {
      const state = await checkJanusFTRegistryState(addr);
      setJanusFTRegistryState(state);
    } catch {
      setJanusFTRegistryState("none");
    }
  }, []);

  useEffect(() => {
    if (selectedToken === "mockft" && recipient && /^0x[a-fA-F0-9]{16}$/.test(recipient)) {
      recheckMockFTVault(recipient);
      // Only check registry state for the connected user (not arbitrary addresses)
      if (userAddress && userAddress === recipient) {
        recheckRegistryState(recipient);
      }
    } else if (selectedToken !== "mockft") {
      setHasMockFTVault(null);
      setJanusFTRegistryState(null);
    }
  }, [selectedToken, recipient, userAddress, recheckMockFTVault, recheckRegistryState]);

  const getState = (token: TokenId): ClaimState =>
    states[token] ?? { status: "idle" };
  const setState = (token: TokenId, s: ClaimState) =>
    setStates((prev) => ({ ...prev, [token]: s }));

  const handleInstallRegistry = useCallback(async () => {
    if (!userAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    setIsInstallingRegistry(true);
    try {
      const { txId } = await signInstallJanusFTRegistryTx();
      toast.success(
        janusFTRegistryState === "stale"
          ? "JanusFT registry replaced ✓"
          : "JanusFT registry activated ✓",
        { description: `tx: ${txId.slice(0, 12)}…` }
      );
      await recheckRegistryState(userAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Install failed";
      toast.error(msg);
    } finally {
      setIsInstallingRegistry(false);
    }
  }, [userAddress, janusFTRegistryState, recheckRegistryState]);

  const handleSetupVault = useCallback(async () => {
    if (!userAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    setIsSettingUpVault(true);
    try {
      const { txId } = await signSetupTx(FT_CONFIGS.mockft);
      toast.success("MockFT receiver set up ✓", {
        description: `tx: ${txId.slice(0, 12)}…`,
      });
      // Re-check state — should now be true.
      await recheckMockFTVault(userAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Setup failed";
      toast.error(msg);
    } finally {
      setIsSettingUpVault(false);
    }
  }, [userAddress, recheckMockFTVault]);

  const handleClaim = useCallback(async (token: TokenId) => {
    if (!isValidFlowAddress(recipient)) {
      toast.error("Invalid Flow address — expected 0x + 16 hex characters");
      return;
    }
    setState(token, { status: "submitting" });
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: recipient.trim(), token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState(token, { status: "error", error: data.error ?? "Faucet failed" });
        toast.error(data.error ?? "Faucet failed");
        return;
      }
      setState(token, {
        status: "success",
        txId: data.txId,
        explorerUrl: data.explorerUrl,
        amount: data.amount,
        note: data.note,
      });
      toast.success(`${data.amount} sent`, {
        description: data.note ?? `tx: ${data.txId.slice(0, 12)}…`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setState(token, { status: "error", error: msg });
      toast.error(msg);
    }
  }, [recipient]);

  const currentState = getState(selectedToken);
  const isSubmitting = currentState.status === "submitting";

  const tokenInfo = info?.tokens[selectedToken];

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-2 py-1 rounded-full border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[10px] uppercase tracking-wider text-[#00EF8B] font-mono">
          <Droplet className="w-3 h-3" />
          Testnet faucet
        </div>
        <h1
          className="text-4xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}
        >
          Get testnet tokens
        </h1>
        <p className="mt-2 text-foreground/70">
          Try PrivateTip without spending real money. Get testnet FLOW + tokens to try multi-token shielded tipping.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#0A1628]/60 p-6 space-y-4">
        {/* Address input */}
        <div>
          <label htmlFor="recipient" className="block text-sm font-medium text-foreground/80 mb-1.5">
            Your Flow address
          </label>
          <input
            id="recipient"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x0000000000000000"
            disabled={isSubmitting}
            className="w-full px-3 py-2 rounded border border-white/15 bg-white/5 text-sm font-mono text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-[#00EF8B]/40 focus:border-[#00EF8B]/40 disabled:opacity-50"
          />
          {!userAddress && (
            <p className="mt-1.5 text-xs text-foreground/50">
              No wallet connected — paste your testnet address manually, or connect from the top-right corner.
            </p>
          )}
        </div>

        {/* Token selector */}
        <TokenSelector
          value={selectedToken}
          onChange={setSelectedToken}
          disabled={isSubmitting}
          label="Token to claim"
        />

        {/* Token info */}
        {tokenInfo && (
          <div className="text-xs text-foreground/50 space-y-0.5">
            <p>Amount per claim: <span className="text-foreground/70">{tokenInfo.amount}</span></p>
            <p>Cooldown: <span className="text-foreground/70">{tokenInfo.cooldownHours}h per IP</span></p>
            {tokenInfo.requiresCOA && (
              <p className="text-amber-400/70">Requires COA (EVM bridge) — run wallet setup first.</p>
            )}
            {tokenInfo.note && <p className="text-foreground/40">{tokenInfo.note}</p>}
          </div>
        )}

        {/* MockFT vault setup notice + buttons */}
        {selectedToken === "mockft" && (
          <div className="text-xs text-foreground/50 bg-amber-950/20 border border-amber-500/20 rounded px-3 py-2">
            MockFT is a custom token — Cadence requires you to create the receiver vault
            before depositing. One-time setup.
          </div>
        )}

        {/* Setup vault button — shown when MockFT selected and vault not yet set up */}
        {selectedToken === "mockft" && hasMockFTVault === false && (
          <button
            onClick={handleSetupVault}
            disabled={isSettingUpVault || !userAddress}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSettingUpVault ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Setting up…
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4" />
                Setup MockFT receiver
              </>
            )}
          </button>
        )}

        {/* Vault checking spinner */}
        {selectedToken === "mockft" && hasMockFTVault === null && recipient && (
          <div className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-white/10 bg-white/5 text-foreground/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking MockFT vault…
          </div>
        )}

        {/* JanusFT shielded registry section — only when wallet connected + mockft selected */}
        {selectedToken === "mockft" && hasMockFTVault === true && userAddress && userAddress === recipient && (
          <div className="space-y-2">
            <div className="text-xs text-foreground/50 bg-blue-950/20 border border-blue-500/20 rounded px-3 py-2">
              <span className="font-medium text-blue-300">Shielded wrap setup:</span>{" "}
              Before your first MockFT wrap, you need a JanusFT registry installed
              on your account. This is separate from the regular vault above.
              {janusFTRegistryState === "stale" && (
                <span className="block mt-1 text-amber-300 font-medium">
                  A v0.6 registry was found. It must be replaced before wrapping.
                  Your previous shielded MockFT balance (if any) remains frozen in the
                  legacy contract and cannot be recovered.
                </span>
              )}
            </div>

            {/* Checking registry state spinner */}
            {janusFTRegistryState === null && (
              <div className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-white/10 bg-white/5 text-foreground/40 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking JanusFT registry…
              </div>
            )}

            {/* Already current — show checkmark */}
            {janusFTRegistryState === "current" && (
              <div className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-[#00EF8B]/30 bg-[#00EF8B]/5 text-[#00EF8B] text-sm font-medium">
                <Wrench className="w-4 h-4" />
                Shielded wrap registry already activated ✓
              </div>
            )}

            {/* Needs install or replace */}
            {(janusFTRegistryState === "none" || janusFTRegistryState === "stale") && (
              <button
                onClick={handleInstallRegistry}
                disabled={isInstallingRegistry}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-blue-500/50 bg-blue-500/10 text-blue-300 font-medium hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isInstallingRegistry ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {janusFTRegistryState === "stale" ? "Replacing registry…" : "Installing registry…"}
                  </>
                ) : (
                  <>
                    <Wrench className="w-4 h-4" />
                    {janusFTRegistryState === "stale"
                      ? "Replace v0.6 registry (required)"
                      : "Activate MockFT shielded wrap"}
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* Claim button */}
        <button
          onClick={() => handleClaim(selectedToken)}
          disabled={
            isSubmitting ||
            !recipient ||
            (selectedToken === "mockft" && hasMockFTVault !== true)
          }
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded border border-[#00EF8B]/50 bg-[#00EF8B]/10 text-[#00EF8B] font-medium hover:bg-[#00EF8B]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Droplet className="w-4 h-4" />
              Claim {tokenInfo?.amount ?? selectedToken.toUpperCase()}
            </>
          )}
        </button>

        {currentState.status === "success" && (
          <div className="mt-3 rounded border border-[#00EF8B]/30 bg-[#00EF8B]/5 p-3 text-sm">
            <p className="text-[#00EF8B] font-medium mb-1">
              Sent — should arrive within ~10 seconds.
            </p>
            {currentState.note && (
              <p className="text-xs text-foreground/60 mb-1">{currentState.note}</p>
            )}
            <a
              href={currentState.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-foreground/70 hover:text-foreground"
            >
              View tx on Flowscan <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {currentState.status === "error" && (
          <div className="mt-3 rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">
            {currentState.error}
          </div>
        )}
      </div>

      {/* Quick claim all 3 buttons */}
      <div className="mt-6 rounded-lg border border-white/10 bg-[#0A1628]/40 p-5">
        <p className="text-sm font-medium text-foreground mb-3">Claim all at once</p>
        <div className="flex flex-wrap gap-2">
          {(["flow", "mockusdc", "mockft"] as TokenId[]).map((token) => {
            const s = getState(token);
            const blockedByVaultSetup = token === "mockft" && hasMockFTVault !== true;
            const isDisabled = s.status === "submitting" || s.status === "success" || blockedByVaultSetup;
            const label = s.status === "success"
              ? "Sent!"
              : blockedByVaultSetup
                ? "Setup first ↑"
                : info?.tokens[token]?.amount ?? token;
            return (
              <button
                key={token}
                onClick={() => handleClaim(token)}
                disabled={isDisabled}
                title={blockedByVaultSetup ? "Setup the MockFT receiver vault above first" : undefined}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/15 bg-white/5 text-xs text-foreground/70 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {s.status === "submitting" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <TokenBadge id={token} />
                )}
                {label}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-foreground/30 mt-2">Each token has its own 24h cooldown per IP. MockFT requires a one-time vault setup.</p>
      </div>

      {/* Next step CTA */}
      <div className="mt-6 rounded-lg border border-white/10 bg-[#0A1628]/60 p-6">
        <div className="flex items-start gap-3">
          <Wallet className="w-5 h-5 shrink-0 text-[#D4AF37] mt-0.5" />
          <div className="flex-1">
            <h2 className="font-semibold text-foreground mb-1">
              Got your tokens? Activate your private wallet.
            </h2>
            <p className="text-sm text-foreground/70 mb-3">
              PrivateTip uses{" "}
              <strong className="text-foreground">consent-required privacy</strong>{" "}
              — recipients must publish a MemoKey before others can tip them
              privately. One signature, one tx.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/wrap"
                className="inline-flex items-center gap-1.5 text-sm text-[#00EF8B] hover:text-[#00EF8B]/80 font-medium"
              >
                Set up my private wallet <ArrowRight className="w-3.5 h-3.5" />
              </Link>
              <Link
                href="/portfolio"
                className="inline-flex items-center gap-1.5 text-sm text-foreground/60 hover:text-foreground/80"
              >
                View portfolio <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      {info?.address && (
        <p className="mt-6 text-center text-[10px] font-mono text-foreground/40">
          Faucet wallet: {info.address.slice(0, 8)}…{info.address.slice(-6)} · {info.cooldownHours}h cooldown per token
        </p>
      )}
    </div>
  );
}

export default function FaucetPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl mx-auto px-4 py-12 text-foreground/30">Loading…</div>}>
      <FaucetPageInner />
    </Suspense>
  );
}
