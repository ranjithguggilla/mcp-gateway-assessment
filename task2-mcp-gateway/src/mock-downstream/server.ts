// Mock downstream MCP server over Streamable HTTP. Tools: echo, get_time, admin_reset_key.
// Every tools/call it receives is logged to stderr: that log is the evidence that a blocked
// call never reached it.
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { log } from "../log.js";

const PORT = Number(process.env.DOWNSTREAM_PORT ?? 4000);
let keyVersion = 1;

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: "mock-downstream", version: "1.0.0" });
  mcp.registerTool("echo", { description: "Echo a message back", inputSchema: { message: z.string() } }, async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }));
  mcp.registerTool("get_time", { description: "Current server time", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }));
  mcp.registerTool("admin_reset_key", { description: "ADMIN ONLY: rotate the signing key", inputSchema: {} }, async () => {
    keyVersion += 1;
    return { content: [{ type: "text", text: `key rotated to v${keyVersion}` }] };
  });
  return mcp;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  // If the client's bearer token ever shows up here, the gateway leaked it.
  if (req.headers.authorization) log("error", "downstream.leaked_client_authorization");

  const sessionId = req.headers["mcp-session-id"];
  let body: unknown;
  if (req.method === "POST") {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    for (const m of Array.isArray(body) ? body : [body]) {
      const msg = m as { method?: string; params?: { name?: string } };
      if (msg?.method === "tools/call") log("info", "downstream.tools/call", { tool: msg.params?.name, sessionId });
      else if (msg?.method) log("info", "downstream.request", { method: msg.method, sessionId });
    }
  }

  let transport: StreamableHTTPServerTransport | undefined;
  if (typeof sessionId === "string" && transports.has(sessionId)) {
    transport = transports.get(sessionId);
  } else if (req.method === "POST" && !sessionId && isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        log("info", "downstream.session.created", { sessionId: id });
      },
      onsessionclosed: (id) => {
        transports.delete(id);
      },
    });
    await buildMcp().connect(transport);
  } else {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: no valid session" } }));
    return;
  }
  await transport!.handleRequest(req, res, body);
});

server.listen(PORT, () => log("info", "downstream.listening", { port: PORT }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
