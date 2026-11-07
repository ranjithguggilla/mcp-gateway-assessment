export interface CompletionRequest {
  prompt: string;
  max_tokens: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
}

export type ProviderErrorKind = "rate_limited" | "timeout" | "bad_request" | "upstream";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
}

/**
 * HTTP provider. The caller owns the AbortSignal (timeout + client disconnect),
 * so the socket is really closed on timeout — no leaked fetch behind a Promise.race.
 */
export class HttpProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly apiKey?: string,
  ) {}

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError("timeout", this.name, "provider timed out", undefined, err);
      if (isAbort(err)) throw err; // client disconnect: propagate as-is, not a provider fault
      throw new ProviderError("upstream", this.name, "provider unreachable", undefined, err);
    }
    if (res.status === 429) throw new ProviderError("rate_limited", this.name, "provider rate limited", 429, await safeText(res));
    if (res.status === 400 || res.status === 422) throw new ProviderError("bad_request", this.name, "provider rejected request", res.status, await safeText(res));
    if (!res.ok) throw new ProviderError("upstream", this.name, `provider error ${res.status}`, res.status, await safeText(res));

    let body: { text?: unknown; usage?: Partial<Usage> };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new ProviderError("upstream", this.name, "provider returned invalid JSON", res.status, err);
    }
    if (typeof body.text !== "string") throw new ProviderError("upstream", this.name, "provider response missing text", res.status);
    const u = body.usage ?? {};
    const prompt_tokens = num(u.prompt_tokens, Math.ceil(req.prompt.length / 4));
    const completion_tokens = num(u.completion_tokens, Math.ceil(body.text.length / 4));
    return { text: body.text, usage: { prompt_tokens, completion_tokens, total_tokens: num(u.total_tokens, prompt_tokens + completion_tokens) } };
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}
export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
