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
  {
    name: "pay_url",
    title: "Pay an x402-gated URL",
    description:
      "Pay any URL that demands HTTP 402 payment (x402 protocol, USDC on Base): the IDPHANTOM API " +
      "detects the challenge (v1/v2), validates it against your account policy (allowed domains, " +
      "per-payment cap, daily cap), signs the EIP-3009 authorization server-side and retries with " +
      "the payment header. The agent never handles x402 itself. Retries with the same " +
      "idempotency_key return the stored receipt instead of paying again. The payment is funded by " +
      "the IDPHANTOM x402 payer wallet under per-domain caps and a global daily cap; per-account " +
      "ledger billing is planned as a follow-up.",
    inputSchema: {
      type: "object",
      required: ["url", "idempotency_key"],
      properties: {
        url: { type: "string", description: "The URL to fetch and pay if it responds 402, e.g. https://pay.idphantom.com/v1/demo/premium." },
        idempotency_key: { type: "string", description: "Unique client-generated key; safe retries return the stored receipt instead of paying again." },
      },
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      title: "Pay an x402-gated URL",
      readOnlyHint: false,
      destructiveHint: true,
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

  return async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    if (request.method === "notifications/initialized") return null;

    if (request.method === "initialize") {
      return ok(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "phantom-mcp-server", version: "0.2.0" },
        capabilities: { tools: {} },
      });
    }

    if (request.method === "tools/list") {
      return ok(id, { tools: mcpTools() });
    }

    if (request.method === "tools/call") {
      const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      try {
        const result = await callTool(baseUrl, fetchImpl, apiKey, params?.name, params?.arguments ?? {});
        return ok(id, result);
      } catch (e) {
        return ok(id, text({ error: { code: "tool_error", message: e instanceof Error ? e.message : String(e) } }, true));
      }
    }

    return fail(id, -32601, "Method not found");
  };
}

async function callTool(
  baseUrl: string,
  fetchImpl: FetchLike,
  apiKey: string | undefined,
  name: string | undefined,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  let response;
  if (name === "quote_payment") {
    response = await postJson(fetchImpl, `${baseUrl}/v1/quotes`, args, apiKey);
  } else if (name === "authorize_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    response = await postJson(fetchImpl, `${baseUrl}/v1/intents/${encodeURIComponent(id)}/authorize`, {
      payer_signature: args.payer_signature,
    }, apiKey);
  } else if (name === "submit_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    response = await postJson(fetchImpl, `${baseUrl}/v1/intents/${encodeURIComponent(id)}/submit`, {}, apiKey);
  } else if (name === "verify_payment") {
    const id = requireString(args.payment_intent_id, "payment_intent_id");
    const receipt = args.receipt_id ? `&receipt_id=${encodeURIComponent(String(args.receipt_id))}` : "";
    response = await getJson(fetchImpl, `${baseUrl}/v1/receipts/verify?payment_intent_id=${encodeURIComponent(id)}${receipt}`, apiKey);
  } else if (name === "pay_url") {
    const url = requireString(args.url, "url");
    const idem = requireString(args.idempotency_key, "idempotency_key");
    response = await postJson(fetchImpl, `${baseUrl}/v1/x402/pay`, {
      url,
      idempotency_key: idem,
    }, apiKey);
  } else {
    return text({ error: { code: "tool_not_found", message: `Unknown MCP tool: ${name ?? ""}` } }, true);
  }
  return text(response.body, !response.ok);
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
