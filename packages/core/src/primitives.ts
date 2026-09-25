import { getAddress, isAddress } from "viem";
import { z } from "zod";

import { hasLoneSurrogate } from "./canonical.js";

export const LEMMA_SCHEMA_VERSION = "1" as const;

/** Every signed, paid, or persisted Lemma object carries this literal. */
export const SchemaVersion = z.literal(LEMMA_SCHEMA_VERSION);

export const LEMMA_DECISIONS = ["reuse", "adapt", "build", "decline"] as const;

export type LemmaDecision = (typeof LEMMA_DECISIONS)[number];

/**
 * 32-byte hex value (digests, identifiers). Lowercase only, so the same value
 * always canonicalizes to the same bytes.
 */
export const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "expected lowercase 0x-prefixed 32-byte hex");

export type Hex32 = z.infer<typeof Hex32>;

/** EVM address. Lowercase only; normalize external input with `toAddress` first. */
export const Address = z.string().regex(/^0x[0-9a-f]{40}$/, "expected lowercase 0x-prefixed 20-byte address");

export type Address = z.infer<typeof Address>;

/**
 * Normalizes an address from an external source (x402 payloads, viem, user
 * config) into the lowercase form core schemas require. Throws on anything that
 * is not a valid address, including a mixed-case string with a bad checksum.
 */
export function toAddress(input: string): Address {
  if (!isAddress(input, { strict: true })) throw new TypeError(`invalid address: ${JSON.stringify(input)}`);
  return getAddress(input).toLowerCase();
}

/**
 * Signature bytes. EOA signatures are 65 bytes; smart-account signatures
 * (ERC-1271, ERC-6492 wrappers) are longer, and x402 accepts both.
 */
export const SignatureBytes = z
  .string()
  .max(2 + 2 * 4096)
  .regex(/^0x(?:[0-9a-f]{2}){65,}$/, "expected lowercase 0x-prefixed signature bytes (at least 65 bytes)");

/** CAIP-2 chain identifier restricted to EVM chains, for example `eip155:421614`. */
export const Caip2 = z.string().regex(/^eip155:[1-9][0-9]{0,11}$/, "expected an eip155 CAIP-2 chain id");

export const ARBITRUM_SEPOLIA = "eip155:421614" as const;

/** Circle USDC on Arbitrum Sepolia (x402's default asset for eip155:421614), lowercased. */
export const ARBITRUM_SEPOLIA_USDC = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d" as const;

/** EIP-712 domain fields of that USDC contract, used for EIP-3009 authorizations. */
export const USDC_EIP712_DOMAIN = { name: "USD Coin", version: "2" } as const;

/**
 * UTC timestamp with exactly millisecond precision and a `Z` suffix, the form
 * `Date.prototype.toISOString` produces. One instant has one string, so it has
 * one digest.
 */
export const IsoTimestamp = z.iso.datetime({ precision: 3 });

export function isoNow(date: Date = new Date()): string {
  return date.toISOString();
}

/** Exact semantic version, as resolved in a lockfile (semver 2.0.0 grammar). */
export const ExactVersion = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "expected an exact semantic version",
  );

/** npm package name, scoped or unscoped. */
export const PackageName = z
  .string()
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "expected an npm package name");

// C0/C1 controls, and bidirectional and zero-width formatting characters that can
// make reviewed text read differently from what it is.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/** Human-readable single-line text shown to reviewers and buyers. */
export function SafeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !UNSAFE_TEXT.test(s), "control, bidirectional and zero-width characters are not allowed")
    .refine((s) => !hasLoneSurrogate(s), "lone UTF-16 surrogates are not allowed")
    .refine((s) => s === s.trim(), "no leading or trailing whitespace");
}

/** True when a string array is strictly ascending, which also rules out duplicates. */
export function isSortedUnique(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if ((values[i - 1] as string) >= (values[i] as string)) return false;
  }
  return true;
}
