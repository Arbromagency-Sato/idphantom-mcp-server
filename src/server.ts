import { createFunnel, type Funnel } from "./funnel";
import { authorizeBudget, POLICY_TEMPLATES, type PolicyTemplateName } from "./budget";
import { API_KEY_ONE_TIME_WARNING, registerManual, runRegisterFlow } from "./register";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface PhantomMcpConfig {
  apiBaseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** AGP-100: configuración self-serve (TODO env-only, nunca argv — AGP-057). */
  payerPrivateKey?: string;
  funderPrivateKey?: string;
  routerAddress?: string;
  chainId?: number;
  /** F1.4: taggeo del funnel. Default "external". internal = dogfood/QA,
   *  reportar separado (wash volume prohibido, AGP-102). */
  funnelSource?: "internal" | "external";
  funnelSink?: (line: string) => void;
}

/** Envelope MCP real de todas las tools: content[0].text lleva el cuerpo JSON
 * de la API (o un objeto { error } si isError). */
const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text"], description: "Always 'text'." },
          text: { type: "string", description: "Response body of the IDPHANTOM API as a JSON string." },
        },
        required: ["type", "text"],
      },
    },
    isError: { type: "boolean", description: "True when the API call failed; text carries { error: { code, message } }." },
  },
  required: ["content"],
} as const;

const TOOLS = [
  {
    name: "phantom_register",
    title: "Register an IDPHANTOM account (self-serve)",
    description:
      "One-line onboarding: creates an IDPHANTOM account for the configured payer wallet, pays the " +
      "$2 USDC registration with a locally-signed EIP-712 authorization and returns the api_key. " +
      "Requires PHANTOM_PAYER_PRIVATE_KEY and PHANTOM_ROUTER_ADDRESS in the environment. The api_key " +
      "is shown exactly ONCE in this response — store it as PHANTOM_API_KEY immediately. " +
      "Without a payer key configured, pass payer_wallet to get manual instructions instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional display name for the account (default 'phantom-agent')." },
        payer_wallet: { type: "string", description: "Manual mode (no PHANTOM_PAYER_PRIVATE_KEY): your EVM address; the tool returns the registration challenge plus step-by-step signing instructions." },
        timeout_ms: { type: "number", description: "Auto mode: max wait for on-chain confirmation (default 180000)." },
        poll_interval_ms: { type: "number", description: "Auto mode: poll interval for the registration status (default 3000)." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Register an IDPHANTOM account (self-serve)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "phantom_authorize_budget",
    title: "Authorize a spending budget for an account",
    description:
      "Funder-signed EIP-712 AgentWalletAuthorization: lets an account spend up to max_units of USDC " +
      "(6-decimal units, e.g. '1000000' = $1) with an optional daily cap, without giving away the wallet. " +
      "Requires PHANTOM_FUNDER_PRIVATE_KEY in the environment; the signature is produced locally. " +
      "Policy templates: 'micro' ($1/tx, $5/day, 30d) and 'subscriptions' ($2/tx, $5/day, 30d) — pilot caps " +
      "kept deliberately low; explicit max_units/daily_cap_units/expires_in_days override any template. " +
      "The account's own api_key is sent as authentication (first binding requires it).",
    inputSchema: {
      type: "object",
      required: ["account_id"],
      properties: {
        account_id: { type: "string", description: "IDPHANTOM account that will spend the budget (e.g. acc_...)." },
        policy_template: { type: "string", enum: ["micro", "subscriptions", "custom"], description: "Named pilot policy (default 'micro'); use 'custom' with explicit caps." },
        max_units: { type: "string", description: "Explicit per-tx cap in 6-decimal units; overrides the template." },
        daily_cap_units: { type: "string", description: "Optional explicit daily cap in 6-decimal units; overrides the template." },
        expires_in_days: { type: "number", description: "Validity window in days (default from template; max 365)." },
        nonce: { type: "string", description: "Unique nonce per funder (default: current timestamp in ms); replays return 409." },
        api_key: { type: "string", description: "Account api_key to authenticate the call; defaults to the server's PHANTOM_API_KEY." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Authorize a spending budget for an account",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "quote_payment",
    title: "Quote a payment",
    description:
      "Create an IDPHANTOM payment quote with transparent platform fee (0.5%, min $0.01 USDC). " +
      "Returns a payment intent ready for the payer's EIP-712 signature. Free: quoting never moves funds.",
    inputSchema: {
      type: "object",
      required: ["payer_wallet", "recipient_wallet", "asset_contract", "amount", "chain_id", "idempotency_key"],
      properties: {
        payer_wallet: { type: "string", description: "EVM address of the payer wallet (0x..., checksummed)." },
        recipient_wallet: { type: "string", description: "EVM address of the recipient wallet (0x...)." },
        asset_contract: { type: "string", description: "ERC-20 token contract to pay with, e.g. USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913." },
        amount: { type: "string", description: "Token amount in smallest units (6 decimals for USDC), e.g. '2500000' = $2.50." },
        chain_id: { type: "number", description: "EVM chain ID: 8453 = Base mainnet." },
        idempotency_key: { type: "string", description: "Unique client-generated key; safe retries return the same quote instead of duplicating it." },
        payer_agent_id: { type: "string", description: "Optional A2A agent card ID of the payer, for discovery and audit." },
        recipient_agent_id: { type: "string", description: "Optional A2A agent card ID of the recipient." },
        metadata: { type: "object", description: "Optional free-form key/value object attached to the quote (surfaced in receipts)." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Quote a payment",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "authorize_payment",
    title: "Authorize a payment",
    description:
      "Attach the payer's EIP-712 PaymentAuthorization signature to a quoted payment intent. " +
      "The signature is produced locally by the payer's wallet; it authorizes up to maximumTotalAuthorized, " +
      "expiring at expiresAt. No funds move until submit_payment.",
    inputSchema: {
      type: "object",
      required: ["payment_intent_id", "payer_signature"],
      properties: {
        payment_intent_id: { type: "string", description: "Payment intent ID returned by quote_payment." },
        payer_signature: { type: "string", description: "EIP-712 signature (0x, 65 bytes) of the PaymentAuthorization typed data, signed by payer_wallet." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Authorize a payment",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "submit_payment",
    title: "Submit a payment",
    description:
      "Broadcast an authorized payment intent through IDPHANTOM. The platform relays the on-chain " +
      "transaction; exactly one broadcast per intent is enforced server-side (retries return the " +
      "already-submitted transaction hash). This is the step that settles funds.",
    inputSchema: {
      type: "object",
      required: ["payment_intent_id"],
      properties: {
        payment_intent_id: { type: "string", description: "Authorized payment intent ID to broadcast and settle." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Submit a payment",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "verify_payment",
    title: "Verify a payment receipt",
    description:
      "Verify an IDPHANTOM payment receipt: cryptographic checks (EIP-712 signature, payer recovery), " +
      "expiry, and the on-chain state of the authorization (free/used/cancelled). Free for receipts " +
      "of payments the caller participated in; paid via the receipt-verifier for third-party receipts.",
    inputSchema: {
      type: "object",
      required: ["payment_intent_id"],
      properties: {
        payment_intent_id: { type: "string", description: "Payment intent ID to verify." },
        receipt_id: { type: "string", description: "Optional specific receipt ID when several receipts exist for the intent." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Verify a payment receipt",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;

export function mcpTools(): unknown[] {
  return [...TOOLS];
}

export function createMcpHandler(config: PhantomMcpConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const apiKey = config.apiKey;
  const funnel = createFunnel(config.funnelSource ?? "external", config.funnelSink);

  return async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    if (request.method === "notifications/initialized") return null;

    if (request.method === "initialize") {
      return ok(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "phantom-mcp-server", version: "0.3.0" },
        capabilities: { tools: {} },
      });
    }

    if (request.method === "tools/list") {
      return ok(id, { tools: mcpTools() });
    }

    if (request.method === "tools/call") {
      const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      try {
        const result = await callTool({ baseUrl, fetchImpl, apiKey, config, funnel }, params?.name, params?.arguments ?? {});
        return ok(id, result);
      } catch (e) {
        return ok(id, text({ error: { code: "tool_error", message: e instanceof Error ? e.message : String(e) } }, true));
      }
    }

    return fail(id, -32601, "Method not found");
  };
}

interface ToolContext {
  baseUrl: string;
  fetchImpl: FetchLike;
  apiKey: string | undefined;
  config: PhantomMcpConfig;
  funnel: Funnel;
}

async function callTool(
  ctx: ToolContext,
  name: string | undefined,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const { baseUrl, fetchImpl, apiKey } = ctx;
  let response;
  if (name === "phantom_register") {
    return await callRegister(ctx, args);
  } else if (name === "phantom_authorize_budget") {
    return await callAuthorizeBudget(ctx, args);
  } else if (name === "quote_payment") {
    response = await postJson(fetchImpl, `${baseUrl}/v1/quotes`, args, apiKey);
  } else if (name === "authorize_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    response = await postJson(fetchImpl, `${baseUrl}/v1/intents/${encodeURIComponent(id)}/authorize`, {
      payer_signature: args.payer_signature,
    }, apiKey);
  } else if (name === "submit_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    response = await postJson(fetchImpl, `${baseUrl}/v1/intents/${encodeURIComponent(id)}/submit`, {}, apiKey);
    if (response.ok) {
      ctx.funnel.trackPay(apiKey ?? "anonymous", { payment_intent_id: id });
    }
  } else if (name === "verify_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    const receipt = args.receipt_id ? `&receipt_id=${encodeURIComponent(String(args.receipt_id))}` : "";
    response = await getJson(fetchImpl, `${baseUrl}/v1/receipts/verify?payment_intent_id=${encodeURIComponent(id)}${receipt}`, apiKey);
  } else {
    return text({ error: { code: "tool_not_found", message: `Unknown MCP tool: ${name ?? ""}` } }, true);
  }
  return text(response.body, !response.ok);
}

async function callRegister(ctx: ToolContext, args: Record<string, unknown>) {
  const { baseUrl, fetchImpl, apiKey, config, funnel } = ctx;
  if (config.payerPrivateKey && config.routerAddress) {
    const result = await runRegisterFlow({
      apiUrl: baseUrl,
      apiKey,
      payerPrivateKey: config.payerPrivateKey,
      routerAddress: config.routerAddress,
      name: typeof args.name === "string" && args.name ? args.name : undefined,
      timeoutMs: readPositiveInt(args.timeout_ms, "timeout_ms") ?? undefined,
      pollMs: readPositiveInt(args.poll_interval_ms, "poll_interval_ms") ?? undefined,
      fetchImpl,
      onEvent: (event, data) => funnel.emit(event, data),
    });
    if (result.api_key) {
      return text({ ...result, warning: API_KEY_ONE_TIME_WARNING });
    }
    return text(result, true);
  }
  // Modo manual: sin clave de pagador configurada, el caller firma por su cuenta.
  if (typeof args.payer_wallet === "string" && args.payer_wallet) {
    const registration = await registerManual({
      apiUrl: baseUrl,
      apiKey,
      payerWallet: args.payer_wallet,
      name: typeof args.name === "string" && args.name ? args.name : undefined,
      fetchImpl,
    });
    funnel.emit("register_start", { payer_wallet: args.payer_wallet, mode: "manual" });
    return text(registration);
  }
  return text({
    error: {
      code: "config_required",
      message:
        "phantom_register needs PHANTOM_PAYER_PRIVATE_KEY and PHANTOM_ROUTER_ADDRESS in the environment for auto mode, " +
        "or a payer_wallet argument for manual mode (step-by-step signing instructions).",
    },
  }, true);
}

async function callAuthorizeBudget(ctx: ToolContext, args: Record<string, unknown>) {
  const { baseUrl, fetchImpl, apiKey, config } = ctx;
  if (!config.funderPrivateKey) {
    return text({
      error: {
        code: "config_required",
        message:
          "phantom_authorize_budget needs PHANTOM_FUNDER_PRIVATE_KEY in the environment (the human funder's key, " +
          "environment variable only — never a command-line flag). The EIP-712 signature is produced locally.",
      },
    }, true);
  }
  const accountId = requireString(args.account_id, "account_id");
  const template = typeof args.policy_template === "string" ? args.policy_template as PolicyTemplateName : undefined;
  if (template && template !== "custom" && !(template in POLICY_TEMPLATES)) {
    return text({ error: { code: "validation_error", message: `unknown policy_template '${template}' (use micro, subscriptions or custom)` } }, true);
  }
  const result = await authorizeBudget({
    apiUrl: baseUrl,
    apiKey: typeof args.api_key === "string" && args.api_key ? args.api_key : apiKey,
    funderPrivateKey: config.funderPrivateKey,
    routerAddress: config.routerAddress ?? "",
    chainId: config.chainId,
    accountId,
    template,
    maxUnits: typeof args.max_units === "string" || typeof args.max_units === "number" ? BigInt(String(args.max_units)) : undefined,
    dailyCapUnits: typeof args.daily_cap_units === "string" || typeof args.daily_cap_units === "number" ? BigInt(String(args.daily_cap_units)) : undefined,
    expiresInDays: readPositiveInt(args.expires_in_days, "expires_in_days") ?? undefined,
    nonce: typeof args.nonce === "string" || typeof args.nonce === "number" ? BigInt(String(args.nonce)) : undefined,
    fetchImpl,
  });
  return text(result);
}

function readPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number`);
  return Math.floor(parsed);
}

async function postJson(fetchImpl: FetchLike, url: string, payload: unknown, apiKey?: string) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: requestHeaders(apiKey, true),
    body: JSON.stringify(payload),
  });
  return parseResponse(res);
}

async function getJson(fetchImpl: FetchLike, url: string, apiKey?: string) {
  const res = await fetchImpl(url, { method: "GET", headers: requestHeaders(apiKey, false) });
  return parseResponse(res);
}

function requestHeaders(apiKey: string | undefined, json: boolean): Record<string, string> {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function parseResponse(res: Awaited<ReturnType<FetchLike>>) {
  const raw = await res.text();
  const body = raw ? JSON.parse(raw) : {};
  return { ok: res.ok, status: res.status, body };
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}
