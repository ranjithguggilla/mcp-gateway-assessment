/**
 * Integration: spawns the REAL mock provider and the REAL gateway and reads
 * the stream over HTTP, measuring that the first token arrives well before
 * the stream ends and that nothing sensitive gets through.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 14001;
const GW_PORT = 13001;
const GW = `http://localhost:${GW_PORT}`;

interface Proc { child: ChildProcess; stderr: () => string; stop: () => Promise<void> }
function start(script: string, env: Record<string, string>, nodeArgs: string[] = []): Proc {
  const child = spawn(process.execPath, [...nodeArgs, resolve(root, script)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

/** The gateway writes request.complete just after res.end(); give it a beat before reading logs. */
async function lastComplete(p: Proc): Promise<any> {
  await new Promise((r) => setTimeout(r, 150));
  return JSON.parse(p.stderr().split("\n").filter((l) => l.includes("request.complete")).pop()!);
}

/** Read an SSE stream from the gateway, recording when the first delta arrived. */
async function readStream(body: Record<string, unknown>, accept = "text/event-stream") {
  const t0 = performance.now();
  const res = await fetch(`${GW}/v1/generate`, { method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let raw = "";
  let firstChunkMs: number | null = null;
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks++;
    if (firstChunkMs === null) firstChunkMs = performance.now() - t0;
    raw += dec.decode(value, { stream: true });
  }
  const totalMs = performance.now() - t0;
  let text = raw;
  if (accept === "text/event-stream") {
    text = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d).delta).join("");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  }
  return { res, raw, text, firstChunkMs: firstChunkMs!, totalMs, chunks };
}

let mock: Proc;
let gw: Proc;
beforeAll(async () => {
  if (!existsSync(resolve(root, "dist/server.js"))) execSync("npm run build", { cwd: root, stdio: "inherit" });
  mock = start("dist/mock-llm/server.js", { MOCK_LLM_PORT: String(MOCK_PORT), MOCK_LLM_DELAY_MS: "10" });
  gw = start("dist/server.js", { GUARDRAIL_PORT: String(GW_PORT), PROVIDER_URL: `http://localhost:${MOCK_PORT}/v1/stream` });
  await waitFor(`http://localhost:${MOCK_PORT}/healthz`);
  await waitFor(`${GW}/readyz`);
});
afterAll(async () => { await Promise.all([gw?.stop(), mock?.stop()]); });

describe("streaming guardrail end-to-end", () => {
  it("redacts all PII from the canned paragraph streamed in 4-char chunks", async () => {
    const { text } = await readStream({ prompt: "customer summary" });
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("123-45-6789");
    expect(text).not.toContain("4111");
    expect(text).not.toContain("5500");
    expect(text).toContain("1234 5678 9012 3456"); // non-Luhn order number stays
    expect((text.match(/\[REDACTED\]/g) ?? []).length).toBe(6);
    expect(text).toContain("Have a great day!"); // flush() released the ending
  });

  it("redacts with 1-char provider chunks (every PII pattern split many times)", async () => {
    const { text } = await readStream({ prompt: "x", provider: { chunk: 1, delay_ms: 0 } });
    expect(text).not.toMatch(/@/);
    expect((text.match(/\[REDACTED\]/g) ?? []).length).toBe(6);
  });

  it("first token reaches the client long before the stream ends; TTFT is logged", async () => {
    const r = await readStream({ prompt: "x", provider: { delay_ms: 15 } }); // ~95 chunks * 15ms ≈ 1.4s total
    expect(r.chunks).toBeGreaterThan(5);
    expect(r.firstChunkMs).toBeLessThan(r.totalMs / 3);
    expect(r.firstChunkMs).toBeLessThan(500);
    const j = await lastComplete(gw);
    expect(typeof j.ttft_ms).toBe("number");
    expect(j.ttft_ms).toBeLessThan(j.total_ms);
    expect(j.redacted.emails).toBe(3);
  });

  it("Accept: text/plain streams raw redacted text (curl -N friendly)", async () => {
    const { res, text } = await readStream({ prompt: "x", provider: { delay_ms: 0 } }, "text/plain");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(text).toContain("[REDACTED]");
  });

  it("peak buffer stays bounded on a ~200 KB response (memory is O(hold-back), not O(response))", async () => {
    const { text } = await readStream({ prompt: "x", provider: { delay_ms: 0, chunk: 64, repeat: 500 } });
    expect(text.length).toBeGreaterThan(150_000);
    expect(text).not.toMatch(/@/);
    const j = await lastComplete(gw);
    expect(j.chars_out).toBe(text.length);
    expect(j.peak_hold_chars).toBeLessThanOrEqual(254);
    expect(j.peak_buffer_chars).toBeLessThan(2048); // hold-back + one partial SSE frame
  });

  it("rejects a missing prompt with a sanitized 400", async () => {
    const r = await fetch(`${GW}/v1/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("BAD_REQUEST");
    expect(typeof j.error.request_id).toBe("string");
  });

  it("aborting the client aborts the provider stream", async () => {
    const ac = new AbortController();
    const p = fetch(`${GW}/v1/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", provider: { delay_ms: 50, repeat: 50 } }), signal: ac.signal });
    const res = await p;
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.stderr()).toMatch(/"mock-llm.stream.end".*"aborted":true/);
  });
});

describe("heap-constrained gateway", () => {
  const PORT = 13002;
  let small: Proc;
  beforeAll(async () => {
    small = start("dist/server.js", { GUARDRAIL_PORT: String(PORT), PROVIDER_URL: `http://localhost:${MOCK_PORT}/v1/stream` }, ["--max-old-space-size=48"]);
    await waitFor(`http://localhost:${PORT}/readyz`);
  });
  afterAll(async () => small.stop());

  it("streams a ~4 MB response under --max-old-space-size=48 without crashing", async () => {
    const res = await fetch(`http://localhost:${PORT}/v1/generate`, { method: "POST", headers: { "content-type": "application/json", accept: "text/plain" }, body: JSON.stringify({ prompt: "x", provider: { delay_ms: 0, chunk: 256, repeat: 10_000 } }) });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; }
    expect(bytes).toBeGreaterThan(3_000_000);
    expect(small.child.exitCode).toBeNull();
    const j = await lastComplete(small);
    expect(j.heap_used_mb).toBeLessThan(48);
    expect(j.peak_hold_chars).toBeLessThanOrEqual(254);
  });
});
