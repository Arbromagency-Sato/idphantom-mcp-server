#!/usr/bin/env node
import { createMcpHandler, type JsonRpcRequest } from "./server";
import { resolveCliConfig } from "./config";

const argv = process.argv.slice(2);
if (argv[0] === "init") {
  import("./init").then(({ runInit }) => runInit({ argv: argv.slice(1) })).catch((err) => {
    process.stderr.write(`phantom-mcp-server init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
} else {
  const config = resolveCliConfig(argv);
  const handle = createMcpHandler({ apiBaseUrl: config.apiUrl, apiKey: config.apiKey });

  let buffer = "";

  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    void drain();
  });

  process.stdin.on("error", (err) => {
    process.stderr.write(`stdin error: ${err.message}\n`);
  });

  async function drain(): Promise<void> {
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
      buffer = buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      try {
        const response = await handle(JSON.parse(line) as JsonRpcRequest);
        if (response) writeMessage(JSON.stringify(response));
      } catch (e) {
        const parseError = e instanceof SyntaxError;
        writeMessage(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: parseError ? -32700 : -32603,
            message: parseError ? "Parse error" : e instanceof Error ? e.message : String(e),
          },
        }));
      }
    }
  }

  function writeMessage(body: string): void {
    process.stdout.write(`${body}\n`);
  }
}
