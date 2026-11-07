import type { DatabaseSync } from "node:sqlite";

/**
 * Token-aware SLIDING-LOG rate limiter on SQLite.
 *
 * Every request inserts one row (tenant, ts_ms, tokens). "Used" for a tenant is
 * SUM(tokens) over rows with ts_ms > now - window. That is a true sliding
 * window: no bucket boundaries to burst across.
 *
 * Reservation: we do not know the real token count until the provider answers,
 * so check + insert happen in ONE `BEGIN IMMEDIATE` transaction using an
 * estimate. Later the row is finalized with the actual usage, or deleted if the
 * call failed (failed calls should not burn quota).
 *
 * node:sqlite is synchronous, so inside one process reservations are
 * naturally serialized; BEGIN IMMEDIATE is what keeps them atomic when more
 * than one process shares the file.
 */
export interface LimiterOptions {
  limit: number; // tokens per window
  windowMs: number;
  now?: () => number; // injectable clock for tests
}

export type ReserveResult =
  | { ok: true; reservationId: number; used: number; remaining: number }
  | { ok: false; used: number; remaining: number; retryAfterMs: number };

export class TokenLimiter {
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly stmts;

  constructor(
    private readonly db: DatabaseSync,
    readonly opts: LimiterOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.stmts = {
      sum: db.prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM usage WHERE tenant = ? AND ts_ms > ?"),
      insert: db.prepare("INSERT INTO usage (tenant, ts_ms, tokens, state, request_id) VALUES (?, ?, ?, 'reserved', ?)"),
      inWindow: db.prepare("SELECT ts_ms, tokens FROM usage WHERE tenant = ? AND ts_ms > ? ORDER BY ts_ms ASC"),
      finalize: db.prepare("UPDATE usage SET tokens = ?, state = 'final', provider = ? WHERE id = ?"),
      release: db.prepare("DELETE FROM usage WHERE id = ?"),
      sweep: db.prepare("DELETE FROM usage WHERE ts_ms < ?"),
    };
  }

  /** Atomically check the window and reserve `estimate` tokens. */
  tryReserve(tenant: string, estimate: number, requestId = ""): ReserveResult {
    if (!Number.isFinite(estimate) || estimate <= 0) throw new Error("estimate must be a positive number");
    const now = this.now();
    const since = now - this.opts.windowMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { used } = this.stmts.sum.get(tenant, since) as { used: number };
      if (used + estimate > this.opts.limit) {
        const retryAfterMs = this.retryAfter(tenant, since, now, used, estimate);
        this.db.exec("ROLLBACK");
        return { ok: false, used, remaining: Math.max(0, this.opts.limit - used), retryAfterMs };
      }
      const r = this.stmts.insert.run(tenant, now, Math.ceil(estimate), requestId);
      this.db.exec("COMMIT");
      const newUsed = used + Math.ceil(estimate);
      return { ok: true, reservationId: Number(r.lastInsertRowid), used: newUsed, remaining: Math.max(0, this.opts.limit - newUsed) };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /** How long until enough of the oldest rows age out for `estimate` to fit. */
  private retryAfter(tenant: string, since: number, now: number, used: number, estimate: number): number {
    const rows = this.stmts.inWindow.all(tenant, since) as Array<{ ts_ms: number; tokens: number }>;
    let remainingUsed = used;
    for (const row of rows) {
      remainingUsed -= row.tokens;
      if (remainingUsed + estimate <= this.opts.limit) {
        return Math.max(1, row.ts_ms + this.opts.windowMs - now + 1);
      }
    }
    // Even an empty window can't fit it (estimate > limit): tell them the full window.
    return this.opts.windowMs;
  }

  /** Replace the estimate with the provider's reported usage. */
  finalize(reservationId: number, actualTokens: number, provider: string): void {
    this.stmts.finalize.run(Math.max(0, Math.ceil(actualTokens)), provider, reservationId);
  }

  /** The call failed: give the tokens back. */
  release(reservationId: number): void {
    this.stmts.release.run(reservationId);
  }

  used(tenant: string): number {
    const { used } = this.stmts.sum.get(tenant, this.now() - this.opts.windowMs) as { used: number };
    return used;
  }

  /** Rows older than 2 windows are irrelevant to every query; delete them to keep the file small. */
  sweep(): number {
    return Number(this.stmts.sweep.run(this.now() - 2 * this.opts.windowMs).changes);
  }

  startSweeper(intervalMs = 30_000): void {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }
}

/** estimate = ceil(promptChars / 4) + max_tokens — reconciled to actual usage after the call. */
export function estimateTokens(prompt: string, maxTokens: number): number {
  return Math.ceil(prompt.length / 4) + maxTokens;
}
