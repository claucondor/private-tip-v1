"use client";

/// Honest privacy model disclosure for PrivateTip.
///
/// PRIVACY LANGUAGE RULES — Read before editing:
/// - Use "confidential amounts" / "amount privacy" — NEVER "anonymous", "fully private"
/// - Amounts are hidden via cryptographic ElGamal encryption
/// - Sender→recipient relationships are visible on-chain
/// - Recipients can decrypt the total accumulated amount only, not per-tipper amounts
/// - This component exists because misleading privacy claims damage user trust

import { AlertTriangle, Eye, Lock, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface PrivacyDisclosureProps {
  /** If true, render a compact inline variant instead of a full card */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * PrivacyDisclosure — Honest, prominent explanation of what PrivateTip
 * does and does NOT hide.
 *
 * NEVER use the word "anonymous", "fully private", or "untraceable".
 * Amount confidentiality is real; graph visibility is by design.
 */
export default function PrivacyDisclosure({
  compact = false,
  className = "",
}: PrivacyDisclosureProps) {
  if (compact) {
    return (
      <div
        className={`rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200 ${className}`}
      >
        <div className="flex items-start gap-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
          <div>
            <strong className="font-semibold">Amount privacy only.</strong>{" "}
            Tip amounts are encrypted using JanusToken ElGamal encryption. The
            sender→recipient relationship{" "}
            <strong>is visible on-chain</strong> — this is designed for public
            accountability. Recipients see the total decrypted amount, not
            per-tipper details.
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card className={`border-amber-200 dark:border-amber-800 ${className}`}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          <CardTitle>Privacy Model</CardTitle>
        </div>
        <CardDescription>
          What PrivateTip protects — and what it does not
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* What IS hidden */}
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center shrink-0">
            <Lock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h4 className="text-sm font-medium mb-1">Confidential amounts</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Tip amounts are encrypted using JanusToken&apos;s ElGamal
              accumulator on the BabyJubJub curve. No one — including the
              recipient — can see how much a specific sender tipped. Only the
              total accumulated value can be decrypted via BSGS.
            </p>
          </div>
        </div>

        {/* What IS visible */}
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950 flex items-center justify-center shrink-0">
            <Eye className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h4 className="text-sm font-medium mb-1">Visible metadata</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Who sent a tip to whom, when, and whether it has been claimed are
              all visible on-chain. This is a conscious design choice: the
              sender→recipient graph provides accountability and enables tip
              history features. Only the{" "}
              <strong>amount</strong> stays confidential.
            </p>
          </div>
        </div>

        {/* Technical limitation */}
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950 flex items-center justify-center shrink-0">
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h4 className="text-sm font-medium mb-1">Known limitations</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              ElGamal encryption is homomorphic (amounts add up) but BSGS
              decryption is bounded by the search space. Large accumulated
              balances or very fine-grained amounts may approach practical
              limits. Decryption also reveals the total to the recipient&apos;s
              wallet. Per-tipper amounts remain hidden by design.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
