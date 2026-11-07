/**
 * Thin HTTP wrapper around the router.
 *   POST /v1/complete   headers: X-API-Key: <tenant key>   body: {prompt, max_tokens?, estimated_tokens?}
 *   GET  /healthz /readyz /v1/usage (X-API-Key)
 * Every response carries X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { GatewayError } from "./errors.js";
import { TokenLimiter, estimateTokens } from "./limiter.js";
import { HttpProvider } from "./providers.js";
import { route } from "./router.js";
import { log, tenantTag } from "./log.js";

const PORT = Number(process.env.ROUTER_PORT ?? 3002);
const DB_PATH = process.env.DB_PATH ?? "./data/gateway.db";
const LIMIT = Number(process.env.TOKEN_LIMIT ?? 50_000);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 60_000);
const PRIMARY_TIMEOUT_MS = Number(process.env.PRIMARY_TIMEOUT_MS ?? 3000);
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 256);

const db = openDb(DB_PATH);
const limiter = new TokenLimiter(db, { limit: LIMIT, windowMs: WINDOW_MS });
limiter.startSweeper();

const routerOpts = {
  limiter,
  primary: new HttpProvider("primary", process.env.PRIMARY_URL ?? "http://localhost:4002/primary", process.env.PRIMARY_API_KEY),
  secondary: new HttpProvider("secondary", process.env.SECONDARY_URL ?? "http://localhost:4002/secondary", process.env.SECONDARY_API_KEY),
  primaryTimeoutMs: PRIMARY_TIMEOUT_MS,
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new GatewayError("BAD_REQUEST", "Body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError("BAD_REQUEST", "Body must be valid JSON");
  }
}

function tenantOf(req: IncomingMessage): string {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || !key.trim()) throw new GatewayError("UNAUTHORIZED", "X-API-Key header required");
  return key.trim();
}

const server = createServer(async (req, res) => {
  const requestId = (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]) || randomUUID();
  const base: Record<string, string> = { "x-request-id": requestId, "x-ratelimit-limit": String(LIMIT) };
  const url = new URL(req.url ?? "/", "http://localhost");
  const t0 = performance.now();

  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true, service: "model-router" }, base);
    if (url.pathname === "/readyz") {
      db.prepare("SELECT 1").get(); // sqlite opens and answers
      return send(res, 200, { ok: true, db: DB_PATH }, base);
    }
    if (url.pathname === "/v1/usage" && req.method === "GET") {
      const tenant = tenantOf(req);
      const used = limiter.used(tenant);
      return send(res, 200, { tenant, used, limit: LIMIT, remaining: Math.max(0, LIMIT - used), window_ms: WINDOW_MS }, { ...base, "x-ratelimit-remaining": String(Math.max(0, LIMIT - used)) });
    }
    if (url.pathname !== "/v1/complete" || req.method !== "POST") throw new GatewayError("NOT_FOUND", "Not found");

    const tenant = tenantOf(req);
    const body = (await readJson(req)) as { prompt?: unknown; max_tokens?: unknown; estimated_tokens?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.length) throw new GatewayError("BAD_REQUEST", "prompt (non-empty string) is required");
    const max_tokens = body.max_tokens === undefined ? DEFAULT_MAX_TOKENS : Number(body.max_tokens);
    if (!Number.isInteger(max_tokens) || max_tokens <= 0 || max_tokens > 100_000) throw new GatewayError("BAD_REQUEST", "max_tokens must be an integer in 1..100000");
    let estimate: number | undefined;
    if (body.estimated_tokens !== undefined) {
      estimate = Number(body.estimated_tokens);
      if (!Number.isInteger(estimate) || estimate <= 0) throw new GatewayError("BAD_REQUEST", "estimated_tokens must be a positive integer");
    }

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });

    const r = await route(routerOpts, tenant, { prompt: body.prompt, max_tokens }, requestId, ac.signal, estimate);
    log("info", "request.ok", { requestId, tenant: tenantTag(tenant), provider: r.provider, failedOver: r.failed_over, tokens: r.usage.total_tokens, estimate: estimate ?? estimateTokens(body.prompt, max_tokens), ms: +(performance.now() - t0).toFixed(1) });
    return send(res, 200, { text: r.text, provider: r.provider, failed_over: r.failed_over, usage: r.usage, request_id: requestId }, { ...base, "x-ratelimit-remaining": String(r.rate_limit.remaining) });
  } catch (err) {
    const ge = err instanceof GatewayError ? err : new GatewayError("INTERNAL", "Internal error", { cause: err });
    // Private: everything. Public: the fixed shape only.
    log(ge.status >= 500 ? "error" : "warn", "request.failed", {
      requestId,
      code: ge.code,
      status: ge.status,
      ms: +(performance.now() - t0).toFixed(1),
      cause: ge.opts.cause instanceof Error ? { name: ge.opts.cause.name, message: ge.opts.cause.message, stack: ge.opts.cause.stack } : ge.opts.cause ? String(ge.opts.cause) : undefined,
    });
    const headers = { ...base };
    if (ge.opts.retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(ge.opts.retryAfterMs / 1000));
    if (ge.opts.details?.remaining !== undefined) headers["x-ratelimit-remaining"] = String(ge.opts.details.remaining);
    return send(res, ge.status, ge.toBody(requestId), headers);
  }
});

server.listen(PORT, () => log("info", "router.listening", { port: PORT, db: DB_PATH, limit: LIMIT, windowMs: WINDOW_MS, primaryTimeoutMs: PRIMARY_TIMEOUT_MS }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    limiter.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500).unref();
  });
}
