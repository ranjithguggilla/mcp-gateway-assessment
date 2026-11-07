/**
 * LLM gateway with a streaming PII guardrail.
 *
 *   POST /v1/generate  {"prompt": "...", "max_tokens"?: n}
 *     Accept: text/event-stream (default)  -> data: {"delta":"..."} frames, then data: [DONE]
 *     Accept: text/plain                   -> raw redacted text (handy with curl -N)
 *
 * Pipeline (all streaming, no whole-response accumulation):
 *   provider bytes -> TextDecoder -> SseParser (framing) -> extractDelta
 *     -> Redactor (PII, bounded hold-back) -> re-frame -> client, with backpressure.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";
import { Redactor, DEFAULT_MAX_HOLD } from "./redactor.js";
import { SseParser, extractDelta } from "./sse.js";

const PORT = Number(process.env.GUARDRAIL_PORT ?? 3001);
const PROVIDER_URL = process.env.PROVIDER_URL ?? "http://localhost:4001/v1/stream";
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY; // never required for the mock
const MAX_HOLD = Number(process.env.MAX_HOLD ?? DEFAULT_MAX_HOLD);

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function write(res: ServerResponse, data: string): Promise<void> {
  // Respect backpressure: if the client is slow, wait for drain instead of buffering.
  if (res.write(data)) return Promise.resolve();
  return new Promise((r) => res.once("drain", () => r()));
}

async function handleGenerate(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const tStart = performance.now();
  let body: { prompt?: unknown; max_tokens?: unknown; provider?: Record<string, unknown> };
  try {
    body = (await readJson(req)) as typeof body;
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid JSON body", request_id: requestId } }));
    return;
  }
  if (typeof body.prompt !== "string" || !body.prompt.length) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "prompt (string) is required", request_id: requestId } }));
    return;
  }

  const plain = (req.headers.accept ?? "").includes("text/plain");
  const ac = new AbortController();
  // Client went away mid-stream: abort the provider request so we stop paying for tokens.
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(PROVIDER_API_KEY ? { authorization: `Bearer ${PROVIDER_API_KEY}` } : {}) },
      body: JSON.stringify({ prompt: body.prompt, max_tokens: body.max_tokens, stream: true, ...(body.provider ?? {}) }),
      signal: ac.signal,
    });
  } catch (err) {
    log("error", "provider.unreachable", { requestId, error: err instanceof Error ? err.message : String(err) });
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "LLM provider unreachable", request_id: requestId } }));
    return;
  }
  if (!upstream.ok || !upstream.body) {
    log("error", "provider.error", { requestId, status: upstream.status });
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "UPSTREAM_ERROR", message: "LLM provider returned an error", request_id: requestId } }));
    return;
  }

  res.writeHead(200, {
    "content-type": plain ? "text/plain; charset=utf-8" : "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell Nginx not to buffer
    "x-request-id": requestId,
  });
  res.flushHeaders();

  const parser = new SseParser();
  const redactor = new Redactor(MAX_HOLD);
  let providerFirstByteMs: number | null = null;
  let clientFirstTokenMs: number | null = null;
  let bytesIn = 0;
  let charsOut = 0;
  let peakPending = 0;

  const emit = async (text: string) => {
    if (!text) return;
    if (clientFirstTokenMs === null) clientFirstTokenMs = performance.now() - tStart;
    charsOut += text.length;
    await write(res, plain ? text : `data: ${JSON.stringify({ delta: text })}\n\n`);
  };

  try {
    const decoder = new TextDecoder();
    // Node's ReadableStream is async-iterable at runtime; the DOM lib typings lag behind.
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (providerFirstByteMs === null) providerFirstByteMs = performance.now() - tStart;
      bytesIn += chunk.byteLength;
      for (const payload of parser.push(decoder.decode(chunk, { stream: true }))) {
        const { text, done } = extractDelta(payload);
        if (done) break;
        await emit(redactor.push(text));
      }
      peakPending = Math.max(peakPending, parser.pending + redactor.held);
    }
    for (const payload of parser.flush()) await emit(redactor.push(extractDelta(payload).text));
    await emit(redactor.flush());
    if (!plain) await write(res, "data: [DONE]\n\n");
  } catch (err) {
    if (!ac.signal.aborted) log("error", "stream.error", { requestId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
    log("info", "request.complete", {
      requestId,
      aborted: ac.signal.aborted,
      ttft_ms: clientFirstTokenMs === null ? null : +clientFirstTokenMs.toFixed(1),
      provider_ttfb_ms: providerFirstByteMs === null ? null : +providerFirstByteMs.toFixed(1),
      total_ms: +(performance.now() - tStart).toFixed(1),
      bytes_in: bytesIn,
      chars_out: charsOut,
      peak_buffer_chars: peakPending,
      peak_hold_chars: redactor.peakHold,
      redacted: redactor.stats,
      heap_used_mb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    });
  }
}

const server = createServer(async (req, res) => {
  const requestId = (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]) || randomUUID();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, service: "stream-guardrail" }));
  if (url.pathname === "/readyz") {
    try {
      const r = await fetch(new URL("/healthz", PROVIDER_URL), { signal: AbortSignal.timeout(2000) });
      return void res.writeHead(r.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: r.ok, provider: r.status }));
    } catch {
      return void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, provider: "unreachable" }));
    }
  }
  if (url.pathname === "/metrics") {
    const m = process.memoryUsage();
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rss_mb: +(m.rss / 1048576).toFixed(1), heap_used_mb: +(m.heapUsed / 1048576).toFixed(1) }));
  }
  if (req.method === "POST" && url.pathname === "/v1/generate") return handleGenerate(req, res, requestId);
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found", request_id: requestId } }));
});

server.listen(PORT, () => log("info", "guardrail.listening", { port: PORT, provider: PROVIDER_URL, maxHold: MAX_HOLD }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
