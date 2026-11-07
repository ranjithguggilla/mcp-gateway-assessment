export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

/** Tenant ids are API keys. Logs get a short one-way fingerprint so entries can be correlated without leaking the secret. */
import { createHash } from "node:crypto";
export function tenantTag(tenant: string): string {
  return "t_" + createHash("sha256").update(tenant).digest("hex").slice(0, 12);
}
