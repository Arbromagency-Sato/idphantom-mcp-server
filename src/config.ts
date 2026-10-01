export const DEFAULT_API_URL = "https://pay.idphantom.com";

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
}

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
  return {
    apiUrl: normalized,
    ...(apiKey ? { apiKey } : {}),
  };
}

function isInsecureRemoteUrl(value: string): boolean {
  if (!/^http:\/\//i.test(value)) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]";
  } catch {
    return true;
  }
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
