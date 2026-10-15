/**
 * AGP-012 (AEGIS) - guardas invertidas sobre el transporte stdio real del MCP server.
 * Lanza src/index.ts como proceso hijo (tsx) y habla por stdin/stdout.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const INDEX = resolve(__dirname, "../dist/src/index.js");
// Resolución robusta del tsc: layout monorepo (apps/mcp-server/test -> raíz del
// repo, 3 niveles) y layout repo espejo standalone (test/ -> raíz, 1 nivel).
import { existsSync } from "node:fs";
const TSC_CANDIDATES = [
  resolve(__dirname, "../../../node_modules/typescript/bin/tsc"),
  resolve(__dirname, "../node_modules/typescript/bin/tsc"),
];
const TSC = TSC_CANDIDATES.find((p) => existsSync(p)) ?? TSC_CANDIDATES[0];
let built = false;

function ensureBuilt() {
  if (built) return;
  execFileSync(process.execPath, [TSC, "-p", resolve(__dirname, "../tsconfig.json")], { stdio: "pipe" });
  built = true;
}

function startServer() {
  ensureBuilt();
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, PHANTOM_API_BASE_URL: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, out: () => stdout, err: () => stderr, exited };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
});
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

function parseFirstLine(out: string) {
  const line = out.split(/\r?\n/).find(Boolean);
  expect(line).toBeTruthy();
  return JSON.parse(line ?? "{}");
}

describe("AEGIS R-6 - framing stdio compatible con la especificacion MCP", () => {
  it("un mensaje JSON delimitado por salto de linea recibe una respuesta JSON-RPC sin Content-Length", async () => {
    const s = startServer();
    try {
      await wait(3_000);
      s.child.stdin.write(INIT + "\n");
      await wait(1_500);
      expect(s.out()).not.toContain("Content-Length:");
      const response = parseFirstLine(s.out());
      expect(response.result.serverInfo.name).toBe("phantom-mcp-server");
    } finally {
      s.child.kill();
    }
  }, 30_000);

  it("tools/list tambien responde con NDJSON estandar", async () => {
    const s = startServer();
    try {
      await wait(3_000);
      s.child.stdin.write(LIST + "\n");
      await wait(1_500);
      expect(s.out()).not.toContain("Content-Length:");
      const response = parseFirstLine(s.out());
      expect(response.result.tools.map((t: { name: string }) => t.name)).toContain("quote_payment");
    } finally {
      s.child.kill();
    }
  }, 30_000);
});

describe("AEGIS R-7 - entrada malformada no tumba el proceso", () => {
  it("un mensaje no JSON devuelve -32700 y el servidor sigue vivo para el siguiente request", async () => {
    const s = startServer();
    try {
      await wait(3_000);
      s.child.stdin.write("X-Foo: bar\r\n\r\n{}\n");
      await wait(500);
      const first = parseFirstLine(s.out());
      expect(first.error.code).toBe(-32700);

      s.child.stdin.write(INIT + "\n");
      await wait(1_500);
      const lines = s.out().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(lines.some((line) => line.result?.serverInfo?.name === "phantom-mcp-server")).toBe(true);
      const code = await Promise.race([s.exited, wait(500).then(() => "alive" as const)]);
      expect(code).toBe("alive");
      expect(s.err()).not.toContain("Missing Content-Length header");
    } finally {
      s.child.kill();
    }
  }, 30_000);

  it("puede procesar otro request valido tras un parse error", async () => {
    const s = startServer();
    try {
      await wait(3_000);
      s.child.stdin.write("{bad json}\n");
      s.child.stdin.write(LIST + "\n");
      await wait(1_500);
      const lines = s.out().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(lines[0].error.code).toBe(-32700);
      expect(lines[1].result.tools.length).toBeGreaterThanOrEqual(4);
    } finally {
      s.child.kill();
    }
  }, 30_000);
});
