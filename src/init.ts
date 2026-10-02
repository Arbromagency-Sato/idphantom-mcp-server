import { ethers, type TypedDataDomain, type TypedDataField } from "ethers";
import { parseFlags, resolveCliConfig } from "./config";

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

interface PaymentIntent {
  payment_intent_id: string;
  payer_wallet: string;
  recipient_wallet: string;
  asset_contract: string;
  amount: string;
  platform_fee: string;
  maximum_total_authorized: string;
  nonce: number;
  chain_id: number;
  expires_at: string;
}

interface RegistrationResponse {
  reference: string;
  status: string;
  payment: {
    payment_intent_id: string;
    amount: string;
    asset: string;
    recipient_wallet: string;
    intent: PaymentIntent;
  };
}

interface RegistrationStatus {
  status: string;
  claim?: { url?: string };
}

interface ClaimResponse {
  status: string;
  account_id?: string;
  api_key?: string | null;
  notice?: string;
}

interface InitOptions {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  sleep?: (ms: number) => Promise<void>;
}

export interface InitResult {
  reference: string;
  account_id?: string;
  api_key?: string | null;
  status: string;
}

const AUTH_TYPES = {
  PaymentAuthorization: [
    { name: "paymentIntentId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "recipient", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "platformFee", type: "uint256" },
    { name: "maximumTotalAuthorized", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
  ],
} satisfies Record<string, TypedDataField[]>;

export async function runInit(options: InitOptions): Promise<InitResult> {
  const env = options.env ?? process.env;
  const flags = parseFlags(options.argv);
  const config = resolveCliConfig(options.argv, env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const stdout = options.stdout ?? process.stdout;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

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
  if (!ethers.isAddress(routerAddress)) {
    throw new Error("router address is invalid");
  }

  const wallet = new ethers.Wallet(privateKey);
  const headers = jsonHeaders(config.apiKey);

  stdout.write(`Registering ${name} for ${wallet.address} at ${config.apiUrl}\n`);
  const registration = await requestJson<RegistrationResponse>(
    fetchImpl,
    `${config.apiUrl}/v1/register`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_wallet: wallet.address, name }),
    }
  );

  const intent = registration.payment.intent;
  const paymentSignature = await wallet.signTypedData(
    phantomPayDomain(intent.chain_id, routerAddress),
    AUTH_TYPES,
    authorizationValue(intent)
  );

  stdout.write(`Authorizing registration payment ${intent.payment_intent_id}\n`);
  await requestJson<unknown>(
    fetchImpl,
    `${config.apiUrl}/v1/intents/${encodeURIComponent(intent.payment_intent_id)}/authorize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_signature: paymentSignature }),
    }
  );

  stdout.write("Submitting registration payment\n");
  await requestJson<unknown>(
    fetchImpl,
    `${config.apiUrl}/v1/intents/${encodeURIComponent(intent.payment_intent_id)}/submit`,
    {
      method: "POST",
      headers,
      body: "{}",
    }
  );

  const deadline = Date.now() + timeoutMs;
  let current: RegistrationStatus = { status: registration.status };
  while (Date.now() < deadline) {
    current = await requestJson<RegistrationStatus>(
      fetchImpl,
      `${config.apiUrl}/v1/register/${encodeURIComponent(registration.reference)}`,
      { method: "GET", headers: config.apiKey ? authHeaders(config.apiKey) : undefined }
    );
    if (current.status === "confirmed" || current.status === "completed") break;
    if (current.status === "failed" || current.status === "expired") {
      throw new Error(`registration ${registration.reference} ended as ${current.status}`);
    }
    await sleep(pollMs);
  }
  if (current.status !== "confirmed" && current.status !== "completed") {
    throw new Error(`timed out waiting for registration ${registration.reference}`);
  }

  const claimSignature = await wallet.signMessage(registration.reference);
  const claimPath = current.claim?.url ?? `/v1/register/${registration.reference}/claim`;
  stdout.write("Claiming API key\n");
  const claim = await requestJson<ClaimResponse>(
    fetchImpl,
    `${config.apiUrl}${claimPath}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_signature: claimSignature }),
    }
  );

  const result: InitResult = {
    reference: registration.reference,
    status: claim.status,
    ...(claim.account_id ? { account_id: claim.account_id } : {}),
    api_key: claim.api_key ?? null,
  };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (claim.api_key) {
    stdout.write(`\nSet PHANTOM_API_KEY=${claim.api_key} for the MCP server.\n`);
  }
  return result;
}

export function initUsage(): string {
  return [
    "Usage: phantom-mcp-server init --router-address <0x...> [--name agent-name]",
    "",
    "Environment:",
    "  PHANTOM_API_URL              PHANTOM API URL (defaults to production)",
    "  PHANTOM_ALLOW_CUSTOM_API_URL Set to 1 to allow non-IDPHANTOM API URLs",
    "                               (production credentials go to this URL)",
    "  PHANTOM_ROUTER_ADDRESS       PhantomRouter verifying contract",
    "  PHANTOM_PAYER_PRIVATE_KEY    Wallet key used only for local signatures",
    "                               (environment only; the old --payer-private-key",
    "                               flag was removed — argv leaks into shell history)",
    "",
  ].join("\n");
}

function phantomPayDomain(chainId: number, routerAddress: string): TypedDataDomain {
  return { name: "PhantomPay", version: "1", chainId, verifyingContract: routerAddress };
}

function authorizationValue(intent: PaymentIntent): Record<string, unknown> {
  return {
    paymentIntentId: ethers.keccak256(ethers.toUtf8Bytes(intent.payment_intent_id)),
    payer: intent.payer_wallet,
    recipient: intent.recipient_wallet,
    token: intent.asset_contract,
    amount: intent.amount,
    platformFee: intent.platform_fee,
    maximumTotalAuthorized: intent.maximum_total_authorized,
    nonce: intent.nonce,
    expiresAt: BigInt(Math.floor(new Date(intent.expires_at).getTime() / 1000)),
  };
}

async function requestJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = extractErrorMessage(body) ?? response.statusText ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function jsonHeaders(apiKey?: string): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(apiKey) };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
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
