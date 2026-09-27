import { ARBITRUM_SEPOLIA, ARBITRUM_SEPOLIA_USDC, type Address, MAX_AUTHORIZATION_SECONDS, MAX_OFFER_TTL_SECONDS, toAddress } from "@lemma/core";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { type ReputationConfig, loadReputationConfig } from "./reputation/config.js";
import { INDEXER_CONFIRMATIONS } from "./warranty/indexer.js";

// `.env.example` leaves unset values empty (`PROVIDER_ADDRESS=`); treat them as absent.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const AddressInput = z.string().transform((value, ctx) => {
  try {
    return toAddress(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "expected an EVM address with a valid checksum" });
    return z.NEVER;
  }
});

const Flag = z.enum(["true", "false"]).transform((v) => v === "true");

/**
 * A postgres:// or postgresql:// connection string. postgres.js parses the
 * rest itself (multi-host lists, host-less URLs that use PGHOST or a unix
 * socket), so only the scheme is checked here. The message never repeats the
 * value: it usually holds a password.
 */
export function isPostgresUrl(value: string): boolean {
  return /^postgres(?:ql)?:\/\//.test(value);
}

const DatabaseUrl = z.string().refine(isPostgresUrl, "must be a postgres:// or postgresql:// URL; its value is not shown");

/** At least 32 characters: the key that hides client addresses in demand counts (never stored in the database). */
const SourceKey = z.string().min(32, "must be at least 32 characters; its value is not shown");

/**
 * A value that must never reach a log, an error message or an API answer: a
 * private key, or an RPC URL (providers put their API key in the path). It
 * prints and serializes as a placeholder; only `reveal()` gives the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }

  toJSON(): string {
    return "[secret]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Secret([secret])";
  }
}

/** An http(s) URL. Checked without echoing it: an RPC URL often carries the provider's key. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const RpcUrl = z.string().refine(isHttpUrl, "must be an http(s) URL; its value is not shown");

/** The block explorer the dashboard links to when `EXPLORER_BASE_URL` is unset: Arbiscan's for Arbitrum Sepolia, the only chain. */
export const DEFAULT_EXPLORER_BASE_URL = "https://sepolia.arbiscan.io";

/**
 * `EXPLORER_BASE_URL`: unset means the default explorer, empty turns explorer
 * links off, and anything else must be an http(s) base URL without
 * credentials, query or fragment (paths such as `/tx/<hash>` are appended).
 * Unlike every other variable, empty is not the same as unset here.
 */
const ExplorerBaseUrl = z
  .string()
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    } catch {
      return false;
    }
  }, "must be an http(s) base URL without credentials, query or fragment, or empty to turn explorer links off")
  .optional();

/** 0x and 64 hex digits, a valid secp256k1 key (checked in loadConfig). The message never repeats the value. */
const PrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex digits; its value is not shown");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: optional(DatabaseUrl),
  DEMAND_SOURCE_KEY: optional(SourceKey),
  ARBITRUM_SEPOLIA_RPC_URL: optional(RpcUrl),
  FACILITATOR_PRIVATE_KEY: optional(PrivateKey),
  ARBITRUM_SEPOLIA_CHAIN_ID: z.coerce.number().int().default(421_614),
  USDC_ADDRESS: optional(AddressInput),
  PROVIDER_ADDRESS: optional(AddressInput),
  PAID_TOOLS: z.enum(["on", "off"]).default("off"),
  ALLOW_PROVISIONAL_EVIDENCE: optional(Flag),
  OFFER_TTL_SECONDS: z.coerce.number().int().min(60).max(MAX_OFFER_TTL_SECONDS).default(900),
  PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(MAX_AUTHORIZATION_SECONDS).default(300),
  DASHBOARD_ORIGIN: optional(z.url({ protocol: /^https?$/ })),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  EXPLORER_BASE_URL: ExplorerBaseUrl,
  // The warranty pipeline (WarrantyConfig).
  RESOLUTION_WARRANTY_REGISTRY_ADDRESS: optional(AddressInput),
  PROVIDER_PRIVATE_KEY: optional(PrivateKey),
  EVALUATOR_PRIVATE_KEY: optional(PrivateKey),
  WARRANTY_REGISTRY_START_BLOCK: optional(z.string().regex(/^(0|[1-9][0-9]{0,18})$/, "expected a block number")),
  EVALUATOR_FAILURES: optional(z.enum(["review", "auto"])),
  WARRANTY_ACTIVATION_JITTER_SECONDS: optional(z.coerce.number().int().min(0).max(86_400)),
  WARRANTY_INDEXER_CONFIRMATIONS: optional(z.string().regex(/^(0|[1-9][0-9]{0,5})$/, "expected a number of blocks, 0 to 999999")),
});

/**
 * The warranty pipeline's settings (apps/server/src/warranty): on only with
 * all of the registry address, the provider's and the evaluator's keys,
 * `PAID_TOOLS=on`, `ARBITRUM_SEPOLIA_RPC_URL` and `DATABASE_URL`.
 */
export interface WarrantyConfig {
  /** `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`. */
  readonly registry: Address;
  /** `WARRANTY_REGISTRY_START_BLOCK`: the registry's deployment block, where the indexer starts (default 0). */
  readonly startBlock: bigint;
  /** `PROVIDER_PRIVATE_KEY`: signs vouchers, sends activations and expiries. */
  readonly providerKey: Secret;
  readonly providerAddress: Address;
  /** `EVALUATOR_PRIVATE_KEY`: signs outcomes, sends finalizations and credit withdrawals. */
  readonly evaluatorKey: Secret;
  readonly evaluatorAddress: Address;
  /** `EVALUATOR_FAILURES`: `review` (default: an operator decides each failed outcome) or `auto`. */
  readonly failures: "review" | "auto";
  /** `WARRANTY_ACTIVATION_JITTER_SECONDS` (default 300; 0 for tests and local runs). */
  readonly activationJitterSeconds: number;
  /** `WARRANTY_INDEXER_CONFIRMATIONS`: how many blocks behind the latest one the indexer stops (default 64). */
  readonly indexerConfirmations: bigint;
}

/** The variables that turn the warranty pipeline on: setting any of them asks for all it needs. */
const WARRANTY_SWITCHES = ["RESOLUTION_WARRANTY_REGISTRY_ADDRESS", "PROVIDER_PRIVATE_KEY", "EVALUATOR_PRIVATE_KEY", "WARRANTY_REGISTRY_START_BLOCK"] as const;

/** The address of a private key from variable `name`; the error names the variable, never the value. */
function addressOfKey(key: string, name: string): Address {
  try {
    return toAddress(privateKeyToAccount(key as Hex).address);
  } catch {
    // Never the library's message: it could quote the key.
    throw new ConfigError(`${name} is not a valid secp256k1 private key; its value is not shown`);
  }
}

export interface ServerConfig {
  readonly env: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string | undefined;
  /**
   * The HMAC key for client addresses in demand counts. It must stay the same
   * across restarts and replicas, or one address counts as several sources; a
   * random per-process key is used in development.
   */
  readonly demandSourceKey: Uint8Array | undefined;
  /** Offer terms: CAIP-2 network, USDC asset and authorization window. */
  readonly payment: { readonly network: typeof ARBITRUM_SEPOLIA; readonly asset: Address; readonly maxTimeoutSeconds: number };
  /** The only x402 recipient the server will quote for (server README). */
  readonly provider: Address | undefined;
  readonly paidTools: boolean;
  /**
   * The payment path's chain access: the Arbitrum Sepolia RPC (settlement,
   * reconciliation, receipt signatures) and the in-process facilitator's key,
   * which pays settlement gas. Both are required with paid tools on, and both
   * are secrets: an RPC URL often carries the provider's API key.
   */
  readonly chain: { readonly rpcUrl: Secret | undefined; readonly facilitatorKey: Secret | undefined; readonly facilitatorAddress: Address | undefined };
  /** Load the testnet-only provisional overlay. Never set on the public deployment. */
  readonly allowProvisionalEvidence: boolean;
  readonly offerTtlSeconds: number;
  readonly dashboardOrigin: string | undefined;
  /** How many proxies in front of the server append to X-Forwarded-For (Railway: 1). */
  readonly trustedProxyHops: number;
  readonly rateLimitPerMinute: number;
  /** ERC-8004 reputation (src/reputation/config.ts); all optional, off when unset. */
  readonly reputation: ReputationConfig;
  /**
   * The block explorer's base URL, without a trailing slash, for the
   * dashboard's links (`StatusView.chain.explorer`); null turns them off
   * (`EXPLORER_BASE_URL` set empty). Default `DEFAULT_EXPLORER_BASE_URL`.
   */
  readonly explorerBaseUrl: string | null;
  /** The warranty pipeline's settings, or undefined while it is off (none of its variables set). */
  readonly warranty: WarrantyConfig | undefined;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Validates the environment once at startup. Bounds come from core, so the
 * server can never quote an offer window or an authorization longer than the
 * schemas accept. The chain and asset are fixed to Arbitrum Sepolia USDC; a
 * different value is a misconfiguration, not an option.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  if (e.ARBITRUM_SEPOLIA_CHAIN_ID !== 421_614) throw new ConfigError("ARBITRUM_SEPOLIA_CHAIN_ID must be 421614");
  const asset = e.USDC_ADDRESS ?? ARBITRUM_SEPOLIA_USDC;
  if (asset !== ARBITRUM_SEPOLIA_USDC) throw new ConfigError(`USDC_ADDRESS must be Arbitrum Sepolia USDC (${ARBITRUM_SEPOLIA_USDC})`);
  if (e.NODE_ENV === "production" && e.DATABASE_URL === undefined) throw new ConfigError("DATABASE_URL is required in production");
  if (e.NODE_ENV === "production" && e.DEMAND_SOURCE_KEY === undefined) throw new ConfigError("DEMAND_SOURCE_KEY is required in production");
  if (e.PAID_TOOLS === "on" && e.PROVIDER_ADDRESS === undefined) throw new ConfigError("PAID_TOOLS=on requires PROVIDER_ADDRESS");
  if (e.PAID_TOOLS === "on" && e.FACILITATOR_PRIVATE_KEY === undefined) throw new ConfigError("PAID_TOOLS=on requires FACILITATOR_PRIVATE_KEY (the key that pays settlement gas)");
  if (e.PAID_TOOLS === "on" && e.ARBITRUM_SEPOLIA_RPC_URL === undefined) throw new ConfigError("PAID_TOOLS=on requires ARBITRUM_SEPOLIA_RPC_URL");
  let facilitatorAddress: Address | undefined;
  if (e.FACILITATOR_PRIVATE_KEY !== undefined) {
    try {
      facilitatorAddress = toAddress(privateKeyToAccount(e.FACILITATOR_PRIVATE_KEY as Hex).address);
    } catch {
      // Never the library's message: it could quote the key.
      throw new ConfigError("FACILITATOR_PRIVATE_KEY is not a valid secp256k1 private key; its value is not shown");
    }
  }
  let reputation: ReputationConfig;
  try {
    reputation = loadReputationConfig(env);
  } catch (error) {
    // Its messages name variables and problems only, never a key or an RPC URL.
    throw new ConfigError(error instanceof Error ? error.message : "invalid reputation settings");
  }
  const warranty = warrantyConfig(e, facilitatorAddress, reputation);
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    demandSourceKey: e.DEMAND_SOURCE_KEY === undefined ? undefined : new TextEncoder().encode(e.DEMAND_SOURCE_KEY),
    payment: { network: ARBITRUM_SEPOLIA, asset, maxTimeoutSeconds: e.PAYMENT_TIMEOUT_SECONDS },
    provider: e.PROVIDER_ADDRESS,
    paidTools: e.PAID_TOOLS === "on",
    chain: {
      rpcUrl: e.ARBITRUM_SEPOLIA_RPC_URL === undefined ? undefined : new Secret(e.ARBITRUM_SEPOLIA_RPC_URL),
      facilitatorKey: e.FACILITATOR_PRIVATE_KEY === undefined ? undefined : new Secret(e.FACILITATOR_PRIVATE_KEY.toLowerCase()),
      facilitatorAddress,
    },
    allowProvisionalEvidence: e.ALLOW_PROVISIONAL_EVIDENCE ?? false,
    offerTtlSeconds: e.OFFER_TTL_SECONDS,
    dashboardOrigin: e.DASHBOARD_ORIGIN === undefined ? undefined : new URL(e.DASHBOARD_ORIGIN).origin,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    reputation,
    explorerBaseUrl: e.EXPLORER_BASE_URL === undefined ? DEFAULT_EXPLORER_BASE_URL : e.EXPLORER_BASE_URL === "" ? null : e.EXPLORER_BASE_URL.replace(/\/+$/, ""),
    warranty,
  };
}

/**
 * The warranty pipeline's settings. None of its variables set: off, and
 * nothing else changes. Any of them set: every one it needs must be too
 * (fail closed; the error names what is missing, never a value), and the
 * provider, evaluator, facilitator and attester (when set) must be four
 * different accounts: the registry refuses a provider that is its own
 * evaluator, and one sender's transaction order must never join a buyer's
 * settlement to the warranty it paid for.
 */
function warrantyConfig(e: z.infer<typeof Env>, facilitator: Address | undefined, reputation: ReputationConfig): WarrantyConfig | undefined {
  const switched = WARRANTY_SWITCHES.filter((name) => e[name] !== undefined);
  if (switched.length === 0) return undefined;
  const missing = [
    ...(e.PAID_TOOLS === "on" ? [] : ["PAID_TOOLS=on"]),
    ...(["RESOLUTION_WARRANTY_REGISTRY_ADDRESS", "PROVIDER_PRIVATE_KEY", "EVALUATOR_PRIVATE_KEY", "ARBITRUM_SEPOLIA_RPC_URL", "DATABASE_URL"] as const).filter((name) => e[name] === undefined),
  ];
  if (missing.length > 0) {
    throw new ConfigError(`the warranty pipeline is partly configured (${switched.join(", ")} set): it also needs ${missing.join(", ")}; set all of them, or none`);
  }
  const provider = addressOfKey(e.PROVIDER_PRIVATE_KEY as string, "PROVIDER_PRIVATE_KEY");
  const evaluator = addressOfKey(e.EVALUATOR_PRIVATE_KEY as string, "EVALUATOR_PRIVATE_KEY");
  const roles: Array<readonly [string, Address | undefined]> = [
    ["PROVIDER_PRIVATE_KEY", provider],
    ["EVALUATOR_PRIVATE_KEY", evaluator],
    ["FACILITATOR_PRIVATE_KEY", facilitator],
    ["ATTESTER_PRIVATE_KEY", reputation.attester?.address],
  ];
  for (const [i, [a, x]] of roles.entries()) {
    for (const [b, y] of roles.slice(i + 1)) {
      if (x !== undefined && x === y) throw new ConfigError(`${a} and ${b} are the same account: the provider, evaluator, facilitator and attester keys must all differ`);
    }
  }
  return {
    registry: e.RESOLUTION_WARRANTY_REGISTRY_ADDRESS as Address,
    startBlock: BigInt(e.WARRANTY_REGISTRY_START_BLOCK ?? "0"),
    providerKey: new Secret((e.PROVIDER_PRIVATE_KEY as string).toLowerCase()),
    providerAddress: provider,
    evaluatorKey: new Secret((e.EVALUATOR_PRIVATE_KEY as string).toLowerCase()),
    evaluatorAddress: evaluator,
    failures: e.EVALUATOR_FAILURES ?? "review",
    activationJitterSeconds: e.WARRANTY_ACTIVATION_JITTER_SECONDS ?? 300,
    indexerConfirmations: e.WARRANTY_INDEXER_CONFIRMATIONS === undefined ? INDEXER_CONFIRMATIONS : BigInt(e.WARRANTY_INDEXER_CONFIRMATIONS),
  };
}
