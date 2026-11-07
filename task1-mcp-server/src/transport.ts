import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./log.js";

/**
 * Newline-delimited JSON-RPC over stdio, with the framing errors the SDK's own stdio transport
 * swallows turned into spec-conformant replies:
 *   - not JSON                      -> -32700 Parse error        (id null)
 *   - JSON but not a JSON-RPC 2.0 message, or a batch array -> -32600 Invalid Request
 *   - tools/call whose params are structurally wrong        -> -32602 Invalid params
 *     (the SDK would reject these inside its own schema and answer -32603 with a zod dump)
 * Blank lines are ignored. A line longer than MAX_LINE is dropped, so one hostile client cannot
 * make the process buffer without bound. stdout carries only JSON-RPC frames written here.
 */
const MAX_LINE = 1_000_000;

type Id = string | number | null;

function idOf(v: unknown): Id {
  const id = typeof v === "object" && v !== null ? (v as { id?: unknown }).id : undefined;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** Structural check the SDK would otherwise fail with -32603. Returns a reason, or null if fine. */
export function toolsCallShapeProblem(msg: { method?: string; params?: unknown }): string | null {
  if (msg.method !== "tools/call") return null;
  const p = msg.params;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "params must be an object";
  const { name, arguments: args } = p as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || name.length === 0) return "params.name must be a non-empty string";
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return "params.arguments must be an object";
  return null;
}

export class LineStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buf = "";
  private discarding = false;
  private closed = false;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
  ) {}

  async start(): Promise<void> {
    this.stdin.setEncoding?.("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
    this.stdin.on("error", (e: Error) => this.onerror?.(e));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.write(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.pause?.();
    this.onclose?.();
  }

  private write(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  private reply(id: Id, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  private onData(text: string): void {
    this.buf += text;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.discarding) {
        this.discarding = false; // the oversized line ended here
        continue;
      }
      this.handleLine(line);
    }
    if (this.buf.length > MAX_LINE) {
      this.buf = "";
      this.discarding = true;
      log("warn", "stdin.line_too_large", { limit: MAX_LINE });
      this.reply(null, ErrorCode.InvalidRequest, "Invalid Request", { reason: "line too large" });
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      log("warn", "stdin.parse_error", { preview: line.slice(0, 80) });
      return this.reply(null, ErrorCode.ParseError, "Parse error");
    }
    if (Array.isArray(value)) return this.reply(null, ErrorCode.InvalidRequest, "Invalid Request", { reason: "batches are not supported" });
    const parsed = JSONRPCMessageSchema.safeParse(value);
    if (!parsed.success) {
      log("warn", "stdin.invalid_request", { preview: line.slice(0, 80) });
      return this.reply(idOf(value), ErrorCode.InvalidRequest, "Invalid Request", { reason: "not a JSON-RPC 2.0 message" });
    }
    const msg = parsed.data as JSONRPCMessage & { method?: string; params?: unknown; id?: Id };
    if ("method" in msg && "id" in msg) {
      const problem = toolsCallShapeProblem(msg);
      if (problem) return this.reply(msg.id as Id, ErrorCode.InvalidParams, "Invalid params", { reason: problem });
    }
    this.onmessage?.(parsed.data);
  }
}
