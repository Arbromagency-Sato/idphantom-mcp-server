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

## Custom API endpoints (AGP-064)

By default the client only sends credentials to trusted IDPHANTOM origins
(`*.idphantom.com`, `localhost`, `127.0.0.1`). If you run a custom or
self-hosted endpoint, allow it explicitly:

```sh
export PHANTOM_ALLOW_CUSTOM_API_URL=1
```

or pass `--allow-custom-api-url`. Without the override, an untrusted
`PHANTOM_API_URL` is refused before any credential is transmitted.

## License

MIT — see [LICENSE](./LICENSE). The MIT License applies solely to the source
code contained in this repository and distributed as the
`@phantomid/mcp-server` connector. The IDPHANTOM hosted service, APIs, backend
infrastructure, payment engine, internal algorithms, transaction
orchestration, risk systems, databases and other server-side components are
separate proprietary systems and are not licensed under this repository's
MIT License. See [NOTICE](./NOTICE).
