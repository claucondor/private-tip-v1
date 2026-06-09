"use client";

/// Confidential tip form for PrivateTip.
///
/// Collects:
/// - Recipient Flow address (validates 0x-prefixed hex format)
/// - Amount in FLOW (UFix64 format, up to 8 decimal places)
/// - Optional memo (max 280 characters)
///
/// The form handles validation client-side and provides a loading
/// state during transaction submission. The actual Cadence transaction
/// is handled by the parent via the onSubmit callback.

import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Gift, Loader2, User, Coins, MessageSquare } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TipFormData {
  /** Recipient Flow address (0x-prefixed, hex) */
  recipient: string;
  /** Amount in FLOW as a string (parsed as UFix64 by Cadence) */
  amount: string;
  /** Optional memo (0-280 chars) */
  memo: string;
}

export interface TipFormErrors {
  recipient?: string;
  amount?: string;
  memo?: string;
}

export interface TipFormProps {
  /** Called with validated form data when the user submits */
  onSubmit: (data: TipFormData) => void;
  /** Whether a transaction is currently being submitted */
  isSubmitting?: boolean;
  /** Error message from the transaction (if any) */
  submitError?: string | null;
  /** Initial values for editing */
  initialValues?: Partial<TipFormData>;
  /** If true, disable the entire form (e.g., wallet not connected) */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const FLOW_ADDRESS_RE = /^0x[0-9a-fA-F]{16}$/;
const UFIX64_RE = /^\d+(\.\d{1,8})?$/;
const MAX_MEMO_LENGTH = 280;

/**
 * Validate a Flow address (0x-prefixed 16-char hex).
 * Flow addresses are always 8 bytes = 16 hex chars with 0x prefix.
 */
function validateRecipient(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Recipient address is required";
  if (!FLOW_ADDRESS_RE.test(trimmed)) {
    return "Invalid Flow address format (expected 0x + 16 hex chars)";
  }
  return undefined;
}

/**
 * Validate a FLOW amount string.
 * Must be a positive number with up to 8 decimal places (UFix64 precision).
 */
function validateAmount(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Amount is required";
  if (!UFIX64_RE.test(trimmed)) {
    return "Invalid amount (positive number, max 8 decimal places)";
  }
  const num = parseFloat(trimmed);
  if (num <= 0) return "Amount must be greater than 0";
  if (num > 1_000_000_000) return "Amount exceeds maximum (1B FLOW)";
  return undefined;
}

/**
 * Validate optional memo text.
 */
function validateMemo(value: string): string | undefined {
  if (value.length > MAX_MEMO_LENGTH) {
    return `Memo too long (max ${MAX_MEMO_LENGTH} characters)`;
  }
  return undefined;
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * TipForm — Confidential tip submission form.
 *
 * Validates all inputs client-side before calling onSubmit.
 * Shows inline errors per field and a loading spinner on the submit button.
 */
export default function TipForm({
  onSubmit,
  isSubmitting = false,
  submitError = null,
  initialValues = {},
  disabled = false,
  className = "",
}: TipFormProps) {
  // ── Form state ──────────────────────────────────────────────────────────
  const [recipient, setRecipient] = useState(initialValues.recipient ?? "");
  const [amount, setAmount] = useState(initialValues.amount ?? "");
  const [memo, setMemo] = useState(initialValues.memo ?? "");
  const [errors, setErrors] = useState<TipFormErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // ── Derived ─────────────────────────────────────────────────────────────
  const charCount = useMemo(() => memo.length, [memo]);
  const isOverMax = charCount > MAX_MEMO_LENGTH;

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleBlur = useCallback(
    (field: keyof TipFormErrors) => {
      setTouched((prev) => ({ ...prev, [field]: true }));
      // Validate on blur
      let error: string | undefined;
      switch (field) {
        case "recipient":
          error = validateRecipient(recipient);
          break;
        case "amount":
          error = validateAmount(amount);
          break;
        case "memo":
          error = validateMemo(memo);
          break;
      }
      setErrors((prev) => ({ ...prev, [field]: error }));
    },
    [recipient, amount, memo]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      // Validate all fields
      const recipientErr = validateRecipient(recipient);
      const amountErr = validateAmount(amount);
      const memoErr = validateMemo(memo);

      setErrors({
        recipient: recipientErr,
        amount: amountErr,
        memo: memoErr,
      });
      setTouched({ recipient: true, amount: true, memo: true });

      if (recipientErr || amountErr || memoErr) return;

      onSubmit({
        recipient: recipient.trim(),
        amount: amount.trim(),
        memo: memo.trim(),
      });
    },
    [recipient, amount, memo, onSubmit]
  );

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <form
      onSubmit={handleSubmit}
      className={`space-y-5 ${className}`}
      noValidate
    >
      {/* Recipient Address */}
      <div className="space-y-2">
        <Label htmlFor="recipient" className="flex items-center gap-1.5">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
          Recipient Address
        </Label>
        <Input
          id="recipient"
          type="text"
          placeholder="0x0000000000000000"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          onBlur={() => handleBlur("recipient")}
          disabled={disabled || isSubmitting}
          aria-invalid={
            touched.recipient && errors.recipient ? true : undefined
          }
          className="font-mono text-sm"
        />
        {touched.recipient && errors.recipient && (
          <p className="text-xs text-destructive">{errors.recipient}</p>
        )}
      </div>

      {/* Amount */}
      <div className="space-y-2">
        <Label htmlFor="amount" className="flex items-center gap-1.5">
          <Coins className="w-3.5 h-3.5 text-muted-foreground" />
          Amount (FLOW)
        </Label>
        <Input
          id="amount"
          type="text"
          inputMode="decimal"
          placeholder="0.1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => handleBlur("amount")}
          disabled={disabled || isSubmitting}
          aria-invalid={
            touched.amount && errors.amount ? true : undefined
          }
        />
        {touched.amount && errors.amount && (
          <p className="text-xs text-destructive">{errors.amount}</p>
        )}
      </div>

      {/* Memo */}
      <div className="space-y-2">
        <Label htmlFor="memo" className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
          Memo
          <span className="text-xs text-muted-foreground font-normal">
            (optional)
          </span>
        </Label>
        <Textarea
          id="memo"
          placeholder="What's this tip for?"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          onBlur={() => handleBlur("memo")}
          disabled={disabled || isSubmitting}
          aria-invalid={touched.memo && errors.memo ? true : undefined}
          maxLength={MAX_MEMO_LENGTH + 20} // allow slight over-typing for UX
          className="resize-none"
        />
        <div className="flex items-center justify-between">
          {touched.memo && errors.memo ? (
            <p className="text-xs text-destructive">{errors.memo}</p>
          ) : (
            <span />
          )}
          <span
            className={`text-xs ${
              isOverMax
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            {charCount}/{MAX_MEMO_LENGTH}
          </span>
        </div>
      </div>

      {/* Submit Error */}
      {submitError && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
          {submitError}
        </div>
      )}

      {/* Submit Button */}
      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={disabled || isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending...
          </>
        ) : (
          <>
            <Gift className="w-4 h-4" />
            Send Tip
          </>
        )}
      </Button>
    </form>
  );
}
