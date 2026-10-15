import { describe, expect, it } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import { createMcpHandler } from "../src/server";
import { AGENT_WALLET_AUTH_TYPES } from "../src/budget";

const ROUTER = "0x9999999999999999999999999999999999999999";
const ASSET = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    text: async () => JSON.stringify(body),
  };
}

function readToolText(res: unknown): any {
  return JSON.parse((res as { result: { content: { text: string }[] } }).result.content[0].text);
}

describe("AGP-100 self-serve tools", () => {
  it("phantom_register (auto) returns the api_key once with a loud warning and no key material in the output", async () => {
    const payer = Wallet.createRandom();
    const funnelLines: string[] = [];
    const reference = "reg_agp100_auto";
    const paymentIntentId = "pi_agp100_reg";

    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/register") && init?.method === "POST") {
        return response({
          reference,
          status: "pending",
          payment: {
            payment_intent_id: paymentIntentId,
            amount: "2000000",
            asset: "USDC",
            recipient_wallet: RECIPIENT,
            intent: {
              payment_intent_id: paymentIntentId,
              payer_wallet: payer.address,
              recipient_wallet: RECIPIENT,
              asset_contract: ASSET,
              amount: "2000000",
              platform_fee: "0",
              maximum_total_authorized: "2000000",
              nonce: 1,
              chain_id: 8453,
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          },
        });
      }
      if (url.endsWith(`/v1/intents/${paymentIntentId}/authorize`)) return response({ status: "authorized" });
      if (url.endsWith(`/v1/intents/${paymentIntentId}/submit`)) return response({ status: "submitted" });
      if (url.endsWith(`/v1/register/${reference}`) && init?.method === "GET") {
        return response({ status: "confirmed", claim: { url: `/v1/register/${reference}/claim` } });
      }
      if (url.endsWith(`/v1/register/${reference}/claim`)) {
        return response({ status: "completed", account_id: "acc_agp100", api_key: "pk_live_agp100" });
      }
      throw new Error(`unexpected call ${init?.method ?? "GET"} ${url}`);
    };

    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      payerPrivateKey: payer.privateKey,
      routerAddress: ROUTER,
      fetchImpl,
      funnelSink: (line) => funnelLines.push(line),
    });

    const res = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "phantom_register", arguments: { name: "agent-one", poll_interval_ms: 1 } },
    });

    const body = readToolText(res);
    expect(body).toMatchObject({ reference, status: "completed", account_id: "acc_agp100", api_key: "pk_live_agp100" });
    expect(body.warning).toMatch(/UNA SOLA VEZ/);
    const raw = JSON.stringify(res);
    expect(raw).not.toContain(payer.privateKey.slice(2));
    const events = funnelLines.map((l) => JSON.parse(l.replace(/^\[funnel\] /, "")).event);
    expect(events).toEqual(["register_start", "register_complete"]);
  });

  it("phantom_register (manual, no payer key) returns step-by-step instructions", async () => {
    const funnelLines: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://phantom.test/v1/register");
      expect(init?.method).toBe("POST");
      return response({
        reference: "reg_manual",
        status: "pending",
        payment: {
          payment_intent_id: "pi_manual",
          amount: "2000000",
          asset: "USDC",
          recipient_wallet: RECIPIENT,
          instructions: ["sign this", "post that"],
          intent: {
            payment_intent_id: "pi_manual",
            payer_wallet: "0x1111111111111111111111111111111111111111",
            recipient_wallet: RECIPIENT,
            asset_contract: ASSET,
            amount: "2000000",
            platform_fee: "0",
            maximum_total_authorized: "2000000",
            nonce: 1,
            chain_id: 8453,
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
      });
    };

    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      fetchImpl,
      funnelSink: (line) => funnelLines.push(line),
    });

    const res = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "phantom_register", arguments: { payer_wallet: "0x1111111111111111111111111111111111111111" } },
    });

    const body = readToolText(res);
    expect(body.mode).toBe("manual");
    expect(body.reference).toBe("reg_manual");
    expect(body.next_steps.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(body)).toContain("UNA SOLA VEZ");
  });

  it("phantom_register without keys and without payer_wallet returns a clear config error", async () => {
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      fetchImpl: async () => { throw new Error("should not be called"); },
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "phantom_register", arguments: {} },
    });
    const body = readToolText(res);
    expect(body.error.code).toBe("config_required");
    expect(body.error.message).toMatch(/PHANTOM_PAYER_PRIVATE_KEY/);
    expect((res as { result: { isError?: boolean } }).result.isError).toBe(true);
  });

  it("phantom_authorize_budget signs AgentWalletAuthorization with the funder key and sends the account api_key (RW-2)", async () => {
    const funder = Wallet.createRandom();
    const calls: { url: string; init?: RequestInit; body: any }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return response({ status: "authorized", allocated: "1000000" });
    };

    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      apiKey: "pk_live_account",
      funderPrivateKey: funder.privateKey,
      routerAddress: ROUTER,
      fetchImpl,
    });

    const res = await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "phantom_authorize_budget",
        arguments: { account_id: "acc_1", policy_template: "micro", nonce: "42" },
      },
    });

    expect(calls[0].url).toBe("https://phantom.test/v1/agent-wallet/authorize");
    // RW-2: el caller autenticado es la propia cuenta (su api_key).
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer pk_live_account");
    const sent = calls[0].body;
    // Plantilla micro: $1/tx, $5/dia.
    expect(sent.max_units).toBe("1000000");
    expect(sent.daily_cap_units).toBe("5000000");
    expect(sent.funder_wallet).toBe(funder.address);
    expect(sent.nonce).toBe("42");
    // La firma debe recuperar al funder con el dominio y tipos del API.
    const recovered = verifyTypedData(
      { name: "PhantomPay", version: "1", chainId: 8453, verifyingContract: ROUTER },
      AGENT_WALLET_AUTH_TYPES,
      {
        accountId: sent.account_id,
        funder: sent.funder_wallet,
        maxUnits: sent.max_units,
        dailyCap: sent.daily_cap_units,
        nonce: sent.nonce,
        expiresAt: Math.floor(Date.parse(sent.expires_at) / 1000),
      },
      sent.signature
    );
    expect(recovered).toBe(funder.address);
    const body = readToolText(res);
    expect(body.funder_wallet).toBe(funder.address);
    expect(body.api_response).toMatchObject({ status: "authorized" });
  });

  it("phantom_authorize_budget explicit caps override the template", async () => {
    const funder = Wallet.createRandom();
    const calls: { body: any }[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return response({ status: "authorized" });
    };
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      funderPrivateKey: funder.privateKey,
      routerAddress: ROUTER,
      fetchImpl,
    });
    await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "phantom_authorize_budget",
        arguments: { account_id: "acc_2", policy_template: "custom", max_units: "250000", daily_cap_units: "500000", expires_in_days: 7 },
      },
    });
    expect(calls[0].body.max_units).toBe("250000");
    expect(calls[0].body.daily_cap_units).toBe("500000");
  });

  it("phantom_authorize_budget without a funder key returns a clear config error", async () => {
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      fetchImpl: async () => { throw new Error("should not be called"); },
    });
    const res = await handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "phantom_authorize_budget", arguments: { account_id: "acc_3" } },
    });
    const body = readToolText(res);
    expect(body.error.code).toBe("config_required");
    expect(body.error.message).toMatch(/PHANTOM_FUNDER_PRIVATE_KEY/);
  });

  it("submit_payment emits first_pay then repeat on the funnel", async () => {
    const funnelLines: string[] = [];
    const fetchImpl = async (url: string) => {
      expect(url).toBe("https://phantom.test/v1/intents/pi_x/submit");
      return response({ status: "submitted", tx_hash: "0xabc" });
    };
    const handle = createMcpHandler({
      apiBaseUrl: "https://phantom.test",
      apiKey: "pk_live_acct",
      fetchImpl,
      funnelSink: (line) => funnelLines.push(line),
    });
    const call = () => handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "submit_payment", arguments: { payment_intent_id: "pi_x" } },
    });
    await call();
    await call();
    const events = funnelLines.map((l) => JSON.parse(l.replace(/^\[funnel\] /, "")).event);
    expect(events).toEqual(["first_pay", "repeat"]);
  });
});
