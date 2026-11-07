import { GatewayError } from "./errors.js";
import { estimateTokens, type TokenLimiter } from "./limiter.js";
import { ProviderError, isAbort, type CompletionRequest, type CompletionResult, type Provider } from "./providers.js";
import { log } from "./log.js";

export interface RouterOptions {
  limiter: TokenLimiter;
  primary: Provider;
  secondary: Provider;
  primaryTimeoutMs: number; // 3000 per the brief
  secondaryTimeoutMs?: number;
}

export interface RouteResult extends CompletionResult {
  provider: string;
  failed_over: boolean;
  rate_limit: { limit: number; remaining: number };
}

/**
 * route():
 *   1. estimate tokens, reserve atomically (429 + retry_after_ms if the window is full)
 *   2. primary with a hard 3000 ms deadline (AbortSignal.timeout: the socket really closes)
 *   3. on 429 / timeout / 5xx  -> secondary (once). on 400 -> no fallback, the request is wrong.
 *   4. success -> finalize reservation with actual usage. any failure -> release it.
 *   5. both failed -> 503 UPSTREAM_UNAVAILABLE. Details go to stderr only.
 */
export async function route(
  opts: RouterOptions,
  tenant: string,
  req: CompletionRequest,
  requestId: string,
  clientSignal?: AbortSignal,
  estimateOverride?: number,
): Promise<RouteResult> {
  const estimate = estimateOverride ?? estimateTokens(req.prompt, req.max_tokens);
  const reservation = opts.limiter.tryReserve(tenant, estimate, requestId);
  if (!reservation.ok) {
    log("warn", "rate_limited", { requestId, tenant, estimate, used: reservation.used, retryAfterMs: reservation.retryAfterMs });
    throw new GatewayError("RATE_LIMITED", "Token budget exhausted for this window", {
      retryAfterMs: reservation.retryAfterMs,
      details: { limit: opts.limiter.opts.limit, remaining: reservation.remaining },
    });
  }
  const { reservationId } = reservation;

  const attempt = async (p: Provider, timeoutMs: number): Promise<CompletionResult> => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (clientSignal) signals.push(clientSignal);
    const t0 = performance.now();
    try {
      const r = await p.complete(req, AbortSignal.any(signals));
      log("info", "provider.ok", { requestId, provider: p.name, ms: +(performance.now() - t0).toFixed(1), tokens: r.usage.total_tokens });
      return r;
    } catch (err) {
      const ms = +(performance.now() - t0).toFixed(1);
      if (err instanceof ProviderError) {
        // Private detail (status, upstream body, cause) stays in the log.
        log("warn", "provider.failed", { requestId, provider: p.name, kind: err.kind, status: err.status, ms, cause: String(err.cause ?? "").slice(0, 300) });
      } else {
        log("error", "provider.threw", { requestId, provider: p.name, ms, error: err instanceof Error ? err.stack : String(err) });
      }
      throw err;
    }
  };

  const finish = (r: CompletionResult, provider: Provider, failedOver: boolean): RouteResult => {
    opts.limiter.finalize(reservationId, r.usage.total_tokens, provider.name);
    const used = opts.limiter.used(tenant);
    return { ...r, provider: provider.name, failed_over: failedOver, rate_limit: { limit: opts.limiter.opts.limit, remaining: Math.max(0, opts.limiter.opts.limit - used) } };
  };

  try {
    try {
      return finish(await attempt(opts.primary, opts.primaryTimeoutMs), opts.primary, false);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "bad_request") {
        throw new GatewayError("BAD_REQUEST", "Request rejected by model provider", { cause: err });
      }
      // rate_limited | timeout | upstream -> fail over exactly once
      log("info", "failover", { requestId, from: opts.primary.name, to: opts.secondary.name, reason: err.kind });
      try {
        return finish(await attempt(opts.secondary, opts.secondaryTimeoutMs ?? opts.primaryTimeoutMs), opts.secondary, true);
      } catch (err2) {
        if (isAbort(err2)) throw err2;
        if (err2 instanceof ProviderError && err2.kind === "bad_request") {
          throw new GatewayError("BAD_REQUEST", "Request rejected by model provider", { cause: err2 });
        }
        throw new GatewayError("UPSTREAM_UNAVAILABLE", "Model providers unavailable", {
          cause: err2,
          retryAfterMs: err2 instanceof ProviderError && err2.kind === "rate_limited" ? 1000 : undefined,
        });
      }
    }
  } catch (err) {
    opts.limiter.release(reservationId); // failed calls do not burn quota
    if (err instanceof GatewayError) throw err;
    if (isAbort(err)) throw new GatewayError("BAD_REQUEST", "Client disconnected", { cause: err });
    throw new GatewayError("INTERNAL", "Internal error", { cause: err });
  }
}
