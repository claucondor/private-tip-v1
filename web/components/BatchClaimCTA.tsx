/// BatchClaimCTA — drain ShieldedInbox and batch-claim into shielded balance.
///
/// Shows when the user's COA inbox has ≥ 5 pending notes (received tips not yet
/// consolidated into the ShieldedCheckpoint). Each note was individually deposited
/// by senders via shieldedTransfer; batch-claim proves ownership and aggregates
/// them into a single commitment update.
///
/// Full flow (all browser-safe, no raw EVM private key):
///   1. peekAll  — view read of pending notes (no signature)
///   2. decrypt  — ECIES decrypt each note locally with memoPrivkey
///   3. proof    — POST /api/proof/batch-claim (Node.js, 60-90s)
///   4. drain    — FCL COA tx: ShieldedInbox.drainAll() removes notes from mailbox
///   5. claim    — FCL COA tx: JanusToken.claimBatch(publicInputs, proof)
///   6. update   — FCL COA tx: ShieldedCheckpoint.update() persists new encrypted state
///   7. callback — triggers portfolio refresh via onClaimed()
///
/// Scope (Phase 4): FLOW token only. mUSDC / MockFT claim requires per-token routing
/// (the batch-claim verifier address differs) — deferred to Phase 7.

"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, Loader2, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  ShieldedInboxClient,
  decryptNote,
  generateBlinding,
  cadenceTx,
  encryptSnapshot,
} from "@claucondor/sdk";
import { TOKEN_REGISTRY } from "@claucondor/sdk/network";
import {
  getCoaEvmAddress,
  getShieldedStateForCoa,
  encryptAndUpdateCheckpointViaCoa,
} from "@/lib/tip-actions";
import { FLOWSCAN_CADENCE_TX } from "@/lib/explorer";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHIELDED_INBOX_ADDRESS = "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6";
const EVM_SYSTEM_CONTRACT    = "0x8c5303eaa26202d6";
const BABYJUB_SUBORDER       = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const MIN_NOTES_TO_SHOW      = 5; // show CTA only when inbox has ≥ this many notes

// JanusFlow proxy (FLOW token) — batch claim target for Phase 4.
const JANUS_FLOW_PROXY = TOKEN_REGISTRY.flow.proxy;

// ─── Inline Cadence tx templates ─────────────────────────────────────────────

/** Cadence tx: drain all pending notes from ShieldedInbox via COA. */
const TX_DRAIN_INBOX = `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("drain_inbox: no COA at /storage/evm — activate first")
  }

  execute {
    let inboxAddr = EVM.addressFromString("${SHIELDED_INBOX_ADDRESS}")
    let calldata  = EVM.encodeABIWithSignature("drainAll()", [])
    // Non-fatal if inbox has no notes (already drained concurrently).
    let _ = self.coa.call(
      to:       inboxAddr,
      data:     calldata,
      gasLimit: 400000,
      value:    EVM.Balance(attoflow: 0)
    )
  }
}
`;

/** Cadence tx: submit batch claim proof to JanusToken.claimBatch() via COA. */
function TX_CLAIM_BATCH(janusProxy: string): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  publicInputs: [UInt256],
  proof:        [UInt256]
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("claim_batch: no COA at /storage/evm — activate first")
  }

  execute {
    let janusAddr = EVM.addressFromString("${janusProxy}")
    let calldata  = EVM.encodeABIWithSignature(
      "claimBatch(uint256[6],uint256[8])",
      [publicInputs, proof]
    )
    let result = self.coa.call(
      to:       janusAddr,
      data:     calldata,
      gasLimit: 600000,
      value:    EVM.Balance(attoflow: 0)
    )
    assert(
      result.status == EVM.Status.successful,
      message: "JanusToken.claimBatch failed: ".concat(result.errorMessage)
    )
  }
}
`;
}

// ─── Component ────────────────────────────────────────────────────────────────

type ClaimStatus = "idle" | "checking" | "building_proof" | "claiming" | "success" | "error";

interface BatchClaimCTAProps {
  /** Connected user's Flow (Cadence) address. */
  userAddress: string | null;
  /** Called after a successful batch claim so the parent can refresh balances. */
  onClaimed?: () => void;
}

export function BatchClaimCTA({ userAddress, onClaimed }: BatchClaimCTAProps) {
  const [coaAddr, setCoaAddr]       = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState<number>(0);
  const [status, setStatus]         = useState<ClaimStatus>("checking");
  const [error, setError]           = useState<string | null>(null);
  const [claimTxId, setClaimTxId]  = useState<string | null>(null);

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

        const ibClient = new ShieldedInboxClient(SHIELDED_INBOX_ADDRESS);
        const count = Number(await ibClient.count(coa));
        if (!cancelled) {
          setInboxCount(count);
          setStatus("idle");
        }
      } catch {
        if (!cancelled) setStatus("idle"); // non-fatal — hide the CTA on error
      }
    })();
    return () => { cancelled = true; };
  }, [userAddress]);

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

      // Step 2: Peek pending notes (view call — no signature).
      const ibClient = new ShieldedInboxClient(SHIELDED_INBOX_ADDRESS);
      const rawNotes = await ibClient.peekAll(coaAddr);
      if (rawNotes.length === 0) {
        toast.info("No pending notes found.");
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

      // Step 4: Read current checkpoint state (prevBalance + prevBlinding).
      const prevState = await getShieldedStateForCoa(coaAddr, memoPrivkey);
      const oldBalance  = prevState?.balance ?? 0n;
      const oldBlinding = prevState?.blinding ?? 0n;
      const prevCursor  = prevState?.lastConsumedNoteIndex ?? 0n;

      // Step 5: Generate fresh blinding for new commitment.
      const newBlinding = generateBlinding();

      setStatus("building_proof");

      // Step 6: Build batch claim proof server-side (60-90s).
      const proofResp = await fetch("/api/proof/batch-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldBalance:     oldBalance.toString(),
          oldBlinding:    oldBlinding.toString(),
          newBlinding:    newBlinding.toString(),
          notesToConsume: decrypted.map((n) => ({
            amount:  n.amount.toString(),
            blinding: n.blinding.toString(),
          })),
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
      const fcl = await import("@onflow/fcl");

      // Step 7: Drain inbox via COA (removes notes from ShieldedInbox mailbox).
      const drainTxId: string = await fcl.mutate({
        cadence: TX_DRAIN_INBOX,
        args: () => [],
        proposer: fcl.authz,
        payer: fcl.authz,
        authorizations: [fcl.authz],
        limit: 9999,
      });
      await fcl.tx(drainTxId).onceSealed();

      // Step 8: Submit claimBatch on JanusFlow proxy via COA.
      const claimTxId: string = await fcl.mutate({
        cadence: TX_CLAIM_BATCH(JANUS_FLOW_PROXY),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: (arg: (v: unknown, t: unknown) => unknown, t: { Array: (inner: unknown) => unknown; UInt256: unknown }) => [
          arg(publicInputs.map(String), t.Array(t.UInt256)),
          arg(proof.map(String), t.Array(t.UInt256)),
        ],
        proposer: fcl.authz,
        payer: fcl.authz,
        authorizations: [fcl.authz],
        limit: 9999,
      });
      await fcl.tx(claimTxId).onceSealed();

      // Step 9: Accumulate new balance + update ShieldedCheckpoint.
      const totalClaimed = decrypted.reduce((acc, n) => acc + n.amount, 0n);
      const totalBlindingDelta = decrypted.reduce((acc, n) => (acc + n.blinding) % BABYJUB_SUBORDER, 0n);
      const newBalance  = oldBalance + totalClaimed;
      const newBlindingFinal = (oldBlinding + totalBlindingDelta + newBlinding) % BABYJUB_SUBORDER;

      // Load memoKeypair for checkpoint encryption.
      const { pubkeyFromPrivkey } = await import("@claucondor/sdk");
      const pubkey = await pubkeyFromPrivkey(memoPrivkey);
      const memoKeypair = { privkey: memoPrivkey, pubkey };

      const newCursor = prevCursor + BigInt(rawNotes.length);
      await encryptAndUpdateCheckpointViaCoa(
        { balance: newBalance, blinding: newBlindingFinal },
        newCursor,
        memoKeypair,
      );

      setClaimTxId(claimTxId);
      setInboxCount(0);
      setStatus("success");
      toast.success(`Batch claim complete — ${decrypted.length} note${decrypted.length !== 1 ? "s" : ""} consolidated.`);
      onClaimed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
      toast.error("Batch claim failed", { description: msg });
    }
  }, [userAddress, coaAddr, onClaimed]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Hide if not logged in, still checking, or no pending notes
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
              <p className="text-sm font-semibold text-foreground mb-1">Batch claim complete</p>
              <p className="text-xs text-foreground/50 mb-2">
                Notes consolidated into your shielded balance.
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
              <p className="text-sm font-semibold text-foreground mb-1">Batch claim failed</p>
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
                  {inboxCount} tip{inboxCount !== 1 ? "s" : ""} waiting in your inbox
                </p>
                <p className="text-xs text-foreground/50">
                  Batch-claim them to add to your shielded FLOW balance.
                  {" "}<span className="text-foreground/30">(~90s proof generation)</span>
                </p>
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
              ) : (
                "Claim all"
              )}
            </motion.button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
