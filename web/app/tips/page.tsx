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

import { useState, useCallback } from "react";
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
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  PRIVATE_TIP_CADENCE,
  JANUS_FLOW_EVM,
  SDK_VERSION,
  buildGetShieldedTipsByRecipientScript,
  buildGetShieldedTipsBySenderScript,
} from "@/lib/tip-actions";

// --- Types ---------------------------------------------------------------------

type TipFilter = "all" | "received" | "sent";

// v0.4.1 clean break: TipMetadata no longer carries `memo` — encrypted memos
// live in TipSentShielded event logs only.
interface RawTipMetadata {
  tipID: string | number;
  sender: string;
  recipient: string;
  timestamp: string;
}

interface TipMetadata {
  tipID: number;
  sender: string;
  recipient: string;
  timestamp: number;     // Unix epoch seconds
}

function normalizeTip(raw: RawTipMetadata): TipMetadata {
  return {
    tipID: Number(raw.tipID),
    sender: raw.sender,
    recipient: raw.recipient,
    timestamp: Number(raw.timestamp),
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
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  const [activeFilter, setActiveFilter] = useState<TipFilter>("all");

  const receivedQuery = useFlowQuery({
    cadence: buildGetShieldedTipsByRecipientScript(),
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

  const received: TipMetadata[] = ((receivedQuery.data as RawTipMetadata[]) ?? [])
    .map(normalizeTip);
  const sent: TipMetadata[] = ((sentQuery.data as RawTipMetadata[]) ?? [])
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
          <div className="w-16 h-16 rounded-2xl bg-purple-100 dark:bg-purple-950 flex items-center justify-center mb-6">
            <List className="w-8 h-8 text-purple-600 dark:text-purple-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">Connect Your Wallet</h2>
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
          <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-950 flex items-center justify-center">
            <List className="w-5 h-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">My Shielded Tips</h1>
            <p className="text-sm text-muted-foreground">
              Metadata only — amounts truly are not on-chain
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

      {/* Privacy banner */}
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20 p-3 mb-6">
        <div className="flex items-start gap-2">
          <Shield className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            <strong>Amounts hidden; memos encrypted (v0.4.1).</strong>{" "}
            On-chain TipSentShielded events carry sender, recipient,
            ciphertextRef, and an AES-GCM-encrypted memo blob. Only the
            recipient (via their MemoKey privkey) can decrypt the memo.
            Reconstruct amounts using your locally-stored blinding factors.
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
        <p>SDK: @openjanus/sdk@{SDK_VERSION}</p>
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
  const router = useRouter();

  return (
    <div className="rounded-lg border border-border bg-card p-4 hover:bg-muted/30 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                isReceived
                  ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                  : "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
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

          {/*
            v0.4.1: encrypted memos live in TipSentShielded event logs only.
            Decryption requires retrieving the log + the recipient's MemoKey
            privkey + decryptText(). Out of scope for this list view; see the
            future memo-modal flow.
          */}
          {isReceived && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageSquare className="w-3.5 h-3.5 shrink-0" />
              <span className="italic">Memo encrypted in event log</span>
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Amount hidden
          </div>
          {isReceived && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => router.push("/claim")}
            >
              <Gift className="w-3.5 h-3.5 mr-1" />
              Unwrap
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
