// stdout belongs to the JSON-RPC transport; every diagnostic line goes to stderr as JSON.
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

// A stray console.log anywhere (ours or a dependency's) would corrupt the stream, so route all of it to stderr.
export function hardenConsole(): void {
  const to = (level: "info" | "warn" | "error") => (...args: unknown[]) =>
    log(level, args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "), { via: "console" });
  console.log = to("info");
  console.info = to("info");
  console.debug = to("info");
  console.warn = to("warn");
  console.error = to("error");
}
