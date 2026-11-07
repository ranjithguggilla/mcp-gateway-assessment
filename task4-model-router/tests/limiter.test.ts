import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { TokenLimiter, estimateTokens } from "../src/limiter.js";

let dir: string;
let now = 1_000_000;
let limiter: TokenLimiter;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limiter-"));
  now = 1_000_000;
  db = openDb(join(dir, "gateway.db"));
  limiter = new TokenLimiter(db, { limit: 50_000, windowMs: 60_000, now: () => now });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("TokenLimiter (sliding log on SQLite, injected clock)", () => {
  it("estimate = ceil(chars/4) + max_tokens", () => {
    expect(estimateTokens("", 100)).toBe(100);
    expect(estimateTokens("abcd", 100)).toBe(101);
    expect(estimateTokens("abcde", 100)).toBe(102);
  });

  it("accepts 10 x 5000, rejects the 11th with retry_after ≈ full window", () => {
    for (let i = 0; i < 10; i++) {
      const r = limiter.tryReserve("A", 5000);
      expect(r.ok).toBe(true);
      now += 100; // 10 requests spread over one second
    }
    const r = limiter.tryReserve("A", 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.used).toBe(50_000);
      expect(r.remaining).toBe(0);
      // oldest row is 1000ms old -> it ages out in ~59s
      expect(r.retryAfterMs).toBeGreaterThan(58_000);
      expect(r.retryAfterMs).toBeLessThanOrEqual(59_001);
    }
  });

  it("window really slides: after the oldest entry ages out, exactly one more fits", () => {
    for (let i = 0; i < 10; i++) {
      limiter.tryReserve("A", 5000);
      now += 1000;
    }
    now += 1; // t = +10.001s
    expect(limiter.tryReserve("A", 5000).ok).toBe(false);
    now = 1_000_000 + 60_001; // first row (ts=1_000_000) is now outside ts > now-60000
    expect(limiter.tryReserve("A", 5000).ok).toBe(true);
    expect(limiter.tryReserve("A", 5000).ok).toBe(false); // second row still inside
    now += 1000;
    expect(limiter.tryReserve("A", 5000).ok).toBe(true);
  });

  it("tenants are isolated", () => {
    for (let i = 0; i < 10; i++) limiter.tryReserve("A", 5000);
    expect(limiter.tryReserve("A", 1).ok).toBe(false);
    expect(limiter.tryReserve("B", 50_000).ok).toBe(true);
  });

  it("finalize reconciles the estimate to actual usage; release gives it all back", () => {
    const r1 = limiter.tryReserve("A", 40_000);
    expect(r1.ok && r1.reservationId).toBeTruthy();
    if (!r1.ok) return;
    expect(limiter.tryReserve("A", 20_000).ok).toBe(false);
    limiter.finalize(r1.reservationId, 1_234, "primary");
    expect(limiter.used("A")).toBe(1_234);
    const r2 = limiter.tryReserve("A", 48_000);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    limiter.release(r2.reservationId);
    expect(limiter.used("A")).toBe(1_234);
    const row = db.prepare("SELECT state, provider FROM usage WHERE id = ?").get(r1.reservationId) as { state: string; provider: string };
    expect(row).toEqual({ state: "final", provider: "primary" });
  });

  it("retry_after is the time until enough tokens age out, not always the full window", () => {
    limiter.tryReserve("A", 30_000); // t0
    now += 10_000;
    limiter.tryReserve("A", 20_000); // t0+10s
    now += 1_000; // t0+11s
    const r = limiter.tryReserve("A", 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(60_000 - 11_000 + 1); // when the 30k row drops out
  });

  it("an estimate larger than the whole limit is rejected with retry_after = window", () => {
    const r = limiter.tryReserve("A", 60_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(60_000);
  });

  it("sweep deletes rows older than two windows and never affects the current window", () => {
    limiter.tryReserve("A", 100);
    now += 130_000;
    limiter.tryReserve("A", 200);
    expect(limiter.sweep()).toBe(1);
    expect(limiter.used("A")).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n).toBe(1);
  });

  it("reservation is atomic across two connections to the same file (BEGIN IMMEDIATE)", () => {
    const db2 = openDb(join(dir, "gateway.db"));
    const l2 = new TokenLimiter(db2, { limit: 50_000, windowMs: 60_000, now: () => now });
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const l = i % 2 ? limiter : l2;
      if (l.tryReserve("A", 5000).ok) ok++;
    }
    expect(ok).toBe(10);
    db2.close();
  });
});
