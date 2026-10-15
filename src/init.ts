import { Wallet } from "ethers";
import { parseFlags, resolveCliConfig } from "./config";
import { runRegisterFlow, type RegisterFlowResult } from "./register";

export type InitResult = RegisterFlowResult;

interface InitOptions {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Parameters<typeof runRegisterFlow>[0]["fetchImpl"];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  sleep?: (ms: number) => Promise<void>;
}

/** Comando CLI `phantom-mcp-server init` (AGP-021). Wrapper delgado sobre
 *  runRegisterFlow (AGP-100 F1.1): toda la orquestación vive en register.ts
 *  y la comparte con la tool MCP phantom_register. Los mensajes de progreso
 *  y el formato del resultado se preservan tal cual. */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const env = options.env ?? process.env;
  const flags = parseFlags(options.argv);
  const config = resolveCliConfig(options.argv, env);
  const stdout = options.stdout ?? process.stdout;

  if (flags.help || flags.h) {
    stdout.write(initUsage());
    return { reference: "", status: "help" };
  }

  const name = readStringFlag(flags, "name", env.PHANTOM_AGENT_NAME ?? "phantom-agent");
  const routerAddress = readStringFlag(flags, "router-address", env.PHANTOM_ROUTER_ADDRESS);
  // AGP-057: la clave privada SOLO entra por variable de entorno. Pasarla por
  // argv (--payer-private-key) queda rechazado: argv queda expuesto en el
  // historial de shell, ps y logs de CI.
  if (flags["payer-private-key"] !== undefined) {
    throw new Error("--payer-private-key was removed: set PHANTOM_PAYER_PRIVATE_KEY via environment instead (argv is visible in shell history and process listings)");
  }
  const privateKey = env.PHANTOM_PAYER_PRIVATE_KEY;
  const timeoutMs = readNumberFlag(flags, "timeout-ms", 180_000);
  const pollMs = readNumberFlag(flags, "poll-interval-ms", 3_000);
  if (!routerAddress) {
    throw new Error("PHANTOM_ROUTER_ADDRESS or --router-address is required to sign the registration payment");
  }
  if (!privateKey) {
    throw new Error("PHANTOM_PAYER_PRIVATE_KEY is required for init (environment variable only, never a command-line flag)");
  }

  const wallet = new Wallet(privateKey);
  stdout.write(`Registering ${name} for ${wallet.address} at ${config.apiUrl}\n`);

  const result = await runRegisterFlow({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    payerPrivateKey: privateKey,
    routerAddress,
    name,
    timeoutMs,
    pollMs,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    onProgress: (message) => stdout.write(`${message}\n`),
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.api_key) {
    stdout.write(`\nSet PHANTOM_API_KEY=${result.api_key} for the MCP server.\n`);
  }
  return result;
}

export function initUsage(): string {
  return [
    "Usage: phantom-mcp-server init --router-address <0x...> [--name agent-name]",
    "",
    "Environment:",
    "  PHANTOM_API_URL              PHANTOM API URL (defaults to production)",
    "  PHANTOM_ROUTER_ADDRESS       PhantomRouter verifying contract",
    "  PHANTOM_PAYER_PRIVATE_KEY    Wallet key used only for local signatures",
    "                               (environment only; the old --payer-private-key",
    "                               flag was removed — argv leaks into shell history)",
    "",
  ].join("\n");
}

function readStringFlag(flags: Record<string, string | boolean>, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readNumberFlag(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = flags[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive number`);
  return parsed;
}
