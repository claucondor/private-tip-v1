/// Send Tip page -- Send confidential tips with hidden amounts.
///
/// Flow:
/// 1. User connects wallet (checks auth via useFlowCurrentUser)
/// 2. User enters recipient address, amount, optional memo
/// 3. Validate inputs (address format, sufficient balance, valid amount)
/// 4. Fetch recipient's BabyJubJub pubkey from JanusToken via @openjanus/sdk/tokens
/// 5. Generate cryptographic randomness + build encrypt-consistency proof
/// 6. Submit wrapAndEncrypt transaction via FCL
/// 7. Show transaction status (pending → confirmed/failed)
/// 8. On success: show tipID, reset form

"use client";

import { useState, useCallback, useEffect } from "react";
import { useFlowCurrentUser, useFlowMutate } from "@onflow/react-sdk";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Gift, Loader2, CheckCircle, XCircle, AlertTriangle, EyeOff } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { useRouter } from "next/navigation";

import TipForm from "@/components/TipForm";
import type { TipFormData } from "@/components/TipForm";
import RecipientPubkeyDisplay from "@/components/RecipientPubkeyDisplay";
import type { RecipientPubkeyData } from "@/components/RecipientPubkeyDisplay";
import PrivacyDisclosure from "@/components/PrivacyDisclosure";

import {
  isValidFlowAddress,
  isValidFlowAmount,
  checkRecipientPubkey,
  generateEncryptProof,
} from "@/lib/tip-actions";
import type { Point } from "@openjanus/sdk";

// --- Types ---------------------------------------------------------------------

type SendTipStatus =
  | "idle"
  | "validating"
  | "fetching_pubkey"
  | "building_proof"
  | "submitting"
  | "confirming"
  | "success"
  | "error";

interface SendTipState {
  status: SendTipStatus;
  tipID: number | null;
  error: string | null;
  txId: string | null;
}

// --- Constants ------------------------------------------------------------------

/** Min FLOW balance required -- a dust amount to cover transaction fees. */
const MIN_FLOW_BALANCE = 0.001;

// --- Component -----------------------------------------------------------------

export default function SendTipPage() {
  const router = useRouter();
  const { user, authenticate } = useFlowCurrentUser();
  const isLoggedIn = !!user?.loggedIn && !!user?.addr;
  const userAddress = user?.addr ?? null;

  // Zustand store
  const wallet = useAppStore((s) => s.wallet);
  const addSentTip = useAppStore((s) => s.addSentTip);

  // FCL mutation
  const {
    mutateAsync: submitTx,
    isPending: isTxPending,
    data: txData,
  } = useFlowMutate();

  // -- State ------------------------------------------------------------------

  const [sendState, setSendState] = useState<SendTipState>({
    status: "idle",
    tipID: null,
    error: null,
    txId: null,
  });

  const [recipientPubkey, setRecipientPubkey] = useState<Point | null>(null);
  const [pubkeyFetching, setPubkeyFetching] = useState(false);
  const [pubkeyError, setPubkeyError] = useState<string | null>(null);
  const [encryptResult, setEncryptResult] = useState<{
    ciphertext: { c1: [string, string]; c2: [string, string] };
    proof: string[];
    publicInputs: string[];
  } | null>(null);
  const [tipData, setTipData] = useState<TipFormData | null>(null);

  // -- Handlers ----------------------------------------------------------------

  /**
   * Handle form submission -- the core tip flow.
   * 1. Validate inputs
   * 2. Fetch recipient pubkey
   * 3. Generate encrypt proof
   * 4. Submit wrapAndEncrypt transaction
   */
  const handleSendTip = useCallback(
    async (data: TipFormData) => {
      if (!userAddress) {
        toast.error("Wallet not connected. Please connect first.");
        return;
      }

      setTipData(data);
      setSendState({ status: "validating", tipID: null, error: null, txId: null });

      // Step 1: Validate inputs
      if (!isValidFlowAddress(data.recipient)) {
        setSendState({
          status: "error",
          tipID: null,
          error: "Invalid recipient Flow address format.",
          txId: null,
        });
        return;
      }

      if (!isValidFlowAmount(data.amount)) {
        setSendState({
          status: "error",
          tipID: null,
          error: "Invalid amount. Enter a positive number with up to 8 decimal places.",
          txId: null,
        });
        return;
      }

      if (data.recipient.toLowerCase() === userAddress.toLowerCase()) {
        setSendState({
          status: "error",
          tipID: null,
          error: "You cannot send a tip to yourself.",
          txId: null,
        });
        return;
      }

      // Step 2: Fetch recipient pubkey
      setSendState({ status: "fetching_pubkey", tipID: null, error: null, txId: null });
      setPubkeyFetching(true);
      setPubkeyError(null);

      try {
        const pk = await checkRecipientPubkey(data.recipient);
        if (!pk) {
          setPubkeyError("Recipient has not registered an encryption pubkey. They must register first.");
          setSendState({
            status: "error",
            tipID: null,
            error: "Recipient has not registered an encryption pubkey.",
            txId: null,
          });
          return;
        }
        setRecipientPubkey(pk);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to fetch recipient pubkey";
        setPubkeyError(msg);
        setSendState({ status: "error", tipID: null, error: msg, txId: null });
        return;
      } finally {
        setPubkeyFetching(false);
      }

      // Step 3: Generate encrypt consistency proof
      setSendState({ status: "building_proof", tipID: null, error: null, txId: null });
      try {
        const proofResult = await generateEncryptProof(data.amount, recipientPubkey!);
        setEncryptResult(proofResult);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to generate encryption proof";
        setSendState({ status: "error", tipID: null, error: msg, txId: null });
        return;
      }

      // Step 4: Submit wrapAndEncrypt transaction via FCL
      // Uses useFlowMutate's mutateAsync to send the Cadence transaction.
      // The transaction template is the JanusFlow wrapAndEncrypt Cadence tx
      // which takes: amount, recipient, c1x, c1y, c2x, c2y, proof, pubInputs
      setSendState({ status: "submitting", tipID: null, error: null, txId: null });

      try {
        const c1 = encryptResult!.ciphertext.c1;
        const c2 = encryptResult!.ciphertext.c2;
        const proofArray = encryptResult!.proof;
        const pubInputsArray = encryptResult!.publicInputs;

        // Convert string[] to bigint[] for the Cadence arguments
        const proofUint = proofArray.map((s: string) => BigInt(s));
        const pubInputsUint = pubInputsArray.map((s: string) => BigInt(s));

        const txId = await submitTx({
          cadence: `
            import JanusFlow from 0x5dcbeb41055ec57e
            import FungibleToken from 0x9a0766d93b6608b7
            import FlowToken from 0x7e60df042a9c0868

            transaction(
                amount: UFix64,
                recipient: Address,
                c1x: UInt256, c1y: UInt256,
                c2x: UInt256, c2y: UInt256,
                proof: [UInt256],
                pubInputs: [UInt256]
            ) {
                let vault: @FlowToken.Vault

                prepare(signer: auth(BorrowValue) &Account) {
                    let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
                        from: /storage/flowTokenVault
                    ) ?? panic("No FlowToken.Vault in signer storage")
                    self.vault <- flowVault.withdraw(amount: amount)
                }

                execute {
                    JanusFlow.wrapAndEncrypt(
                        vault: <-self.vault,
                        recipient: recipient,
                        c1x: c1x, c1y: c1y,
                        c2x: c2x, c2y: c2y,
                        proof: proof,
                        pubInputs: pubInputs
                    )
                }
            }
          `,
          args: (arg: any, t: any) => [
            arg(data.amount, t.UFix64),
            arg(data.recipient, t.Address),
            arg(c1[0], t.UInt256),
            arg(c1[1], t.UInt256),
            arg(c2[0], t.UInt256),
            arg(c2[1], t.UInt256),
            arg(proofUint, t.Array(t.UInt256)),
            arg(pubInputsUint, t.Array(t.UInt256)),
          ],
          limit: 9999,
        });

        setSendState({
          status: "confirming",
          tipID: null,
          error: null,
          txId,
        });

        // Add to local store
        addSentTip({
          tipID: Date.now(), // placeholder until we parse the event
          sender: userAddress,
          recipient: data.recipient,
          timestamp: new Date().toISOString(),
          memo: data.memo || null,
          claimed: false,
        });

        // Reset form
        setTipData(null);
        setRecipientPubkey(null);
        setEncryptResult(null);
        setSendState({ status: "success", tipID: null, error: null, txId });

        toast.success("Tip sent! ", {
          description: "Your confidential tip has been sent successfully.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Transaction failed";
        setSendState({ status: "error", tipID: null, error: msg, txId: null });
        toast.error("Send failed", {
          description: msg,
        });
      }
    },
    [userAddress, recipientPubkey, encryptResult, addSentTip, submitTx]
  );

  // -- Compute derived values -----------------------------------------------

  const isSubmitting = sendState.status === "submitting" ||
    sendState.status === "confirming" ||
    sendState.status === "building_proof" ||
    sendState.status === "fetching_pubkey";

  const submitError = sendState.status === "error" ? sendState.error : null;

  // -- Render ----------------------------------------------------------------

  // Not logged in state
  if (!isLoggedIn) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12">
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
          <div className="w-16 h-16 rounded-2xl bg-blue-100 dark:bg-blue-950 flex items-center justify-center mb-6">
            <Gift className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-xl font-bold mb-2">Connect Your Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Connect your wallet to send confidential tips with hidden amounts.
          </p>
          <Button onClick={() => authenticate()} size="lg">
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12">
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

      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
          <Gift className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Send a Tip</h1>
          <p className="text-sm text-muted-foreground">
            Send a confidential tip with hidden amount
          </p>
        </div>
      </div>

      {/* Privacy Disclosure */}
      <PrivacyDisclosure compact className="mb-6" />

      {/* Tip Form */}
      <TipForm
        onSubmit={handleSendTip}
        isSubmitting={isSubmitting}
        submitError={submitError}
        disabled={sendState.status === "success"}
      />

      {/* Status Display */}
      {sendState.status !== "idle" && sendState.status !== "success" && (
        <div className="mt-6 space-y-3">
          {/* Validating */}
          {sendState.status === "validating" && (
            <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Validating inputs...
            </div>
          )}

          {/* Fetching pubkey */}
          {sendState.status === "fetching_pubkey" && (
            <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking recipient encryption pubkey...
            </div>
          )}

          {/* Building proof */}
          {sendState.status === "building_proof" && (
            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/30 p-3 text-sm text-purple-700 dark:text-purple-300 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating encryption proof (this may take a moment)...
            </div>
          )}

          {/* Submitting */}
          {sendState.status === "submitting" && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Submitting confidential tip transaction...
            </div>
          )}

          {/* Confirming */}
          {sendState.status === "confirming" && (
            <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-3 text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Confirming transaction...
            </div>
          )}
        </div>
      )}

      {/* Success state */}
      {sendState.status === "success" && (
        <div className="mt-6 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-6 text-center">
          <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h3 className="text-lg font-bold mb-1">Tip Sent! </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Your confidential tip has been sent to {tipData?.recipient?.slice(0, 10)}...
            {sendState.txId && (
              <span className="block mt-1 text-xs font-mono">
                Tx: {sendState.txId.slice(0, 18)}...
              </span>
            )}
          </p>
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <EyeOff className="w-3 h-3" />
            Amount is cryptographically hidden
          </div>
          <div className="flex gap-3 mt-4 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/tips")}
            >
              View My Tips
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setSendState({ status: "idle", tipID: null, error: null, txId: null });
                setTipData(null);
                setRecipientPubkey(null);
                setEncryptResult(null);
              }}
            >
              Send Another
            </Button>
          </div>
        </div>
      )}

      {/* Error display */}
      {submitError && (
        <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">
                Tip failed
              </p>
              <p className="text-xs text-destructive/80">{submitError}</p>
            </div>
          </div>
        </div>
      )}

      {/* Pubkey status info (non-blocking) */}
      {recipientPubkey && !isSubmitting && (
        <div className="mt-4">
          <RecipientPubkeyDisplay
            address={tipData?.recipient}
            pubkeyData={
              {
                x: `0x${recipientPubkey.x.toString(16)}`,
                y: `0x${recipientPubkey.y.toString(16)}`,
              } as RecipientPubkeyData
            }
            isLoading={false}
          />
        </div>
      )}

      {pubkeyError && !isSubmitting && (
        <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {pubkeyError}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
