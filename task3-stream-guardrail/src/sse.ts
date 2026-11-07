/**
 * Minimal SSE event parser that tolerates events split across TCP reads.
 * Two buffers, two jobs: this one handles framing; the Redactor handles PII.
 */
export class SseParser {
  private buf = "";

  /** Feed raw text; returns the complete `data:` payloads found so far. */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let idx: number;
    // Events are separated by a blank line. Accept \n\n and \r\n\r\n.
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length) out.push(data);
    }
    return out;
  }

  /** Unterminated trailing event at stream end. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    if (!rest.trim()) return [];
    const data = rest
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    return data.length ? [data] : [];
  }

  get pending(): number {
    return this.buf.length;
  }
}

/** Extract the text delta from an OpenAI- or Anthropic-style stream payload. */
export function extractDelta(payload: string): { text: string; done: boolean } {
  if (payload === "[DONE]") return { text: "", done: true };
  try {
    const j = JSON.parse(payload);
    // OpenAI chat.completions chunk
    const oa = j?.choices?.[0]?.delta?.content;
    if (typeof oa === "string") return { text: oa, done: false };
    // Anthropic messages stream
    if (j?.type === "content_block_delta" && typeof j?.delta?.text === "string") return { text: j.delta.text, done: false };
    if (j?.type === "message_stop") return { text: "", done: true };
    // Our own simple shape
    if (typeof j?.delta === "string") return { text: j.delta, done: false };
    return { text: "", done: false };
  } catch {
    return { text: "", done: false };
  }
}
