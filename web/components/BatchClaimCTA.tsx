/// BatchClaimCTA — drain ShieldedInbox and claim into shielded balance.
///
/// Shows when the user's COA inbox has ≥ 1 pending notes (received tips not yet
/// consolidated into the ShieldedCheckpoint). Each note was individually deposited
/// by senders via shieldedTransfer; claim proves ownership and aggregates
/// them into a single commitment update.
///
/// Routing by note count:
///   count < BATCH_N  → "Claim N notes" (same batch circuit, SDK pads to N with zeros)
///   count >= BATCH_N → "Batch-claim N notes (~90s proof)"
///
/// Full flow (all browser-safe, no raw EVM private key):
///   1. peekAll  — view read of pending notes (no signature)
///   2. decrypt  — ECIES decrypt each note locally with memoPrivkey
///   3. proof    — POST /api/proof/batch-claim (Node.js, 60-90s)
///                 SDK pads notes to BATCH_N=10 with zero-amount/zero-blinding entries
///   4. claim    — FCL COA tx: claimBatchAtomic (EVM) or claimBatchFtAtomic (FT)
///                 drainAll + claimBatch + ShieldedCheckpoint.update in ONE tx
///   5. callback — triggers portfolio refresh via onClaimed()
///
/// Token routing: FLOW + mUSDC → cadenceTx.claimBatchAtomic
///                MockFT (cadence-ft) → cadenceTx.claimBatchFtAtomic
///
/// IMPORTANT — blinding tracking:
///   The proof computes C_new = Commit(newBalance, newBlinding).
///   The checkpoint must store newBlinding (not oldBlinding + delta + newBlinding).
///   Using the wrong blinding causes "C_old mismatch" on the next claim.

"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, Loader2, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ethers } from "ethers";
import {
  ShieldedInboxClient,
  ShieldedCheckpointClient,
  getCadenceInboxNotes,
  decryptNote,
  generateBlinding,
  encryptSnapshot,
  computeCommitment,
  safeBuildClaimProof,
  CheckpointDivergenceError,
} from "@claucondor/sdk";
import { FLOW_CADENCE_ACCESS, CADENCE_DEPLOYER_ADDRESS } from "@claucondor/sdk/network";
import {
  getCoaEvmAddress,
  getShieldedStateForCoa,
  getCommitment,
} from "@/lib/tip-actions";
import { cadenceTx, TOKEN_REGISTRY, FLOW_EVM_RPC } from "@claucondor/sdk";
import { FLOWSCAN_CADENCE_TX } from "@/lib/explorer";
import { type TokenId, getTokenMeta } from "@/lib/tokens";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHIELDED_INBOX_ADDRESS = "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6";
/** Fixed circuit size — SDK pads any count < BATCH_N with zero notes. */
const BATCH_N           = 10;
const MIN_NOTES_TO_SHOW = 1; // show CTA for any pending note
/** BabyJubjub subgroup order — used for field-safe blinding accumulation. */
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// ─── Inbox head-offset helper ──────────────────────────────────────────────────

/**
 * Read the physical drain head-offset from inbox storage.
 *
 * peekAll() returns notes at relative array positions [0, n), but the
 * ShieldedCheckpoint cursor (lastConsumedNoteIndex) is an absolute storage index.
 * When drainAll() has been called historically, headOffset > 0 and every note
 * returned by peek has absoluteIndex = headOffset + relativeIdx.
 *
 * Storage layout: _heads is a mapping(address => uint256) at slot 1.
 * headSlot = keccak256(abi.encode(owner, 1)).
 */
async function getInboxHeadOffset(coaAddr: string): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
    const headSlot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [coaAddr, 1])
    );
    const raw = await provider.getStorage(SHIELDED_INBOX_ADDRESS, headSlot);
    return BigInt(raw);
  } catch {
    return 0n; // non-fatal: relative idx ≈ absolute idx when no drain happened
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

type ClaimStatus = "idle" | "checking" | "building_proof" | "claiming" | "success" | "error";

interface BatchClaimCTAProps {
  /** Connected user's Flow (Cadence) address. */
  userAddress: string | null;
  /** Called after a successful batch claim so the parent can refresh balances. */
  onClaimed?: () => void;
  /** Token to batch-claim for. Defaults to FLOW. */
  tokenId?: TokenId;
  /** EVM proxy address of the token. Defaults to JanusFlow proxy. */
  tokenAddress?: string;
}

export function BatchClaimCTA({
  userAddress,
  onClaimed,
  tokenId = "flow",
  tokenAddress = TOKEN_REGISTRY.flow.proxy,
}: BatchClaimCTAProps) {
  const [coaAddr, setCoaAddr]       = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState<number>(0);
  const [status, setStatus]         = useState<ClaimStatus>("checking");
  const [error, setError]           = useState<string | null>(null);
  const [claimTxId, setClaimTxId]  = useState<string | null>(null);

  const tokenMeta = getTokenMeta(tokenId);

  // ── Initial count check ────────────────────────────────────────────────────

  useEffect(() => {
    if (!userAddress) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus("checking");
      try {
        const coa = await getCoaEvmAddress(userAddress);
        if (cancelled) return;
        setCoaAddr(coa);

        // Cadence-ft tokens (e.g. MockFT) store pending notes in the Cadence
        // ShieldedInbox, NOT the EVM ShieldedInbox. Use getCadenceInboxNotes for count.
        // EVM tokens (FLOW, mUSDC) use the peekAll + cursor-filter path as before.
        const isCadenceFt = TOKEN_REGISTRY[tokenId]?.variant === "cadence-ft";

        if (isCadenceFt) {
          const cadenceNotes = await getCadenceInboxNotes(userAddress, {
            flowAccessNode: FLOW_CADENCE_ACCESS,
            inboxContractAddress: CADENCE_DEPLOYER_ADDRESS,
          }).catch(() => [] as Awaited<ReturnType<typeof getCadenceInboxNotes>>);
          if (!cancelled) {
            setInboxCount(cadenceNotes.length);
            setStatus("idle");
          }
        } else {
          // peekAll + cursor filter for accurate per-token pending count.
          // Mirror getPortfolioView: read lastConsumedNoteIndex from public checkpoint
          // metadata (no memoPrivkey needed) and exclude already-claimed notes.
          const ibClient = new ShieldedInboxClient(SHIELDED_INBOX_ADDRESS);
          const cpClient = new ShieldedCheckpointClient();
          const [allNotes, cpMeta, headOffset] = await Promise.all([
            ibClient.peekAll(coa).catch(() => []),
            cpClient.metadata(coa, tokenAddress).catch(() => null),
            getInboxHeadOffset(coa),
          ]);
          const cursor = cpMeta?.lastConsumedNoteIndex ?? 0n;
          // absoluteIndex = headOffset + relativeIdx (headOffset > 0 when drainAll was called).
          const tokenNotes = allNotes.filter(
            (n, idx) =>
              n.depositor.toLowerCase() === tokenAddress.toLowerCase() &&
              headOffset + BigInt(idx) >= cursor
          );
          if (!cancelled) {
            setInboxCount(tokenNotes.length);
            setStatus("idle");
          }
        }
      } catch {
        if (!cancelled) setStatus("idle"); // non-fatal — hide the CTA on error
      }
    })();
    return () => { cancelled = true; };
  }, [userAddress, tokenAddress, tokenId]);

  // ── Batch claim handler ────────────────────────────────────────────────────

  const handleClaim = useCallback(async () => {
    if (!userAddress || !coaAddr) return;
    setError(null);

    try {
      // Step 1: Load memoPrivkey from session.
      const { getCachedMemoPrivkey } = await import("@/lib/memo-key-session");
      const memoPrivkey = getCachedMemoPrivkey(userAddress);
      if (memoPrivkey === null) {
        throw new Error("Private key not in session — unlock first from the portfolio page.");
      }

      // Step 1b: Read checkpoint state early — cursor needed to filter the inbox.
      // This is the same call that Step 4 used to make; moving it here eliminates the
      // duplicate read and ensures the filter sees the actual consumed-note boundary.
      const prevState = await getShieldedStateForCoa(coaAddr, memoPrivkey, tokenAddress);
      const cursor = prevState?.lastConsumedNoteIndex ?? 0n;

      // Step 2: Peek pending notes; filter by depositor AND by absolute position >= cursor.
      // Notes at absoluteIndex < cursor were consumed by a prior claimBatchAtomic and must
      // not be re-processed. absoluteIndex = headOffset + relativeIdx (headOffset > 0 when
      // drainAll has been called historically — read from inbox storage slot 1).
      const ibClient = new ShieldedInboxClient(SHIELDED_INBOX_ADDRESS);
      const [allNotes, claimHeadOffset] = await Promise.all([
        ibClient.peekAll(coaAddr),
        getInboxHeadOffset(coaAddr),
      ]);
      const rawNotes = allNotes.filter(
        (n, idx) =>
          n.depositor.toLowerCase() === tokenAddress.toLowerCase() &&
          claimHeadOffset + BigInt(idx) >= cursor
      );
      if (rawNotes.length === 0) {
        toast.info(`No new ${tokenMeta.symbol} notes to claim.`);
        setInboxCount(0);
        setStatus("idle");
        return;
      }

      // Step 3: Decrypt notes locally.
      const decrypted: Array<{ amount: bigint; blinding: bigint }> = [];
      for (const n of rawNotes) {
        try {
          const ephPub = { x: BigInt(n.ephPubkeyX), y: BigInt(n.ephPubkeyY) };
          const dec = await decryptNote(
            n.ciphertext instanceof Uint8Array ? n.ciphertext : Uint8Array.from(Object.values(n.ciphertext as Record<string, number>)),
            ephPub,
            memoPrivkey
          );
          decrypted.push({ amount: dec.amount, blinding: dec.blinding });
        } catch {
          // Note not decryptable with this key — skip (may belong to different token/key).
        }
      }
      if (decrypted.length === 0) {
        throw new Error("None of the pending notes could be decrypted with your memo key.");
      }

      // Step 4: Checkpoint state was already read in Step 1b — reuse prevState here.
      const oldBalance  = prevState?.balance ?? 0n;
      const oldBlinding = prevState?.blinding ?? 0n;

      // Step 4b: Reconstruct actual C_old = checkpoint + accumulated tip deltas.
      // shieldedTransfer updates commitments[recipient] homomorphically but does NOT
      // update the recipient's ShieldedCheckpoint. Accumulate each pending note's
      // amount and blinding onto the checkpoint values to match the on-chain commitment.
      let actualOldBalance  = oldBalance;
      let actualOldBlinding = oldBlinding;
      for (const note of decrypted) {
        actualOldBalance  += note.amount;
        actualOldBlinding  = (actualOldBlinding + note.blinding) % SUBORDER;
      }

      // Pre-flight sanity check via SDK safety guard: verifies computed C_old (checkpoint +
      // accumulated pending notes) matches the on-chain commitment before wasting gas on a proof.
      // CheckpointDivergenceError surfaces structured diagnostics (pendingCount, C_computed, C_chain).
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const janusTokenAddr = (TOKEN_REGISTRY[tokenId] as any).proxy as string | undefined ?? tokenAddress;
        await safeBuildClaimProof({
          coa: coaAddr,
          tokenAddress,
          janusTokenAddr,
          memoPrivkey,
        });
      } catch (err) {
        if (err instanceof CheckpointDivergenceError) {
          throw new Error(
            `C_old sanity check failed — commitment divergence detected.\n` +
            `pendingCount=${err.diagnostics.pendingCount} ` +
            `cpBalance=${err.diagnostics.cpBalance.toString().slice(0, 12)}… ` +
            `sumPending=${err.diagnostics.sumPendingAmts.toString().slice(0, 12)}…\n` +
            `Blinding may be corrupted. Contact support or use adminResetCommitment (testnet).`,
          );
        }
        throw err; // re-throw non-divergence errors
      }

      // Step 5: Generate fresh blinding for new commitment.
      const newBlinding = generateBlinding();

      setStatus("building_proof");

      // Step 6: Build batch claim proof server-side (60-90s).
      const proofResp = await fetch("/api/proof/batch-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldBalance:     actualOldBalance.toString(),   // checkpoint + tip deltas = actual C_old
          oldBlinding:    actualOldBlinding.toString(),  // field-accumulated blinding
          newBlinding:    newBlinding.toString(),
          notesToConsume: [],  // zero notes — re-blinding only; tips already captured in C_old
        }),
      });
      if (!proofResp.ok) {
        const errText = await proofResp.text().catch(() => proofResp.statusText);
        throw new Error(`Proof generation failed (${proofResp.status}): ${errText}`);
      }
      const { proof, publicInputs } = await proofResp.json() as {
        proof: string[];
        publicInputs: string[];
      };

      setStatus("claiming");

      // Step 7+8+9 (atomic): drainAll + claimBatch + ShieldedCheckpoint.update in one FCL tx.
      // newBalance = actualOldBalance: tip amounts are already in C_old via accumulation above.
      // Adding them again here would double-count and produce a wrong C_new.
      const newBalance = actualOldBalance;
      // Advance cursor to absolute end of inbox at fetch time (headOffset + count),
      // consuming ALL pending notes across all tokens — matches fuzz _claimBatch behaviour.
      const newCursor = claimHeadOffset + BigInt(allNotes.length);

      // Load memoKeypair for checkpoint encryption.
      const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
      const pubkey = await pubkeyFromPrivkey(memoPrivkey);
      const memoKeypair = { privkey: memoPrivkey, pubkey };

      const cpEnc = await encryptSnapshot(
        { balance: newBalance, blinding: newBlinding },  // newBlinding matches C_new in the proof
        memoKeypair.pubkey,
      );

      // Route: cadence-ft (MockFT) → claimBatchFtAtomic; EVM tokens → claimBatchAtomic.
      const isCadenceFt = TOKEN_REGISTRY[tokenId].variant === "cadence-ft";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ftContractAddr = isCadenceFt ? (TOKEN_REGISTRY[tokenId] as any).cadenceAddress as string : tokenAddress;

      const fcl = await import("@onflow/fcl");
      let atomicTxId: string;
      if (isCadenceFt) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        atomicTxId = await (fcl as any).mutate({
          cadence: cadenceTx.claimBatchFtAtomic(tokenAddress, ftContractAddr),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: (arg: (v: unknown, t: unknown) => unknown, t: { Address: unknown; Array: (inner: unknown) => unknown; UInt256: unknown; String: unknown; UInt64: unknown }) => [
            arg(userAddress, t.Address),
            arg(publicInputs.map(String), t.Array(t.UInt256)),
            arg(proof.map(String), t.Array(t.UInt256)),
            arg(ethers.hexlify(cpEnc.ciphertext).slice(2), t.String),
            arg(cpEnc.ephemeralPubkey.x.toString(), t.UInt256),
            arg(cpEnc.ephemeralPubkey.y.toString(), t.UInt256),
            arg(newCursor.toString(), t.UInt64),
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          proposer: (fcl as any).authz,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payer: (fcl as any).authz,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authorizations: [(fcl as any).authz],
          limit: 9999,
        });
      } else {
        // Pre-encode claimBatch calldata with ethers.js to avoid [UInt256]→uint256[N]
        // dynamic-array ABI mismatch when Cadence passes fixed-size EVM arrays.
        const claimIface = new ethers.Interface([
          "function claimBatch(uint256[6] calldata publicInputs, uint256[8] calldata proof) external",
        ]);
        const claimCalldataHex = claimIface.encodeFunctionData("claimBatch", [
          publicInputs.map(BigInt),
          proof.map(BigInt),
        ]).slice(2); // strip 0x prefix — Cadence decodeHex() expects no prefix

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        atomicTxId = await (fcl as any).mutate({
          cadence: cadenceTx.claimBatchAtomic(tokenAddress),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: (arg: (v: unknown, t: unknown) => unknown, t: { String: unknown; UInt256: unknown; UInt64: unknown }) => [
            arg(claimCalldataHex, t.String),
            arg(ethers.hexlify(cpEnc.ciphertext).slice(2), t.String),
            arg(cpEnc.ephemeralPubkey.x.toString(), t.UInt256),
            arg(cpEnc.ephemeralPubkey.y.toString(), t.UInt256),
            arg(newCursor.toString(), t.UInt64),
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          proposer: (fcl as any).authz,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payer: (fcl as any).authz,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authorizations: [(fcl as any).authz],
          limit: 9999,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (fcl as any).tx(atomicTxId).onceSealed();

      setClaimTxId(atomicTxId);
      setInboxCount(0);
      setStatus("success");
      toast.success(
        `Claim complete — ${decrypted.length} ${tokenMeta.symbol} note${decrypted.length !== 1 ? "s" : ""} consolidated into your shielded balance.`
      );
      onClaimed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
      toast.error("Claim failed", { description: msg });
    }
  }, [userAddress, coaAddr, onClaimed, tokenAddress, tokenMeta.symbol]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Hide if not logged in, still checking, or too few notes
  if (!userAddress || status === "checking" || (status === "idle" && inboxCount < MIN_NOTES_TO_SHOW)) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.35 }}
        className="rounded-xl border border-[#6B46C1]/30 bg-[#6B46C1]/8 p-5 mb-4"
      >
        {status === "success" ? (
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-[#00EF8B] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">Claim complete</p>
              <p className="text-xs text-foreground/50 mb-2">
                {tokenMeta.symbol} notes consolidated into your shielded balance.
              </p>
              {claimTxId && (
                <a
                  href={FLOWSCAN_CADENCE_TX(claimTxId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-[#6B46C1] hover:text-[#8B5CF6] transition-colors"
                >
                  {claimTxId.slice(0, 20)}… ↗
                </a>
              )}
            </div>
          </div>
        ) : status === "error" ? (
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">Claim failed</p>
              <p className="text-xs text-red-400/70 mb-2">{error}</p>
              <motion.button
                onClick={() => { setStatus("idle"); setError(null); }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="text-xs px-3 py-1 rounded border border-white/15 bg-white/5 text-foreground/70 hover:bg-white/10 transition-colors"
              >
                Dismiss
              </motion.button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Inbox className="w-5 h-5 text-[#8B5CF6] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground mb-0.5">
                  {inboxCount} {tokenMeta.symbol} tip{inboxCount !== 1 ? "s" : ""} waiting in your inbox
                </p>
                {inboxCount >= BATCH_N ? (
                  <p className="text-xs text-foreground/50">
                    Batch-claim {inboxCount} notes into your shielded {tokenMeta.symbol} balance.
                    {" "}<span className="text-foreground/30">(~90s proof generation)</span>
                  </p>
                ) : (
                  <p className="text-xs text-foreground/50">
                    Claim {inboxCount} note{inboxCount !== 1 ? "s" : ""} into your shielded {tokenMeta.symbol} balance.
                    {" "}<span className="text-foreground/30">(~90s one-time proof)</span>
                  </p>
                )}
              </div>
            </div>
            <motion.button
              onClick={handleClaim}
              disabled={status !== "idle"}
              whileHover={status === "idle" ? { scale: 1.02, y: -1 } : {}}
              whileTap={{ scale: 0.98 }}
              className="shrink-0 px-4 py-2 rounded-lg border border-[#6B46C1]/50 bg-[#6B46C1]/15 text-[#8B5CF6] text-sm font-medium hover:bg-[#6B46C1]/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {status === "building_proof" ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating proof…
                </span>
              ) : status === "claiming" ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Submitting…
                </span>
              ) : inboxCount >= BATCH_N ? (
                `Batch-claim ${inboxCount} notes`
              ) : (
                `Claim ${inboxCount} note${inboxCount !== 1 ? "s" : ""}`
              )}
            </motion.button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
