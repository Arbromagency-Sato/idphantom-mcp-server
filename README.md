# IDPHANTOM MCP Server

`@phantomid/mcp-server` exposes IDPHANTOM payments as standard MCP tools so an AI agent can quote, authorize, submit, and verify agent-to-agent payments through IDPHANTOM.

Production defaults to:

```text
https://pay.idphantom.com
```

## Install

```sh
npx @phantomid/mcp-server
```

For MCP clients, configure the server command and environment:

```json
{
  "mcpServers": {
    "phantom-id": {
      "command": "npx",
      "args": ["@phantomid/mcp-server"],
      "env": {
        "PHANTOM_API_URL": "https://pay.idphantom.com",
        "PHANTOM_API_KEY": "pk_live_..."
      }
    }
  }
}
```

`PHANTOM_API_URL` is optional when using production. `PHANTOM_API_KEY` is required for normal paid API usage after registration.

### Self-serve tools environment (AGP-100)

The MCP tools `phantom_register` and `phantom_authorize_budget` read their
signing keys **only from the environment** (never from command-line flags —
argv leaks into shell history and process listings):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PHANTOM_PAYER_PRIVATE_KEY` | `phantom_register` (auto mode) | Pays the $2 USDC registration; signs locally, never leaves the process. |
| `PHANTOM_FUNDER_PRIVATE_KEY` | `phantom_authorize_budget` | Human funder's key for the EIP-712 `AgentWalletAuthorization`. |
| `PHANTOM_ROUTER_ADDRESS` | both | `PhantomRouter` verifying contract of the EIP-712 domain. |
| `PHANTOM_FUNNEL_SOURCE` | funnel | `internal` for dogfood/QA traffic (reported separately — wash volume prohibited); default `external`. |

Without `PHANTOM_PAYER_PRIVATE_KEY`, `phantom_register` runs in manual mode:
pass `payer_wallet` and it returns the registration challenge plus
step-by-step signing instructions.

### Funnel events (AGP-100 F1.4)

The server emits one JSON line per event on stderr, prefixed with `[funnel]`:

```text
[funnel] {"event":"install","ts":"...","source":"external",...}
```

Events: `install` → `register_start` → `register_complete` → `first_pay` →
`repeat`. Scrape these lines to build the onboarding funnel
(install → register → first pay → repeat). Traffic tagged
`PHANTOM_FUNNEL_SOURCE=internal` must be aggregated separately from external
volume.

## Connect Your Agent In 5 Minutes

Registration is self-serve and costs **$2 USDC** on Base mainnet. The CLI signs locally and never prints the private key.

```sh
export PHANTOM_PAYER_PRIVATE_KEY="0x..."
export PHANTOM_ROUTER_ADDRESS="0x..."
npx @phantomid/mcp-server init --name my-agent
```

The init flow calls:

1. `POST /v1/register`
2. `POST /v1/intents/:id/authorize`
3. `POST /v1/intents/:id/submit`
4. `GET /v1/register/:reference`
5. `POST /v1/register/:reference/claim`

On success it prints the account id and the API key once. Store the returned key as `PHANTOM_API_KEY`.

Flags are supported for non-sensitive options. The payer key is environment-only
(never a flag — command lines leak into shell history and process listings):

```sh
export PHANTOM_PAYER_PRIVATE_KEY="0x..."
npx @phantomid/mcp-server init \
  --api-url https://pay.idphantom.com \
  --router-address 0x... \
  --name my-agent
```

## Tools

The server supports newline-delimited JSON-RPC over stdio.

### `quote_payment`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "quote_payment",
    "arguments": {
      "payer_wallet": "0x...",
      "recipient_wallet": "0x...",
      "asset_contract": "0x...",
      "amount": "1000000",
      "chain_id": 8453,
      "idempotency_key": "quote-001",
      "payer_agent_id": "buyer-agent",
      "recipient_agent_id": "seller-agent"
    }
  }
}
```

### `authorize_payment`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "authorize_payment",
    "arguments": {
      "payment_intent_id": "pi_...",
      "payer_signature": "0x..."
    }
  }
}
```

### `submit_payment`

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "submit_payment",
    "arguments": {
      "payment_intent_id": "pi_..."
    }
  }
}
```

### `verify_payment`

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "verify_payment",
    "arguments": {
      "payment_intent_id": "pi_...",
      "receipt_id": "rcpt_..."
    }
  }
}
```

## Limits

Default production policy limits are:

- **50 USD maximum per payment**
- **500 USD maximum per day**

Payments above those limits are rejected by the PHANTOM ID API.

## Publish

```sh
npm publish --access public
```
