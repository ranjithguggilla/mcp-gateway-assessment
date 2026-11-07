// In-memory data: the task is about the protocol boundary, not persistence.
export interface Customer {
  customer_id: string;
  name: string;
  email: string;
  balance: number;
  status: "active" | "suspended";
}
export interface Refund {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  created_at: string;
}

const customers = new Map<string, Customer>([
  ["CUST-00001", { customer_id: "CUST-00001", name: "Ada Lovelace", email: "ada@example.com", balance: 250, status: "active" }],
  ["CUST-00002", { customer_id: "CUST-00002", name: "Grace Hopper", email: "grace@example.com", balance: 75.5, status: "active" }],
  ["CUST-00003", { customer_id: "CUST-00003", name: "Alan Turing", email: "alan@example.com", balance: 0, status: "active" }],
  ["CUST-00004", { customer_id: "CUST-00004", name: "Hedy Lamarr", email: "hedy@example.com", balance: 1200, status: "suspended" }],
  ["CUST-12345", { customer_id: "CUST-12345", name: "Test Customer", email: "test@example.com", balance: 100, status: "active" }],
]);
const idempotency = new Map<string, Refund>();
let seq = 1000;

export function getCustomer(id: string): Customer | undefined {
  return customers.get(id);
}

export type RefundResult =
  | { ok: true; refund: Refund; replayed: boolean }
  | { ok: false; reason: "not_found" | "suspended" | "insufficient_balance"; detail: string };

export function createRefund(input: { customer_id: string; amount: number; reason: string; idempotency_key?: string }): RefundResult {
  if (input.idempotency_key) {
    const prior = idempotency.get(input.idempotency_key);
    if (prior) return { ok: true, refund: prior, replayed: true };
  }
  const c = customers.get(input.customer_id);
  if (!c) return { ok: false, reason: "not_found", detail: `Customer ${input.customer_id} does not exist` };
  if (c.status === "suspended") return { ok: false, reason: "suspended", detail: `Customer ${c.customer_id} is suspended` };
  if (input.amount > c.balance) {
    return { ok: false, reason: "insufficient_balance", detail: `Refund ${input.amount.toFixed(2)} exceeds balance ${c.balance.toFixed(2)}` };
  }
  c.balance = Math.round((c.balance - input.amount) * 100) / 100;
  const refund: Refund = { refund_id: `RF-${++seq}`, customer_id: c.customer_id, amount: input.amount, reason: input.reason, created_at: new Date().toISOString() };
  if (input.idempotency_key) idempotency.set(input.idempotency_key, refund);
  return { ok: true, refund, replayed: false };
}
