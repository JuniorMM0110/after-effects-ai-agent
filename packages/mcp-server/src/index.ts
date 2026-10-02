#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runInit } from "./cli/init.js";
import { createServer } from "./server.js";
import { logger } from "./util/logger.js";

const USAGE = `@engine-room/after-effects-mcp — drive Adobe After Effects from an AI agent.

With no arguments it runs as an MCP server over stdio, which is how an MCP
client (Claude Code, Claude Desktop, …) starts it. You do not normally run it
by hand.

Commands:
  init <directory> [--no-mcp]   Create a project folder containing the client
                                configuration and a house-style skill you can
                                edit. Pass --no-mcp if your client already
                                provides these tools.
  http [--port <port>]          Serve MCP over Streamable HTTP on 127.0.0.1.
                                Intended for ChatGPT Secure MCP Tunnel.
  --help                        Show this message.
  --version                     Print the version.
`;

async function main() {
  const argv = process.argv.slice(2);

  // CLI modes short-circuit before the stdio transport exists, so writing to
  // stdout here cannot corrupt the JSON-RPC stream.
  if (argv[0] === "init") {
    process.exit(runInit(argv.slice(1)));
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (argv[0] === "http") {
    await runHttp(argv.slice(1));
    return;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown command: ${argv[0]}\n\n${USAGE}`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
}

const VERSION = "0.5.0";

async function runHttp(args: string[]) {
  let port = 8765;
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0) {
    const raw = args[portIndex + 1];
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid --port value: ${raw ?? "(missing)"}`);
    }
    port = parsed;
  }
  const unknown = args.filter((arg, i) => arg !== "--port" && i !== portIndex + 1);
  if (unknown.length) throw new Error(`Unknown http option: ${unknown[0]}`);

  const mcp = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);

  const http = createHttpServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "streamable-http", port }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("HTTP MCP request failed", (error as Error).message);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      if (!res.writableEnded) res.end("MCP request failed");
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  logger.info(`MCP Streamable HTTP listening on http://127.0.0.1:${port}/mcp`);
}

main().catch((e) => {
  logger.error("fatal", (e as Error).message);
  process.exit(1);
});
