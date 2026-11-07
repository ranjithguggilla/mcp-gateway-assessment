import { z } from "zod";

// Anchored on purpose: without ^ and $, "xCUST-12345y" would pass.
export const CustomerId = z.string().regex(/^CUST-\d{5}$/, "customer_id must match CUST-XXXXX (five digits)");

// JSON cannot carry NaN/Infinity, but 1e400 parses to Infinity, so finite() matters. No coercion: "10" fails.
export const Amount = z.number().finite("amount must be finite").positive("amount must be > 0");

// Trim first so ten spaces is not a reason.
export const Reason = z.string().trim().min(10, "reason must be at least 10 characters");

export const GetCustomerRecordSchema = z.object({ customer_id: CustomerId }).strict();
export const TriggerRefundSchema = z
  .object({ customer_id: CustomerId, amount: Amount, reason: Reason, idempotency_key: z.string().min(1).max(128).optional() })
  .strict();

export type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordSchema>;
export type TriggerRefundArgs = z.infer<typeof TriggerRefundSchema>;
