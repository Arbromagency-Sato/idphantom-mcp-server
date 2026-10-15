import { ethers, type TypedDataField } from "ethers";
import { phantomPayDomain, requestJson, jsonHeaders } from "./register";

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

/** 1 USDC = 6 decimales (unidades enteras, como espera la API en max_units). */
export const USDC_UNITS = 1_000_000n;

/** Plantillas de política (AGP-100 F1.3): caps de piloto deliberadamente
 *  bajos; el funder humano puede siempre fijar valores custom más ajustados.
 *  Las plantillas describen intención en lenguaje natural; los números son
 *  límites máximos, no objetivos de gasto. */
export const POLICY_TEMPLATES = {
  /** "micro": pruebas y un solo servicio pequeño. */
  micro: {
    description: "Pruebas y un solo servicio pequeño (tope duro).",
    max_units: 1n * USDC_UNITS,
    daily_cap_units: 5n * USDC_UNITS,
    expires_in_days: 30,
  },
  /** "subscriptions": varios cobros recurrentes pequeños del mismo servicio. */
  subscriptions: {
    description: "Cobros recurrentes pequeños de un mismo servicio.",
    max_units: 2n * USDC_UNITS,
    daily_cap_units: 5n * USDC_UNITS,
    expires_in_days: 30,
  },
} as const;

export type PolicyTemplateName = keyof typeof POLICY_TEMPLATES | "custom";

export const AGENT_WALLET_AUTH_TYPES = {
  AgentWalletAuthorization: [
    { name: "accountId", type: "string" },
    { name: "funder", type: "address" },
    { name: "maxUnits", type: "uint256" },
    { name: "dailyCap", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
  ],
} satisfies Record<string, TypedDataField[]>;

export interface AuthorizeBudgetOptions {
  apiUrl: string;
  /** RW-2 (AGP-100): sin balance de cuenta, el caller autenticado debe ser la
   *  propia cuenta — por eso el default es la api_key configurada del MCP. */
  apiKey?: string;
  funderPrivateKey: string;
  routerAddress: string;
  chainId?: number;
  accountId: string;
  template?: PolicyTemplateName;
  maxUnits?: bigint;
  dailyCapUnits?: bigint | null;
  expiresInDays?: number;
  nonce?: bigint;
  fetchImpl?: FetchLike;
  now?: Date;
}

export interface AuthorizeBudgetResult {
  account_id: string;
  funder_wallet: string;
  max_units: string;
  daily_cap_units: string | null;
  expires_at: string;
  nonce: string;
  signature: string;
  api_response: unknown;
}

/** Resuelve caps: args explícitos > plantilla > defaults micro. Devuelve
 *  también los nombres de los campos que faltaron cuando no se puede resolver. */
export function resolvePolicyCaps(options: {
  template?: PolicyTemplateName;
  maxUnits?: bigint;
  dailyCapUnits?: bigint | null;
  expiresInDays?: number;
}): { maxUnits: bigint; dailyCapUnits: bigint | null; expiresInDays: number; template: PolicyTemplateName } {
  const templateName: PolicyTemplateName = options.template ?? (options.maxUnits !== undefined ? "custom" : "micro");
  const base = templateName === "custom" ? null : POLICY_TEMPLATES[templateName];
  const maxUnits = options.maxUnits ?? base?.max_units;
  if (maxUnits === undefined || maxUnits <= 0n) {
    throw new Error("max_units must be a positive integer (units, 6 decimals: 1000000 = $1 USDC)");
  }
  const dailyCapUnits = options.dailyCapUnits !== undefined ? options.dailyCapUnits : (base?.daily_cap_units ?? null);
  if (dailyCapUnits !== null && dailyCapUnits <= 0n) {
    throw new Error("daily_cap_units must be positive when provided");
  }
  const expiresInDays = options.expiresInDays ?? base?.expires_in_days ?? 30;
  if (!Number.isInteger(expiresInDays) || expiresInDays <= 0 || expiresInDays > 365) {
    throw new Error("expires_in_days must be an integer between 1 and 365");
  }
  return { maxUnits, dailyCapUnits, expiresInDays, template: templateName };
}

/** phantom_authorize_budget (AGP-100 F1.2): firma EIP-712
 *  AgentWalletAuthorization con la clave del funder (SOLO env
 *  PHANTOM_FUNDER_PRIVATE_KEY, nunca argv — AGP-057) y la envía a
 *  POST /v1/agent-wallet/authorize. La firma se produce localmente. */
export async function authorizeBudget(options: AuthorizeBudgetOptions): Promise<AuthorizeBudgetResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const chainId = options.chainId ?? 8453;
  if (!options.routerAddress || !ethers.isAddress(options.routerAddress)) {
    throw new Error("PHANTOM_ROUTER_ADDRESS is required (valid EVM address) to sign the budget authorization");
  }
  if (!options.accountId || typeof options.accountId !== "string") {
    throw new Error("account_id is required (the account that will spend the budget)");
  }
  const { maxUnits, dailyCapUnits, expiresInDays } = resolvePolicyCaps(options);
  const wallet = new ethers.Wallet(options.funderPrivateKey);
  const nonce = options.nonce ?? BigInt(Date.now());
  const now = options.now ?? new Date();
  const expiresAtMs = now.getTime() + expiresInDays * 24 * 60 * 60 * 1000;
  const expiresAt = Math.floor(expiresAtMs / 1000);

  const authValue = {
    accountId: options.accountId,
    funder: wallet.address,
    maxUnits: maxUnits.toString(),
    dailyCap: (dailyCapUnits ?? 0n).toString(),
    nonce: nonce.toString(),
    expiresAt,
  };
  const signature = await wallet.signTypedData(
    phantomPayDomain(chainId, options.routerAddress),
    AGENT_WALLET_AUTH_TYPES,
    authValue
  );

  const body = {
    account_id: options.accountId,
    funder_wallet: wallet.address,
    max_units: maxUnits.toString(),
    ...(dailyCapUnits !== null ? { daily_cap_units: dailyCapUnits.toString() } : {}),
    nonce: nonce.toString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    signature,
  };
  const apiResponse = await requestJson<unknown>(
    fetchImpl,
    `${options.apiUrl.replace(/\/+$/, "")}/v1/agent-wallet/authorize`,
    { method: "POST", headers: jsonHeaders(options.apiKey), body: JSON.stringify(body) }
  );

  return {
    account_id: options.accountId,
    funder_wallet: wallet.address,
    max_units: maxUnits.toString(),
    daily_cap_units: dailyCapUnits !== null ? dailyCapUnits.toString() : null,
    expires_at: new Date(expiresAtMs).toISOString(),
    nonce: nonce.toString(),
    signature,
    api_response: apiResponse,
  };
}
