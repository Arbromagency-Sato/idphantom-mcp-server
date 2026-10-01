import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { runInit } from "../src/init";

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

describe("phantom MCP init command", () => {
  it("orchestrates register, authorize, submit, poll and claim without leaking the private key", async () => {
    const payer = Wallet.createRandom();
    const calls: { url: string; init?: RequestInit; body?: unknown }[] = [];
    const writes: string[] = [];
    const reference = "reg_111111111111111111111111";
    const paymentIntentId = "pi_registration";

    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, init, body });
      if (url.endsWith("/v1/register") && init?.method === "POST") {
        expect(body).toMatchObject({ payer_wallet: payer.address, name: "agent-one" });
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
      if (url.endsWith(`/v1/intents/${paymentIntentId}/authorize`)) {
        expect(body.payer_signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
        return response({ status: "authorized" });
      }
      if (url.endsWith(`/v1/intents/${paymentIntentId}/submit`)) {
        return response({ status: "submitted" });
      }
      if (url.endsWith(`/v1/register/${reference}`) && init?.method === "GET") {
        return response({ status: "confirmed", claim: { url: `/v1/register/${reference}/claim` } });
      }
      if (url.endsWith(`/v1/register/${reference}/claim`)) {
        expect(body.payer_signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
        return response({ status: "completed", account_id: "acc_test", api_key: "pk_live_test" });
      }
      throw new Error(`unexpected call ${init?.method ?? "GET"} ${url}`);
    };

    const result = await runInit({
      argv: [
        "--api-url", "https://phantom.test",
        "--router-address", ROUTER,
        "--payer-private-key", payer.privateKey,
        "--name", "agent-one",
        "--poll-interval-ms", "1",
      ],
      env: {},
      fetchImpl,
      stdout: { write: (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; } },
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      reference,
      status: "completed",
      account_id: "acc_test",
      api_key: "pk_live_test",
    });
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "POST https://phantom.test/v1/register",
      `POST https://phantom.test/v1/intents/${paymentIntentId}/authorize`,
      `POST https://phantom.test/v1/intents/${paymentIntentId}/submit`,
      `GET https://phantom.test/v1/register/${reference}`,
      `POST https://phantom.test/v1/register/${reference}/claim`,
    ]);
    expect(writes.join("")).not.toContain(payer.privateKey);
  });
});
