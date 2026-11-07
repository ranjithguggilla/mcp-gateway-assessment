// Pure authorization policy. No I/O, so it can be unit-tested without any server.
export type Role = "admin" | "viewer";

const PROTECTED_PREFIXES: ReadonlyArray<{ prefix: string; required: Role }> = [{ prefix: "admin_", required: "admin" }];

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; id: unknown; tool: string; required: Role }
  | { kind: "invalid"; id: unknown; reason: string };

function requestId(id: unknown): unknown {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function decide(role: Role, msg: unknown): Decision {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { kind: "invalid", id: null, reason: "message must be a JSON object" };
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = requestId(m.id);
  if (m.jsonrpc !== "2.0") return { kind: "invalid", id, reason: 'jsonrpc must be "2.0"' };
  if (typeof m.method !== "string") return { kind: "invalid", id, reason: "method must be a string" };
  if (m.method !== "tools/call") return { kind: "allow" }; // tools/list, initialize, notifications: forwarded unchanged

  const name = typeof m.params === "object" && m.params !== null ? (m.params as { name?: unknown }).name : undefined;
  if (typeof name !== "string") return { kind: "invalid", id, reason: "tools/call requires params.name (string)" };
  for (const rule of PROTECTED_PREFIXES) {
    if (name.trim().toLowerCase().startsWith(rule.prefix) && role !== rule.required) return { kind: "deny", id, tool: name, required: rule.required };
  }
  return { kind: "allow" };
}

export function unauthorizedError(id: unknown, tool: string, role: Role | null, required: Role) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code: -32001, message: "Unauthorized Tool Call", data: { tool, role, required } } };
}

export function invalidRequestError(id: unknown, reason: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code: -32600, message: "Invalid Request", data: { reason } } };
}
