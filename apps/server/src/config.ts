import { ARBITRUM_SEPOLIA, ARBITRUM_SEPOLIA_USDC, type Address, MAX_AUTHORIZATION_SECONDS, MAX_OFFER_TTL_SECONDS, toAddress } from "@lemma/core";
import { z } from "zod";

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

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: optional(z.string().min(1)),
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
});

export interface ServerConfig {
  readonly env: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string | undefined;
  /** Offer terms: CAIP-2 network, USDC asset and authorization window. */
  readonly payment: { readonly network: typeof ARBITRUM_SEPOLIA; readonly asset: Address; readonly maxTimeoutSeconds: number };
  /** The only x402 recipient the server will quote for (server README). */
  readonly provider: Address | undefined;
  readonly paidTools: boolean;
  /** Load the testnet-only provisional overlay. Never set on the public deployment. */
  readonly allowProvisionalEvidence: boolean;
  readonly offerTtlSeconds: number;
  readonly dashboardOrigin: string | undefined;
  /** How many proxies in front of the server append to X-Forwarded-For (Railway: 1). */
  readonly trustedProxyHops: number;
  readonly rateLimitPerMinute: number;
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
  if (e.PAID_TOOLS === "on" && e.PROVIDER_ADDRESS === undefined) throw new ConfigError("PAID_TOOLS=on requires PROVIDER_ADDRESS");
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    payment: { network: ARBITRUM_SEPOLIA, asset, maxTimeoutSeconds: e.PAYMENT_TIMEOUT_SECONDS },
    provider: e.PROVIDER_ADDRESS,
    paidTools: e.PAID_TOOLS === "on",
    allowProvisionalEvidence: e.ALLOW_PROVISIONAL_EVIDENCE ?? false,
    offerTtlSeconds: e.OFFER_TTL_SECONDS,
    dashboardOrigin: e.DASHBOARD_ORIGIN === undefined ? undefined : new URL(e.DASHBOARD_ORIGIN).origin,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}
