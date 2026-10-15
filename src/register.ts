import { ethers, type TypedDataDomain, type TypedDataField } from "ethers";

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface PaymentIntent {
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

export interface RegistrationResponse {
  reference: string;
  status: string;
  payment: {
    payment_intent_id: string;
    amount: string;
    asset: string;
    recipient_wallet: string;
    instructions?: unknown[];
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

/** Aviso que acompaña SIEMPRE al api_key devuelto por phantom_register.
 *  La API key se muestra UNA SOLA VEZ (el claim es irrepetible): si el
 *  usuario no la guarda ahora, la cuenta queda inutilizable y habría que
 *  registrar otra (invariante AGP-100 F1.1). */
export const API_KEY_ONE_TIME_WARNING =
  "IMPORTANTE: esta api_key se muestra UNA SOLA VEZ. Guardala ahora en tu " +
  "variable de entorno PHANTOM_API_KEY (o gestor de secretos). La API no la " +
  "vuelve a revelar: si la pierdes tendras que registrar una cuenta nueva.";

export interface RegisterFlowOptions {
  apiUrl: string;
  apiKey?: string;
  payerPrivateKey: string;
  routerAddress: string;
  name?: string;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: "register_start" | "register_complete", data: Record<string, unknown>) => void;
  onProgress?: (message: string) => void;
}

export interface RegisterFlowResult {
  reference: string;
  status: string;
  account_id?: string;
  api_key?: string | null;
}

export const AUTH_TYPES = {
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

export function phantomPayDomain(chainId: number, routerAddress: string): TypedDataDomain {
  return { name: "PhantomPay", version: "1", chainId, verifyingContract: routerAddress };
}

export function authorizationValue(intent: PaymentIntent): Record<string, unknown> {
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

/** Flujo completo de registro de cuenta (AGP-100 F1.1): register → firmar →
 *  authorize → submit → poll → claim. Compartido entre el comando CLI
 *  `init` y la tool MCP `phantom_register`. Las firmas se producen SOLO en
 *  local; la clave privada nunca sale de este proceso ni se loguea. */
export async function runRegisterFlow(options: RegisterFlowOptions): Promise<RegisterFlowResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const name = options.name ?? "phantom-agent";
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 3_000;

  if (!options.routerAddress) {
    throw new Error("PHANTOM_ROUTER_ADDRESS is required to sign the registration payment");
  }
  if (!options.payerPrivateKey) {
    throw new Error("PHANTOM_PAYER_PRIVATE_KEY is required for register (environment variable only, never a command-line flag)");
  }
  if (!ethers.isAddress(options.routerAddress)) {
    throw new Error("router address is invalid");
  }

  const wallet = new ethers.Wallet(options.payerPrivateKey);
  const headers = jsonHeaders(options.apiKey);
  const baseUrl = options.apiUrl.replace(/\/+$/, "");

  options.onEvent?.("register_start", { payer_wallet: wallet.address, name });

  const registration = await requestJson<RegistrationResponse>(
    fetchImpl,
    `${baseUrl}/v1/register`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_wallet: wallet.address, name }),
    }
  );

  const intent = registration.payment.intent;
  const paymentSignature = await wallet.signTypedData(
    phantomPayDomain(intent.chain_id, options.routerAddress),
    AUTH_TYPES,
    authorizationValue(intent)
  );

  options.onProgress?.(`Authorizing registration payment ${intent.payment_intent_id}`);
  await requestJson<unknown>(
    fetchImpl,
    `${baseUrl}/v1/intents/${encodeURIComponent(intent.payment_intent_id)}/authorize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_signature: paymentSignature }),
    }
  );

  options.onProgress?.("Submitting registration payment");
  await requestJson<unknown>(
    fetchImpl,
    `${baseUrl}/v1/intents/${encodeURIComponent(intent.payment_intent_id)}/submit`,
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
      `${baseUrl}/v1/register/${encodeURIComponent(registration.reference)}`,
      { method: "GET", headers: options.apiKey ? authHeaders(options.apiKey) : undefined }
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
  options.onProgress?.("Claiming API key");
  const claim = await requestJson<ClaimResponse>(
    fetchImpl,
    `${baseUrl}${claimPath}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ payer_signature: claimSignature }),
    }
  );

  const result: RegisterFlowResult = {
    reference: registration.reference,
    status: claim.status,
    ...(claim.account_id ? { account_id: claim.account_id } : {}),
    api_key: claim.api_key ?? null,
  };
  options.onEvent?.("register_complete", { reference: registration.reference, account_id: claim.account_id ?? null });
  return result;
}

/** Modo manual (sin PHANTOM_PAYER_PRIVATE_KEY configurada): el caller da su
 *  payer_wallet y firma por su cuenta los pasos siguientes siguiendo las
 *  instructions[] devueltas por la API. */
export async function registerManual(options: {
  apiUrl: string;
  apiKey?: string;
  payerWallet: string;
  name?: string;
  fetchImpl?: FetchLike;
}): Promise<RegistrationResponse & { mode: "manual"; next_steps: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!ethers.isAddress(options.payerWallet)) {
    throw new Error("payer_wallet must be a valid EVM address (0x...)");
  }
  const baseUrl = options.apiUrl.replace(/\/+$/, "");
  const registration = await requestJson<RegistrationResponse>(
    fetchImpl,
    `${baseUrl}/v1/register`,
    {
      method: "POST",
      headers: jsonHeaders(options.apiKey),
      body: JSON.stringify({ payer_wallet: options.payerWallet, name: options.name ?? "phantom-agent" }),
    }
  );
  return {
    ...registration,
    mode: "manual",
    next_steps: [
      "Firma el EIP-712 PaymentAuthorization del intent (ver payment.intent) con tu wallet.",
      "POST /v1/intents/<payment_intent_id>/authorize con { payer_signature }.",
      "POST /v1/intents/<payment_intent_id>/submit para transmitir el pago.",
      `GET /v1/register/${registration.reference} hasta status=confirmed.`,
      `POST /v1/register/${registration.reference}/claim con payer_signature = personal_sign(reference).`,
      "La api_key se muestra UNA SOLA VEZ en la respuesta del claim: guardala como PHANTOM_API_KEY.",
    ],
  };
}

export async function requestJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
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

export function jsonHeaders(apiKey?: string): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(apiKey) };
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
