export const DEFAULT_API_URL = "https://pay.idphantom.com";

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
}

// AGP-064 (auditoría externa, Fase 5): el cliente envía PHANTOM_API_KEY como
// Bearer a la URL configurada. Sin allowlist, un agente engañado (prompt
// injection) podría apuntar la URL a un host malicioso y filtrar su key.
// Por defecto solo se aceptan orígenes de IDPHANTOM y localhost; cualquier
// otro host exige override explícito del desarrollador.
const TRUSTED_HOST_SUFFIX = ".idphantom.com";
const TRUSTED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function resolveCliConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const args = parseFlags(argv);
  const apiUrl =
    readFlag(args, "api-url") ??
    readFlag(args, "apiUrl") ??
    env.PHANTOM_API_URL ??
    env.PHANTOM_API_BASE_URL ??
    DEFAULT_API_URL;
  const apiKey = readFlag(args, "api-key") ?? readFlag(args, "apiKey") ?? env.PHANTOM_API_KEY;
  const normalized = stripTrailingSlash(apiUrl);
  if (isInsecureRemoteUrl(normalized)) {
    throw new Error(
      `Refusing insecure API URL "${normalized}": use https:// (plain http is only allowed for localhost/127.0.0.1).`
    );
  }
  const override =
    args["allow-custom-api-url"] !== undefined || env.PHANTOM_ALLOW_CUSTOM_API_URL === "1";
  if (!override) {
    const hostname = safeHostname(normalized);
    if (hostname === null || !isTrustedApiUrlHost(hostname)) {
      throw new Error(
        `Untrusted PHANTOM_API_URL host '${hostname ?? normalized}'. ` +
          `Production credentials are only sent to *.idphantom.com or localhost by default. ` +
          `Set PHANTOM_ALLOW_CUSTOM_API_URL=1 (or pass --allow-custom-api-url) to use a custom endpoint explicitly.`
      );
    }
  }
  return {
    apiUrl: normalized,
    ...(apiKey ? { apiKey } : {}),
  };
}

function isTrustedApiUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "idphantom.com" || host.endsWith(TRUSTED_HOST_SUFFIX) || TRUSTED_HOSTS.has(host);
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isInsecureRemoteUrl(value: string): boolean {
  if (!/^http:\/\//i.test(value)) return false;
  const hostname = safeHostname(value);
  return hostname === null || !TRUSTED_HOSTS.has(hostname);
}

function readFlag(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      parsed[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
