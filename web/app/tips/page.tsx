/// Tips page — v0.3.
///
/// Shows shielded TipMetadata for the connected user (both as recipient and
/// sender). Per v0.3 privacy contract:
///   - NO amount is shown (amounts truly do not live on-chain)
///   - Only sender, recipient, timestamp, memo, tipID
///
/// Amounts can be reconstructed off-chain by the user from their stored
/// blinding factors (sender knows what they sent; recipient knows by
/// decrypting their cumulative commitment with their stored blindings).

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser, useFlowQuery } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  List,
  AlertCircle,
  Gift,
  Clock,
  User,
  Hash,
  MessageSquare,
  Filter,
  RefreshCw,
  Inbox,
  Send,
  EyeOff,
  Shield,
  X,
  Key,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  buildGetShieldedTipsByRecipientWithMemoScript,
  buildGetShieldedTipsBySenderScript,
  decryptNote,
  getOrDeriveMemoPrivkey,
} from "@/lib/tip-actions";
import { getCachedMemoPrivkey } from "@/lib/memo-key-session";
import {
  findSentMemo,
  getCachedDecryptedMemo,
  cacheDecryptedMemo,
  ingestTipIfNew,
} from "@/lib/memo-mirror";

// --- Types ---------------------------------------------------------------------

type TipFilter = "all" | "received" | "sent";

// v0.4.2: received tips come with the encrypted memo blob bundled, so /tips
// can decrypt inline without scanning event logs. Sent tips still use the
// metadata-only script (sender's memo comes from the local mirror).
interface RawMemoCiphertext {
  ciphertext: number[] | string;     // FCL returns [UInt8] as number[] in JSON
  ephPubkeyX: string;
  ephPubkeyY: string;
}

interface RawTipMetadata {
  tipID: string | number;
  sender: string;
  recipient: string;
  timestamp: string;
  memo?: RawMemoCiphertext | null;
}

interface MemoCiphertext {
  ciphertext: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
}

interface TipMetadata {
  tipID: number;
  sender: string;
  recipient: string;
  timestamp: number;            // Unix epoch seconds
  memo: MemoCiphertext | null;  // null for pre-v0.4.2 tips or no-memo sends
}

function normalizeTip(raw: RawTipMetadata): TipMetadata {
  let memo: MemoCiphertext | null = null;
  if (raw.memo) {
    const ct = Array.isArray(raw.memo.ciphertext)
      ? new Uint8Array(raw.memo.ciphertext)
      : new Uint8Array(
          (raw.memo.ciphertext as string).split(",").map((s) => Number(s))
        );
    memo = {
      ciphertext: ct,
      ephPubkeyX: BigInt(raw.memo.ephPubkeyX),
      ephPubkeyY: BigInt(raw.memo.ephPubkeyY),
    };
  }
  return {
    tipID: Number(raw.tipID),
    sender: raw.sender,
    recipient: raw.recipient,
    timestamp: Number(raw.timestamp),
    memo,
  };
}

function formatTimestamp(unixSec: number): string {
  const ms = unixSec * 1000;
  const date = new Date(ms);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// --- Component -----------------------------------------------------------------

export default function TipsPage() {
  const router = useRouter();
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [activeFilter, setActiveFilter] = useState<TipFilter>("all");

  const receivedQuery = useFlowQuery({
    cadence: buildGetShieldedTipsByRecipientWithMemoScript(),
    args: userAddress
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (arg: any, t: any) => [arg(userAddress, t.Address)]
      : undefined,
  });

  const sentQuery = useFlowQuery({
    cadence: buildGetShieldedTipsBySenderScript(),
    args: userAddress
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (arg: any, t: any) => [arg(userAddress, t.Address)]
      : undefined,
  });

  // Filter out self-recovery carbon-copies (sender === recipient === me).
  // These are internal plumbing for state recovery — not user-facing tips.
  const isSelfTip = (t: RawTipMetadata) =>
    userAddress &&
    t.sender.toLowerCase() === userAddress.toLowerCase() &&
    t.recipient.toLowerCase() === userAddress.toLowerCase();

  const received: TipMetadata[] = ((receivedQuery.data as RawTipMetadata[]) ?? [])
    .filter((t) => !isSelfTip(t))
    .map(normalizeTip);
  const sent: TipMetadata[] = ((sentQuery.data as RawTipMetadata[]) ?? [])
    .filter((t) => !isSelfTip(t))
    .map(normalizeTip);

  const filtered =
    activeFilter === "received"
      ? received
      : activeFilter === "sent"
      ? sent
      : [...received, ...sent];

  const filteredSorted = filtered.sort((a, b) => b.timestamp - a.timestamp);

  const loading = receivedQuery.isLoading || sentQuery.isLoading;
  const error = receivedQuery.error ?? sentQuery.error;

  const handleRefresh = useCallback(() => {
    receivedQuery.refetch();
    sentQuery.refetch();
  }, [receivedQuery, sentQuery]);

  if (!isLoggedIn) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Link>
        </div>
        <div className="flex flex-col items-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#6B46C1]/15 border border-[#6B46C1]/30 flex items-center justify-center mb-6 shadow-[0_0_24px_color-mix(in_oklch,#6B46C1_15%,transparent)]">
            <List className="w-8 h-8 text-[#6B46C1]" />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>Connect Your Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Connect your wallet to view your tip history.
          </p>
          <Button onClick={() => authenticate()} size="lg">
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Link>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#6B46C1]/15 border border-[#6B46C1]/30 flex items-center justify-center">
            <List className="w-5 h-5 text-[#6B46C1]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-fraunces, Georgia, serif)" }}>My tips</h1>
            <p className="text-sm text-muted-foreground">
              Senders, recipients, and timestamps — but never amounts.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          <span className="ml-1 hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Privacy banner — short and informational only. MemoKey activation
          happens on /wrap (Enable button); by the time we land here the
          session privkey is already cached and decryption is automatic. */}
      <div className="rounded-lg border border-[#00EF8B]/25 bg-[#00EF8B]/5 p-3 mb-6">
        <div className="flex items-start gap-2">
          <Shield className="w-4 h-4 text-[#00EF8B] shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            <strong>Amounts hidden. Memos encrypted. Balance restored automatically.</strong>{" "}
            Tips you receive arrive with an encrypted note that only your wallet can open. Open the app from any device with the same wallet and your history reconstructs itself.
            For tips you sent, the memo you wrote shows up from a local copy (this browser only).
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-muted-foreground shrink-0" />
        {(
          [
            { key: "all", label: "All", icon: List },
            { key: "received", label: `Received (${received.length})`, icon: Inbox },
            { key: "sent", label: `Sent (${sent.length})`, icon: Send },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            variant={activeFilter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter(key as TipFilter)}
            className="shrink-0"
          >
            <Icon className="w-3.5 h-3.5 mr-1" />
            {label}
          </Button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">
                Failed to load tips
              </p>
              <p className="text-xs text-destructive/80">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4 animate-pulse"
            >
              <div className="space-y-2">
                <div className="h-4 w-48 bg-muted rounded" />
                <div className="h-3 w-32 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && filteredSorted.length === 0 && (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 p-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto mb-3">
            <Gift className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-muted-foreground mb-1">
            No shielded tips yet
          </p>
          <p className="text-xs text-muted-foreground">
            Send a tip to start your history (recipient amounts are hidden!)
          </p>
        </div>
      )}

      {/* Global Unwrap CTA — single op draining the aggregated shielded slot.
          JanusFlow merges every received tip into one Pedersen commitment, so
          there is no per-tip claim — withdrawals work off your local balance
          and blinding factor. Shown only when there's something to receive. */}
      {!loading && received.length > 0 && activeFilter !== "sent" && (
        <div className="mb-4 rounded-lg border border-[#D4AF37]/30 bg-[#D4AF37]/8 p-4 flex items-center justify-between gap-3 shadow-[0_0_16px_color-mix(in_oklch,#D4AF37_10%,transparent)]">
          <div className="text-xs text-amber-900 dark:text-[#D4AF37]">
            <strong>Ready to claim your treasure?</strong> All your received tips add up to one private balance — withdraw any amount, anytime.
          </div>
          <Button
            size="sm"
            variant="gold"
            onClick={() => router.push("/claim")}
            className="shrink-0"
          >
            <Gift className="w-3.5 h-3.5 mr-1" />
            Withdraw
          </Button>
        </div>
      )}

      {/* List */}
      {!loading && filteredSorted.length > 0 && (
        <div className="space-y-2">
          {filteredSorted.map((tip) => (
            <TipCard
              key={`${tip.tipID}-${tip.sender}`}
              tip={tip}
              currentUser={userAddress ?? ""}
            />
          ))}
        </div>
      )}

      <div className="mt-8 text-[10px] text-muted-foreground space-y-0.5">
        <p>JanusFlow EVM: <span className="font-mono">{JANUS_FLOW_EVM}</span></p>
        <p>PrivateTip: <span className="font-mono">{PRIVATE_TIP_CADENCE}</span></p>
      </div>
    </div>
  );
}

function TipCard({
  tip,
  currentUser,
}: {
  tip: TipMetadata;
  currentUser: string;
}) {
  const isReceived = tip.recipient.toLowerCase() === currentUser.toLowerCase();

  // Received-side memo: decrypt the on-chain ECIES blob using the recipient's
  // MemoKey privkey (sessionStorage after sign-derive). Results are cached so
  // re-renders don't re-run the AES-GCM/BabyJub math. Rendered states:
  //   - tip.memo == null: pre-v0.4.2 tip or sender didn't include a memo.
  //   - decrypting: in flight.
  //   - plaintext: cached or freshly decrypted.
  //   - locked: privkey not yet in sessionStorage — user must click Unlock.
  //   - error: wrong privkey, or ciphertext doesn't match this recipient.
  const [decrypted, setDecrypted] = useState<string | null>(() => {
    if (!isReceived || !tip.memo) return null;
    return getCachedDecryptedMemo(currentUser, tip.tipID);
  });
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  // locked = privkey not in sessionStorage yet; user clicks to derive.
  const [locked, setLocked] = useState<boolean>(() => {
    if (!isReceived || !tip.memo) return false;
    if (getCachedDecryptedMemo(currentUser, tip.tipID)) return false;
    return getCachedMemoPrivkey(currentUser) === null;
  });

  const runDecrypt = useCallback((privkey: bigint) => {
    if (!tip.memo) return;
    let cancelled = false;
    setDecrypting(true);
    decryptNote(
      tip.memo.ciphertext,
      { x: tip.memo.ephPubkeyX, y: tip.memo.ephPubkeyY },
      privkey
    )
      .then((note) => {
        if (cancelled) return;
        // The `data` field is the app-level payload — for PrivateTip that's
        // the optional memo text. Empty data → display "(no memo text)".
        const displayText = note.data ?? "";
        setDecrypted(displayText);
        setLocked(false);
        cacheDecryptedMemo(currentUser, tip.tipID, displayText);
        // Auto-ingest (amount, blinding) into the recipient's local shielded
        // state if we haven't already. This is what makes /claim work for
        // accounts that only received tips (never wrapped themselves).
        ingestTipIfNew({
          recipient: currentUser,
          tipID: tip.tipID,
          amount: note.amount,
          blinding: note.blinding,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDecryptError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDecrypting(false);
      });
    return () => { cancelled = true; };
  }, [tip.memo, tip.tipID, currentUser]);

  // Auto-decrypt when privkey is already in sessionStorage (e.g. user already
  // signed earlier this session). Does NOT prompt the wallet.
  useEffect(() => {
    if (!isReceived || !tip.memo || decrypted || decryptError || locked) return;
    const cached = getCachedDecryptedMemo(currentUser, tip.tipID);
    if (cached) {
      setDecrypted(cached);
      return;
    }
    const privkey = getCachedMemoPrivkey(currentUser);
    if (!privkey) {
      setLocked(true);
      return;
    }
    runDecrypt(privkey);
  }, [isReceived, tip.memo, tip.tipID, currentUser, decrypted, decryptError, locked, runDecrypt]);

  const handleUnlockClick = useCallback(async () => {
    setDecrypting(true);
    try {
      const privkey = await getOrDeriveMemoPrivkey(currentUser);
      setLocked(false);
      runDecrypt(privkey);
    } catch (err: unknown) {
      setDecryptError(err instanceof Error ? err.message : String(err));
      setDecrypting(false);
    }
  }, [currentUser, runDecrypt]);

  return (
    <div className="rounded-lg border border-border bg-card p-4 hover:bg-muted/30 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                isReceived
                  ? "bg-[#00EF8B]/15 text-emerald-800 dark:text-[#00EF8B]"
                  : "bg-[#6B46C1]/15 text-[#6B46C1] dark:text-purple-300"
              }`}
            >
              {isReceived ? <Inbox className="w-3 h-3" /> : <Send className="w-3 h-3" />}
              {isReceived ? "Received" : "Sent"}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              <Hash className="w-3 h-3 inline mr-0.5" />
              #{tip.tipID}
            </span>
            <span className="text-xs text-muted-foreground">
              <Clock className="w-3 h-3 inline mr-0.5" />
              {formatTimestamp(tip.timestamp)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <User className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-mono text-muted-foreground text-xs">
              {isReceived
                ? `From: ${formatAddress(tip.sender)}`
                : `To: ${formatAddress(tip.recipient)}`}
            </span>
          </div>

          {isReceived && (() => {
            if (!tip.memo) {
              return (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                  <span className="italic">No memo</span>
                </div>
              );
            }
            if (decrypted !== null) {
              return (
                <div className="flex items-start gap-1.5 text-xs">
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 text-[#00EF8B] mt-0.5" />
                  <span className="text-foreground/80 break-words">
                    {decrypted.length > 0 ? (
                      <>&ldquo;{decrypted}&rdquo;</>
                    ) : (
                      <span className="italic text-muted-foreground">
                        (no memo text — amount + blinding ingested)
                      </span>
                    )}
                  </span>
                </div>
              );
            }
            if (decryptError) {
              return (
                <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="break-words">
                    Memo present but undecryptable: {decryptError}
                  </span>
                </div>
              );
            }
            if (locked) {
              return (
                <div className="flex items-center gap-2 text-xs">
                  <EyeOff className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground italic">Encrypted memo</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={handleUnlockClick}
                    disabled={decrypting}
                  >
                    {decrypting ? "Signing…" : "Unlock memos"}
                  </Button>
                </div>
              );
            }
            return (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                <span className="italic">
                  {decrypting ? "Decrypting memo…" : "Encrypted memo"}
                </span>
              </div>
            );
          })()}

          {!isReceived && (() => {
            const localMemo = findSentMemo({
              sender: currentUser,
              recipient: tip.recipient,
              onChainTimestampSec: tip.timestamp,
            });
            return localMemo ? (
              <div className="flex items-start gap-1.5 text-xs">
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground mt-0.5" />
                <span className="text-foreground/80 break-words">
                  &ldquo;{localMemo}&rdquo;
                  <span className="text-muted-foreground ml-1">(local mirror)</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                <span className="italic">No local memo</span>
              </div>
            );
          })()}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Amount hidden
          </div>
        </div>
      </div>
    </div>
  );
}

// --- UnlockMemosBanner --------------------------------------------------------

/** Dismissable banner explaining sign-derive. Only shown when the privkey is
 * not yet in sessionStorage. Dismissed locally via useState (not persisted —
 * the user will see it again on a new tab, which is intentional). */
function UnlockMemosBanner({
  userAddress,
  onUnlocked,
}: {
  userAddress: string;
  onUnlocked: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't show if already unlocked (privkey in sessionStorage).
  const alreadyUnlocked =
    !!userAddress && getCachedMemoPrivkey(userAddress) !== null;

  if (dismissed || alreadyUnlocked || !userAddress) return null;

  const handleUnlock = async () => {
    setUnlocking(true);
    setError(null);
    try {
      await getOrDeriveMemoPrivkey(userAddress);
      onUnlocked();
      setDismissed(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20 p-3 mb-4">
      <div className="flex items-start gap-2">
        <Key className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-blue-800 dark:text-blue-200">
            <strong>Memos are encrypted to your wallet-derived MemoKey.</strong>{" "}
            Click &ldquo;Unlock memos&rdquo; to sign a one-time message; we recover your
            privkey across any browser — no seed phrase or storage needed.
          </p>
          {error && (
            <p className="text-xs text-destructive mt-1">{error}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={handleUnlock}
            disabled={unlocking}
          >
            {unlocking ? "Signing…" : "Unlock memos"}
          </Button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
