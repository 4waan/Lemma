import { ARBITRUM_SEPOLIA, type CapabilityId, type ReasonCode, formatUsdc } from "@lemma/core";

/** An atomic USDC string as an exact amount with at least two decimals, and its unit. */
export function usdc(atomic: string): string {
  return `${usdcAmount(BigInt(atomic))} USDC`;
}

/** Basis points as a percentage with two decimals, in integer math. */
export function percent(bps: string | bigint): string {
  const value = BigInt(bps);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")} %`;
}

export function shortHex(hex: string): string {
  return hex.length <= 14 ? hex : `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

export function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function networkName(caip2: string): string {
  return caip2 === ARBITRUM_SEPOLIA ? "Arbitrum Sepolia (testnet)" : caip2;
}

/** Plain words for each reason code; the codes come from core, the words from here. */
export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  DEPENDENCY_OUT_OF_RANGE: "a dependency version outside the supported range",
  EVIDENCE_STALE: "benchmark evidence is stale",
  MISSING_DEPENDENCY: "a required dependency is missing",
  MISSING_FRAMEWORK: "a required framework is missing",
  NO_RELEASE_FOR_CAPABILITY: "no release exists for this capability yet",
  PRICE_EXCEEDS_SAVING_RULE: "the price exceeds 30% of the measured saving",
  PROFILE_NOT_BENCHMARKED: "no frozen benchmark supports this profile",
  RELEASE_EXPIRED: "the release has expired",
  UNSUPPORTED_LANGUAGE: "unsupported language",
  UNSUPPORTED_MODULE_SYSTEM: "unsupported module system",
  UNSUPPORTED_PACKAGE_MANAGER: "unsupported package manager",
  UNSUPPORTED_RUNTIME: "unsupported Node version",
};

export function reasonText(code: string): string {
  return (REASON_TEXT as Readonly<Record<string, string>>)[code] ?? code;
}

/**
 * Atomic USDC as an exact decimal with at least two places ("2.50", "0.005"),
 * for columns and charts where amounts are compared. Never rounds.
 */
export function usdcAmount(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const text = formatUsdc(atomic < 0n ? -atomic : atomic);
  const [whole, fraction = ""] = text.split(".");
  return `${sign}${whole}.${fraction.padEnd(2, "0")}`;
}

/** Plain words for each capability id; the ids come from core. */
export const CAPABILITY_TEXT: Readonly<Record<CapabilityId, string>> = {
  "mcp-server.add-payment-gating": "x402 payment gating for a TypeScript MCP server",
  "mcp-client.add-paying-client": "An x402-paying MCP client with spending limits",
  "node-service.add-payment-facilitator": "An Arbitrum x402 facilitator for a Node service",
};
