import type { Role } from "./policy.js";

const ROLES: ReadonlySet<string> = new Set(["admin", "viewer"]);

// Static token map for the local demo (STATIC_TOKENS="tok_admin:admin,tok_viewer:viewer").
// A production gateway would verify a signed JWT here; the contract stays the same: a role or null.
export function tokensFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, Role> {
  const map = new Map<string, Role>();
  for (const pair of (env.STATIC_TOKENS ?? "tok_admin:admin,tok_viewer:viewer").split(",")) {
    const [tok, role] = pair.split(":").map((s) => s.trim());
    if (tok && role && ROLES.has(role)) map.set(tok, role as Role);
  }
  return map;
}

// Anything that is not exactly "Bearer <non-empty token>" is rejected.
export function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

// null on ANY doubt. There is no default role; the caller answers 401.
export function resolveRole(token: string | null, tokens: Map<string, Role>): Role | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}
