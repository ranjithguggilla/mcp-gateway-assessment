/**
 * Integration: spawns the REAL mock provider and the REAL router (fresh SQLite
 * file) and drives them over HTTP.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 14002;
const GW_PORT = 13003;
const GW = `http://localhost:${GW_PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;

interface Proc { child: ChildProcess; stderr: () => string; stop: () => Promise<void> }
function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [resolve(root, script)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d.toString()));
  return {
    child,
    stderr: () => err,
    stop: () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", () => res()); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }),
  };
}
async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for " + url);
}
async function setModes(modes: { primary?: string; secondary?: string; usage?: string }) {
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ ...modes, reset_calls: true }) });
}
async function calls(): Promise<{ primary: number; secondary: number }> {
  return (await (await fetch(`${MOCK}/__control`)).json()).calls;
}
async function complete(tenant: string, body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(`${GW}/v1/complete`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": tenant }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: JSON.parse(text), text, ms: performance.now() - t0 };
}

let dir: string;
let dbPath: string;
let mock: Proc;
let gw: Proc;
let tenantSeq = 0;
let tenant = "";

beforeAll(async () => {
  if (!existsSync(resolve(root, "dist/server.js"))) execSync("npm run build", { cwd: root, stdio: "inherit" });
  dir = mkdtempSync(join(tmpdir(), "router-"));
  dbPath = join(dir, "gateway.db");
  mock = start("dist/mock-provider/server.js", { MOCK_PROVIDER_PORT: String(MOCK_PORT), MOCK_TIMEOUT_DELAY_MS: "6000", MOCK_LATENCY_MS: "50" });
  gw = start("dist/server.js", {
    ROUTER_PORT: String(GW_PORT),
    DB_PATH: dbPath,
    PRIMARY_URL: `${MOCK}/primary`,
    SECONDARY_URL: `${MOCK}/secondary`,
    PRIMARY_TIMEOUT_MS: "3000",
    TOKEN_LIMIT: "50000",
    WINDOW_MS: "60000",
  });
  await waitFor(`${MOCK}/healthz`);
  await waitFor(`${GW}/readyz`);
});
afterAll(async () => {
  await Promise.all([gw?.stop(), mock?.stop()]);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  tenant = `tenant-${++tenantSeq}`; // fresh 60 s window per test
  await setModes({ primary: "ok", secondary: "ok", usage: "max" });
});

describe("happy path", () => {
  it("routes to primary, returns usage and rate-limit headers, persists a final row in SQLite", async () => {
    const r = await complete(tenant, { prompt: "Say hello", max_tokens: 50 });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("primary");
    expect(r.json.failed_over).toBe(false);
    expect(r.json.usage.total_tokens).toBeGreaterThan(0);
    expect(r.headers.get("x-ratelimit-limit")).toBe("50000");
    expect(Number(r.headers.get("x-ratelimit-remaining"))).toBe(50000 - r.json.usage.total_tokens);
    expect(r.headers.get("x-request-id")).toBe(r.json.request_id);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT tokens, state, provider FROM usage WHERE tenant = ?").get(tenant) as any;
    db.close();
    expect(row).toEqual({ tokens: r.json.usage.total_tokens, state: "final", provider: "primary" });
  });
});

describe("rate limiting", () => {
  it("20 concurrent requests estimating 5,000 tokens each -> exactly 10 accepted, 10 get 429 with retry_after_ms", async () => {
    // Provider reports full max_tokens usage (default), so each accepted request keeps its 5,000 in the window.
    const results = await Promise.all(Array.from({ length: 20 }, () => complete(tenant, { prompt: "burst", max_tokens: 4998, estimated_tokens: 5000 })));
    const ok = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);
    expect(ok.length).toBe(10);
    expect(limited.length).toBe(10);
    for (const r of limited) {
      expect(r.json.error.code).toBe("RATE_LIMITED");
      expect(typeof r.json.error.request_id).toBe("string");
      expect(r.json.error.retry_after_ms).toBeGreaterThan(50_000);
      expect(r.headers.get("retry-after")).toBeTruthy();
    }
    const usage = await (await fetch(`${GW}/v1/usage`, { headers: { "x-api-key": tenant } })).json();
    expect(usage.used).toBe(50_000);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const agg = db.prepare("SELECT COUNT(*) AS n, SUM(tokens) AS t, SUM(state='reserved') AS reserved FROM usage WHERE tenant = ?").get(tenant) as any;
    db.close();
    expect(agg).toEqual({ n: 10, t: 50_000, reserved: 0 });
  });

  it("reconciliation: when the provider reports small actual usage, finalized rows free the budget", async () => {
    await setModes({ usage: "actual" });
    for (let i = 0; i < 20; i++) {
      // Each call reserves 5,000 (would exhaust the window after 10) but finalizes to ~25 tokens.
      const r = await complete(tenant, { prompt: "burst", max_tokens: 4998, estimated_tokens: 5000 });
      expect(r.status).toBe(200);
      expect(r.json.usage.total_tokens).toBeLessThan(100);
    }
    const usage = await (await fetch(`${GW}/v1/usage`, { headers: { "x-api-key": tenant } })).json();
    expect(usage.used).toBeLessThan(2000);
    expect(usage.used).toBeGreaterThan(0);
  });

  it("11th request of 5,000 in one second is rejected with 429; retry_after_ms ≈ 59 s", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await complete(tenant, { prompt: "hello", max_tokens: 4998 }); // ceil(5/4) + 4998 = 5000
      expect(r.status).toBe(200);
      expect(r.json.usage.total_tokens).toBe(5000);
    }
    const r = await complete(tenant, { prompt: "hello", max_tokens: 4998 });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("RATE_LIMITED");
    expect(r.json.error.retry_after_ms).toBeGreaterThan(55_000);
    expect(r.json.error.retry_after_ms).toBeLessThanOrEqual(60_000);
    expect(r.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(await calls()).toEqual({ primary: 10, secondary: 0 }); // the 11th never reached a provider
  });
});

describe("persistence", () => {
  it("usage survives a router restart (state is the SQLite file, not process memory)", async () => {
    const r = await complete(tenant, { prompt: "persist me", max_tokens: 1000 });
    expect(r.status).toBe(200);
    const before = await (await fetch(`${GW}/v1/usage`, { headers: { "x-api-key": tenant } })).json();
    expect(before.used).toBeGreaterThan(0);

    await gw.stop();
    gw = start("dist/server.js", {
      ROUTER_PORT: String(GW_PORT), DB_PATH: dbPath, PRIMARY_URL: `${MOCK}/primary`, SECONDARY_URL: `${MOCK}/secondary`,
      PRIMARY_TIMEOUT_MS: "3000", TOKEN_LIMIT: "50000", WINDOW_MS: "60000",
    });
    await waitFor(`${GW}/readyz`);

    const after = await (await fetch(`${GW}/v1/usage`, { headers: { "x-api-key": tenant } })).json();
    expect(after.used).toBe(before.used);
    // and the limiter still enforces against the persisted usage
    const over = await complete(tenant, { prompt: "x", max_tokens: 1, estimated_tokens: 50_000 - before.used + 1 });
    expect(over.status).toBe(429);
  });
});

describe("fallback", () => {
  it("primary 429 -> secondary immediately (no 3 s wait), reservation finalized as secondary", async () => {
    await setModes({ primary: "429" });
    const r = await complete(tenant, { prompt: "fallback please", max_tokens: 50 });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("secondary");
    expect(r.json.failed_over).toBe(true);
    expect(r.ms).toBeLessThan(500);
    expect(await calls()).toEqual({ primary: 1, secondary: 1 });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT provider FROM usage WHERE tenant = ?").get(tenant) as any).provider).toBe("secondary");
    db.close();
  });

  it("primary timeout -> secondary in just over 3 s", async () => {
    await setModes({ primary: "timeout" });
    const r = await complete(tenant, { prompt: "slow primary", max_tokens: 50 });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("secondary");
    expect(r.ms).toBeGreaterThan(3000);
    expect(r.ms).toBeLessThan(3600);
    expect(gw.stderr()).toMatch(/"failover".*"reason":"timeout"/);
  });

  it("primary 500 -> secondary", async () => {
    await setModes({ primary: "500" });
    const r = await complete(tenant, { prompt: "boom", max_tokens: 50 });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("secondary");
  });

  it("double failure (500 then 429) -> 503 with the sanitized shape; reservation released", async () => {
    await setModes({ primary: "500", secondary: "429" });
    const r = await complete(tenant, { prompt: "both down", max_tokens: 50 });
    expect(r.status).toBe(503);
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(r.json.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: "Model providers unavailable" });
    expect(r.json.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    // nothing internal leaks
    expect(r.text).not.toMatch(/\bat\s+\w+/); // stack frames
    expect(r.text).not.toMatch(/localhost|127\.0\.0\.1|internal|\.js:\d+/);
    expect(r.text).not.toContain("upstream_secret");
    expect(r.text).not.toContain("mock-provider");
    expect(r.text).not.toContain("Rate limit reached");
    // ...but the operator can find it in stderr under the same request id
    expect(gw.stderr()).toContain(r.json.error.request_id);
    expect(gw.stderr()).toContain("upstream_secret");
    const usage = await (await fetch(`${GW}/v1/usage`, { headers: { "x-api-key": tenant } })).json();
    expect(usage.used).toBe(0);
  });

  it("double timeout -> 503 in just over 6 s, not 30 s", async () => {
    await setModes({ primary: "timeout", secondary: "timeout" });
    const r = await complete(tenant, { prompt: "both slow", max_tokens: 50 });
    expect(r.status).toBe(503);
    expect(r.ms).toBeGreaterThan(6000);
    expect(r.ms).toBeLessThan(7000);
  });
});

describe("input validation and auth (same error shape)", () => {
  it("missing X-API-Key -> 401", async () => {
    const res = await fetch(`${GW}/v1/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });
  it.each([
    ["missing prompt", {}],
    ["empty prompt", { prompt: "" }],
    ["bad max_tokens", { prompt: "x", max_tokens: -5 }],
    ["bad estimated_tokens", { prompt: "x", estimated_tokens: "lots" }],
  ])("%s -> 400 BAD_REQUEST and no provider call", async (_l, body) => {
    await setModes({});
    const r = await complete(tenant, body);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("BAD_REQUEST");
    expect(await calls()).toEqual({ primary: 0, secondary: 0 });
  });
  it("non-JSON body -> 400", async () => {
    const res = await fetch(`${GW}/v1/complete`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": tenant }, body: "{nope" });
    expect(res.status).toBe(400);
  });
  it("unknown route -> 404 in the same shape", async () => {
    const res = await fetch(`${GW}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
