import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, resolveCliConfig } from "../src/config";
import { createMcpHandler } from "../src/server";

describe("phantom MCP server", () => {
  it("lists the payment tools", async () => {
    const handle = createMcpHandler({ apiBaseUrl: "https://phantom.test" });
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "quote_payment",
      "authorize_payment",
      "submit_payment",
      "verify_payment",
    ]);
  });

  it("resolves production env config and sends PHANTOM_API_KEY upstream", async () => {
    expect(resolveCliConfig([], {})).toEqual({ apiUrl: DEFAULT_API_URL });
    expect(resolveCliConfig(["--api-url", "https://flag.test/"], { PHANTOM_API_URL: "https://env.test", PHANTOM_ALLOW_CUSTOM_API_URL: "1" })).toEqual({
      apiUrl: "https://flag.test",
    });
    expect(() => resolveCliConfig([], { PHANTOM_API_URL: "http://evil.example.com" })).toThrow(/insecure/);
    expect(resolveCliConfig([], { PHANTOM_API_URL: "http://localhost:8787" }).apiUrl).toBe("http://localhost:8787");

    const calls: { url: string; init?: RequestInit }[] = [];
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      apiKey: "pk_live_test",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ verified: true }),
        };
      },
    });

    await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "verify_payment",
        arguments: { payment_intent_id: "pi_env" },
      },
    });

    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer pk_live_test");
  });

  it("proxies quote_payment to the PHANTOM API", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test/",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ payment_intent_id: "pi_123", status: "quoted" }),
        };
      },
    });

    const res = await handle({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "quote_payment",
        arguments: {
          payer_wallet: "0x1111111111111111111111111111111111111111",
          recipient_wallet: "0x2222222222222222222222222222222222222222",
          asset_contract: "0x3333333333333333333333333333333333333333",
          amount: "1000000",
          chain_id: 84532,
          idempotency_key: "ik_test",
        },
      },
    });

    expect(calls[0].url).toBe("https://phantom.test/v1/quotes");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(((res?.result as { content: { text: string }[] }).content[0].text))).toMatchObject({
      payment_intent_id: "pi_123",
      status: "quoted",
    });
  });

  it("proxies verify_payment with receipt id", async () => {
    const calls: string[] = [];
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      fetchImpl: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ verified: true }),
        };
      },
    });

    const res = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "verify_payment",
        arguments: { payment_intent_id: "pi_abc", receipt_id: "rcpt_abc" },
      },
    });

    expect(calls[0]).toBe("https://phantom.test/v1/receipts/verify?payment_intent_id=pi_abc&receipt_id=rcpt_abc");
    expect(JSON.parse(((res?.result as { content: { text: string }[] }).content[0].text))).toEqual({
      verified: true,
    });
  });
});

// AGP-064 (auditoría externa, Fase 5): allowlist de orígenes para PHANTOM_API_URL.
describe("API URL trust boundary (AGP-064)", () => {
  it("acepta pay.idphantom.com y api.idphantom.com sin override", () => {
    expect(resolveCliConfig([], { PHANTOM_API_URL: "https://pay.idphantom.com" }).apiUrl).toBe("https://pay.idphantom.com");
    expect(resolveCliConfig([], { PHANTOM_API_URL: "https://api.idphantom.com/" }).apiUrl).toBe("https://api.idphantom.com");
    expect(resolveCliConfig([], { PHANTOM_API_URL: "https://staging.pay.idphantom.com" }).apiUrl).toBe("https://staging.pay.idphantom.com");
  });

  it("rechaza http remoto (regla previa, sin cambios)", () => {
    expect(() => resolveCliConfig([], { PHANTOM_API_URL: "http://evil.com" })).toThrow(/insecure/);
  });

  it("rechaza https a host no confiable sin override explícito", () => {
    expect(() => resolveCliConfig([], { PHANTOM_API_URL: "https://evil.com" })).toThrow(/Untrusted PHANTOM_API_URL host 'evil\.com'/);
    expect(() => resolveCliConfig(["--api-url", "https://attacker.example"], {})).toThrow(/Untrusted PHANTOM_API_URL host/);
  });

  it("acepta host no confiable solo con override explícito", () => {
    expect(resolveCliConfig([], { PHANTOM_API_URL: "https://evil.com", PHANTOM_ALLOW_CUSTOM_API_URL: "1" }).apiUrl).toBe("https://evil.com");
    expect(resolveCliConfig(["--api-url", "https://staging.internal", "--allow-custom-api-url"], {}).apiUrl).toBe("https://staging.internal");
  });

  it("localhost sigue permitido en http sin override", () => {
    expect(resolveCliConfig([], { PHANTOM_API_URL: "http://localhost:3000" }).apiUrl).toBe("http://localhost:3000");
    expect(resolveCliConfig([], { PHANTOM_API_URL: "http://127.0.0.1:8787" }).apiUrl).toBe("http://127.0.0.1:8787");
  });
});
