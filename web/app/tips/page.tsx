/// Tips page -- View sent and received tip history.
///
/// Features:
/// - Query PrivateTip for tips sent by and received by the user
/// - Display tip list with sender, recipient, timestamp, memo, claimed status
/// - Filter by claimed/unclaimed
/// - Show total count
/// - Link to claim page for unclaimed received tips
///
/// Amounts are hidden (confidential by design) -- only metadata shown.

"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useFlowCurrentUser, useFlowQuery } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  List,
  Loader2,
  AlertCircle,
  Gift,
  Clock,
  CheckCircle2,
  XCircle,
  User,
  Hash,
  MessageSquare,
  Filter,
  RefreshCw,
  Inbox,
  Send,
  EyeOff,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppStore, type TipInfo } from "@/lib/store";

// --- Types ---------------------------------------------------------------------

type TipFilter = "all" | "received" | "sent" | "unclaimed";

// --- Formatting Helpers ---------------------------------------------------------

/**
 * Format a timestamp to a human-readable date+time string.
 */
function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

/**
 * Format a Flow address for display (shortened).
 */
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

  // Zustand store
  const tips = useAppStore((s) => s.tips);
  const setReceivedTips = useAppStore((s) => s.setReceivedTips);
  const setSentTips = useAppStore((s) => s.setSentTips);
  const setTipsLoading = useAppStore((s) => s.setTipsLoading);

  // -- State ------------------------------------------------------------------

  const [activeFilter, setActiveFilter] = useState<TipFilter>("all");
  const [queryError, setQueryError] = useState<string | null>(null);

  // -- Cadence Query: Get tips by recipient ----------------------------------

  const receivedQuery = useFlowQuery({
    cadence: `
      import PrivateTip from 0xb9ac529c14a4c5a1

      access(all) fun main(recipient: Address): [PrivateTip.TipInfo] {
        return PrivateTip.getTipsByRecipient(recipient: recipient)
      }
    `,
    args: userAddress
      ? (arg: any, t: any) => [arg(userAddress, t.Address)]
      : undefined,
  });

  const receivedTipsData = userAddress ? receivedQuery.data : undefined;
  const isReceivedLoading = userAddress ? receivedQuery.isLoading : false;
  const receivedError = userAddress ? receivedQuery.error : null;
  const refetchReceived = receivedQuery.refetch;

  // -- Cadence Query: Get tips by sender -------------------------------------

  const sentQuery = useFlowQuery({
    cadence: `
      import PrivateTip from 0xb9ac529c14a4c5a1

      access(all) fun main(sender: Address): [PrivateTip.TipInfo] {
        return PrivateTip.getTipsBySender(sender: sender)
      }
    `,
    args: userAddress
      ? (arg: any, t: any) => [arg(userAddress, t.Address)]
      : undefined,
  });

  const sentTipsData = userAddress ? sentQuery.data : undefined;
  const isSentLoading = userAddress ? sentQuery.isLoading : false;
  const sentError = userAddress ? sentQuery.error : null;
  const refetchSent = sentQuery.refetch;

  // -- Sync to Zustand store -------------------------------------------------

  useEffect(() => {
    if (receivedTipsData) {
      const mapped: TipInfo[] = (receivedTipsData as any[]).map((tip: any) => ({
        tipID: Number(tip.tipID),
        sender: tip.sender,
        recipient: tip.recipient,
        timestamp: tip.timestamp,
        memo: tip.memo ?? null,
        claimed: Boolean(tip.claimed),
      }));
      setReceivedTips(mapped);
    }
  }, [receivedTipsData, setReceivedTips]);

  useEffect(() => {
    if (sentTipsData) {
      const mapped: TipInfo[] = (sentTipsData as any[]).map((tip: any) => ({
        tipID: Number(tip.tipID),
        sender: tip.sender,
        recipient: tip.recipient,
        timestamp: tip.timestamp,
        memo: tip.memo ?? null,
        claimed: Boolean(tip.claimed),
      }));
      setSentTips(mapped);
    }
  }, [sentTipsData, setSentTips]);

  useEffect(() => {
    setTipsLoading(isReceivedLoading || isSentLoading);
  }, [isReceivedLoading, isSentLoading, setTipsLoading]);

  // -- Derived filter logic --------------------------------------------------

  const filteredTips = useMemo(() => {
    const allTips = [...tips.sent, ...tips.received].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    switch (activeFilter) {
      case "received":
        return tips.received.sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
      case "sent":
        return tips.sent.sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
      case "unclaimed":
        return tips.received
          .filter((t) => !t.claimed)
          .sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
      case "all":
      default:
        return allTips;
    }
  }, [tips, activeFilter]);

  const unclaimedCount = useMemo(
    () => tips.received.filter((t) => !t.claimed).length,
    [tips.received]
  );

  // -- Refresh handler -------------------------------------------------------

  const handleRefresh = useCallback(() => {
    setQueryError(null);
    refetchReceived();
    refetchSent();
  }, [refetchReceived, refetchSent]);

  // -- Render ----------------------------------------------------------------

  // Not logged in state
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
      {/* Back + Header */}
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
            <h1 className="text-2xl font-bold">My Tips</h1>
            <p className="text-sm text-muted-foreground">
              View your tip history -- both sent and received
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={tips.loading}
        >
          <RefreshCw
            className={`w-4 h-4 ${tips.loading ? "animate-spin" : ""}`}
          />
          <span className="ml-1 hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-muted-foreground shrink-0" />
        {(
          [
            { key: "all", label: "All", icon: List },
            { key: "received", label: "Received", icon: Inbox },
            { key: "sent", label: "Sent", icon: Send },
            {
              key: "unclaimed",
              label: `Unclaimed${unclaimedCount > 0 ? ` (${unclaimedCount})` : ""}`,
              icon: Clock,
            },
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

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-2xl font-bold tabular-nums">
            {tips.totalReceivedCount}
          </p>
          <p className="text-xs text-muted-foreground">Received</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-2xl font-bold tabular-nums">
            {tips.totalSentCount}
          </p>
          <p className="text-xs text-muted-foreground">Sent</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-2xl font-bold tabular-nums">{unclaimedCount}</p>
          <p className="text-xs text-muted-foreground">Unclaimed</p>
        </div>
      </div>

      {/* Error state */}
      {(receivedError || sentError) && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">
                Failed to load tips
              </p>
              <p className="text-xs text-destructive/80">
                {receivedError instanceof Error
                  ? receivedError.message
                  : sentError instanceof Error
                    ? sentError.message
                    : "An unexpected error occurred. Try refreshing."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {tips.loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4 animate-pulse"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-48 bg-muted rounded" />
                  <div className="h-3 w-32 bg-muted rounded" />
                </div>
                <div className="h-6 w-16 bg-muted rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!tips.loading && filteredTips.length === 0 && (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 p-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto mb-3">
            <Gift className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-muted-foreground mb-1">
            {activeFilter === "unclaimed"
              ? "All tips have been claimed!"
              : activeFilter === "sent"
                ? "No tips sent yet"
                : activeFilter === "received"
                  ? "No tips received yet"
                  : "No tips yet"}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {activeFilter === "sent"
              ? "Go to the send page to send your first tip"
              : activeFilter === "received" || activeFilter === "unclaimed"
                ? "Share your address with friends to start receiving tips"
                : "Send or receive tips to see them here"}
          </p>
          <div className="flex gap-3 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/send")}
            >
              <Gift className="w-4 h-4 mr-1" />
              Send a Tip
            </Button>
          </div>
        </div>
      )}

      {/* Tip list */}
      {!tips.loading && filteredTips.length > 0 && (
        <div className="space-y-2">
          {filteredTips.map((tip) => (
            <TipCard
              key={`${tip.tipID}-${tip.sender}`}
              tip={tip}
              currentUser={userAddress ?? ""}
              unclaimedHighlight={activeFilter === "unclaimed"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Tip Card Sub-component ----------------------------------------------------

interface TipCardProps {
  tip: TipInfo;
  currentUser: string;
  unclaimedHighlight?: boolean;
}

function TipCard({ tip, currentUser, unclaimedHighlight = false }: TipCardProps) {
  const isReceived =
    tip.recipient.toLowerCase() === currentUser.toLowerCase();
  const router = useRouter();

  return (
    <div
      className={`rounded-lg border ${
        !tip.claimed && isReceived
          ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20"
          : "border-border bg-card"
      } p-4 transition-colors hover:bg-muted/30`}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: Tip metadata */}
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Direction + ID */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                isReceived
                  ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                  : "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
              }`}
            >
              {isReceived ? (
                <Inbox className="w-3 h-3" />
              ) : (
                <Send className="w-3 h-3" />
              )}
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

          {/* Sender / Recipient */}
          <div className="flex items-center gap-1.5 text-sm">
            <User className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-mono text-muted-foreground text-xs">
              {isReceived
                ? `From: ${formatAddress(tip.sender)}`
                : `To: ${formatAddress(tip.recipient)}`}
            </span>
          </div>

          {/* Memo */}
          {tip.memo && (
            <div className="flex items-start gap-1.5 text-sm">
              <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground italic">
                &ldquo;{tip.memo}&rdquo;
              </p>
            </div>
          )}
        </div>

        {/* Right: Status + Action */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* Claimed status badge */}
          {isReceived ? (
            tip.claimed ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="w-3 h-3" />
                Claimed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300">
                <Clock className="w-3 h-3" />
                Unclaimed
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
              <Send className="w-3 h-3" />
              Sent
            </span>
          )}

          {/* Privacy indicator */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Amount hidden
          </div>

          {/* Claim button for unclaimed received tips */}
          {!tip.claimed && isReceived && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => router.push("/claim")}
            >
              <Gift className="w-3.5 h-3.5 mr-1" />
              Claim
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
