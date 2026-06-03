"use client";

/// Wallet connection component for PrivateTip.
///
/// Uses @onflow/react-sdk hooks (useFlowCurrentUser) for FCL authentication.
/// Shows a connect button when logged out, and the connected address +
/// disconnect button when logged in.
///
/// Integrates with the Zustand store to keep wallet state in sync.

import { useCallback, useEffect, useState } from "react";
import { useFlowCurrentUser } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { LogOut, Wallet } from "lucide-react";

export interface ConnectWalletProps {
  /** Optional callback fired after successful authentication */
  onConnect?: () => void;
  /** Optional callback fired after disconnection */
  onDisconnect?: () => void;
  /** If true, show a compact variant (no "Connect Wallet" label, just icon) */
  compact?: boolean;
}

/**
 * ConnectWallet — FCL authentication toggle.
 *
 * - Displays a "Connect Wallet" button when not authenticated
 * - Shows the connected Flow address + disconnect button when authenticated
 * - Syncs wallet state to the Zustand store
 * - Handles loading state during authentication
 */
export default function ConnectWallet({
  onConnect,
  onDisconnect,
  compact = false,
}: ConnectWalletProps) {
  const { user, authenticate, unauthenticate } =
    useFlowCurrentUser();
  const setWallet = useAppStore((s) => s.setWallet);
  const clearWallet = useAppStore((s) => s.clearWallet);

  // Track whether authentication is in progress
  const [isConnecting, setIsConnecting] = useState(false);
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;

  // Sync wallet state to store
  useEffect(() => {
    if (user?.addr) {
      setWallet({
        address: user.addr,
        authenticated: true,
      });
    } else {
      clearWallet();
    }
  }, [user?.addr, setWallet, clearWallet]);

  const handleConnect = useCallback(() => {
    setIsConnecting(true);
    authenticate().finally(() => setIsConnecting(false));
    onConnect?.();
  }, [authenticate, onConnect]);

  const handleDisconnect = useCallback(() => {
    unauthenticate();
    clearWallet();
    onDisconnect?.();
  }, [unauthenticate, clearWallet, onDisconnect]);

  // Connecting state (after clicking "Connect", before wallet responds)
  if (isConnecting) {
    return (
      <Button disabled variant="outline" size={compact ? "icon-sm" : "default"}>
        <Wallet className="w-4 h-4 animate-pulse" />
        {!compact && <span>Connecting...</span>}
      </Button>
    );
  }

  // Connected state
  if (isLoggedIn && user?.addr) {
    const shortAddr = `${user.addr.slice(0, 6)}...${user.addr.slice(-4)}`;

    return (
      <div className="flex items-center gap-2">
        {!compact && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted text-xs font-mono text-muted-foreground">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            {shortAddr}
          </div>
        )}
        <Button
          variant="outline"
          size={compact ? "icon-sm" : "sm"}
          onClick={handleDisconnect}
          title="Disconnect wallet"
        >
          <LogOut className="w-4 h-4" />
          {!compact && <span>Disconnect</span>}
        </Button>
      </div>
    );
  }

  // Disconnected state
  return (
    <Button variant="default" size={compact ? "sm" : "default"} onClick={handleConnect}>
      <Wallet className="w-4 h-4" />
      {!compact && <span>Connect Wallet</span>}
    </Button>
  );
}
