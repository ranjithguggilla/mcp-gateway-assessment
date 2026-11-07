export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}
