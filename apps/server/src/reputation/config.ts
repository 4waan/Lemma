import { inspect } from "node:util";

import { type Address, AgentId, toAddress } from "@lemma/core";
import { type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { ERC8004_ARBITRUM_SEPOLIA } from "./abi.js";
import { DEFAULT_LOG_RANGE } from "./chain.js";

/**
 * A private key that never prints: not through JSON, string conversion or
 * `util.inspect`, so a config object that reaches a log leaks nothing.
 */
export class SecretKey {
  readonly #value: Hex;

  constructor(value: Hex) {
    this.#value = value;
  }

  /** The key itself, for the one place that signs with it. */
  reveal(): Hex {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "SecretKey([redacted])";
  }
}

/**
 * ERC-8004 reputation settings. Everything is optional: with none of it set,
 * reputation is off and nothing else changes.
 *
 * - `publicBaseUrl` alone serves the registration file (with no registration
 *   until `agentId` is set, which the register script prints).
 * - `attester` (the key, the RPC URL, the provider's agent id and the public
 *   base URL together, with a database) turns on the attester job and the
 *   cached summaries.
 */
export interface ReputationConfig {
  /** The server's public origin and path prefix, without a trailing slash (`PUBLIC_BASE_URL`). */
  readonly publicBaseUrl: string | undefined;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  /** The provider's ERC-8004 agent id (`LEMMA_AGENT_ID`). */
  readonly agentId: AgentId | undefined;
  /** The widest block range the attester's log search asks of the RPC at once (`ERC8004_LOG_RANGE`); a number, so the config stays JSON. */
  readonly logRange: number;
  readonly attester:
    | {
        readonly rpcUrl: string;
        readonly key: SecretKey;
        /** The attester's address: the one reviewer every summary counts. */
        readonly address: Address;
      }
    | undefined;
}

// `.env.example` leaves unset values empty; treat them as absent.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const AddressInput = z.string().transform((value, ctx) => {
  try {
    return toAddress(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "expected an EVM address with a valid checksum" });
    return z.NEVER;
  }
});

/** http(s) URLs only. RPC URLs often carry an API key, so no message repeats the value. */
const HttpUrl = z.string().refine((value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}, "expected an http(s) URL; its value is not shown");

/** The public base URL: http(s), no credentials, query or fragment, since paths are appended to it. */
const BaseUrl = HttpUrl.refine((value) => {
  const url = new URL(value);
  return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}, "expected a base URL without credentials, query or fragment");

/** A block count for `eth_getLogs`: a whole number from 1 to 1,000,000, written plainly. */
const LogRange = z
  .string()
  .regex(/^[1-9][0-9]{0,6}$/, "expected a whole number of blocks from 1 to 1000000")
  .transform((value) => Number(value))
  .refine((value) => value <= 1_000_000, "expected a whole number of blocks from 1 to 1000000");

const PrivateKey = z
  .string()
  .refine((value) => isHex(value, { strict: true }) && value.length === 66, "expected 0x followed by 64 hex characters; its value is not shown")
  .refine((value) => {
    try {
      privateKeyToAccount(value as Hex);
      return true;
    } catch {
      return false;
    }
  }, "is not a valid secp256k1 private key; its value is not shown");

const Env = z.object({
  PUBLIC_BASE_URL: optional(BaseUrl),
  ARBITRUM_SEPOLIA_RPC_URL: optional(HttpUrl),
  ERC8004_IDENTITY_REGISTRY: optional(AddressInput),
  ERC8004_REPUTATION_REGISTRY: optional(AddressInput),
  LEMMA_AGENT_ID: optional(AgentId),
  ATTESTER_PRIVATE_KEY: optional(PrivateKey),
  ERC8004_LOG_RANGE: optional(LogRange),
  // Only whether it is set: the server's own config checks its value.
  DATABASE_URL: optional(z.string()),
});

/**
 * A private key from the environment variable `name`, checked the same way as
 * the attester's; the error names the variable, never the value.
 */
export function privateKeyFrom(value: string | undefined, name: string): Hex {
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  const parsed = PrivateKey.safeParse(value);
  if (!parsed.success) throw new Error(`${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data as Hex;
}

/**
 * What the attester needs besides its key. A database among them: its ledger
 * must outlive a restart, because a restarted attester reads the outcome feed
 * from the start and, on the in-memory store, would post every outcome again.
 */
const ATTESTER_NEEDS = ["ARBITRUM_SEPOLIA_RPC_URL", "DATABASE_URL", "LEMMA_AGENT_ID", "PUBLIC_BASE_URL"] as const;

/**
 * Reads the reputation settings. Throws an Error whose message names the
 * variable and the problem, never a value: an invalid key or RPC URL is never
 * repeated. A set `ATTESTER_PRIVATE_KEY` without the rest of what the attester
 * needs is refused rather than silently ignored.
 */
export function loadReputationConfig(env: Record<string, string | undefined>): ReputationConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // zod issues carry the path and our messages only, never the input.
    throw new Error(`invalid reputation settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  let attester: ReputationConfig["attester"];
  if (e.ATTESTER_PRIVATE_KEY !== undefined) {
    const missing = ATTESTER_NEEDS.filter((name) => e[name] === undefined);
    if (missing.length > 0) {
      const why = missing.includes("DATABASE_URL") ? " (a database, because its ledger must outlive a restart: on the in-memory store a restarted attester would post every outcome again)" : "";
      throw new Error(`ATTESTER_PRIVATE_KEY is set, so the attester also needs ${missing.join(", ")}${why}`);
    }
    // Feedback URIs are published on chain for good: a plain-http or local address there could never be corrected.
    if (new URL(e.PUBLIC_BASE_URL as string).protocol !== "https:") throw new Error("the attester publishes evidence URLs on chain, so PUBLIC_BASE_URL must be https");
    const key = e.ATTESTER_PRIVATE_KEY as Hex;
    attester = { rpcUrl: e.ARBITRUM_SEPOLIA_RPC_URL as string, key: new SecretKey(key), address: toAddress(privateKeyToAccount(key).address) };
  }
  return {
    publicBaseUrl: e.PUBLIC_BASE_URL === undefined ? undefined : e.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    identityRegistry: e.ERC8004_IDENTITY_REGISTRY ?? ERC8004_ARBITRUM_SEPOLIA.identityRegistry,
    reputationRegistry: e.ERC8004_REPUTATION_REGISTRY ?? ERC8004_ARBITRUM_SEPOLIA.reputationRegistry,
    agentId: e.LEMMA_AGENT_ID,
    logRange: e.ERC8004_LOG_RANGE ?? Number(DEFAULT_LOG_RANGE),
    attester,
  };
}

/** Reputation with nothing configured. */
export const REPUTATION_OFF: ReputationConfig = {
  publicBaseUrl: undefined,
  identityRegistry: ERC8004_ARBITRUM_SEPOLIA.identityRegistry,
  reputationRegistry: ERC8004_ARBITRUM_SEPOLIA.reputationRegistry,
  agentId: undefined,
  logRange: Number(DEFAULT_LOG_RANGE),
  attester: undefined,
};
