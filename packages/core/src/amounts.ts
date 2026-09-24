import { z } from "zod";

export const USDC_DECIMALS = 6;

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Largest amount any Lemma object may carry: the uint256 bound of the settlement contracts. */
export const MAX_ATOMIC = 2n ** 256n - 1n;

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * USDC amount in atomic units (1 USDC = 1_000_000) as a decimal-integer
 * string. Strings keep amounts exact through JSON, canonical hashing and x402
 * (`PaymentRequirements.amount` uses the same form). Values fit in uint256; store
 * them in Postgres as numeric(78, 0).
 */
export const UsdcAtomic = z
  .string()
  .max(78)
  .regex(DECIMAL_INTEGER, "expected a non-negative integer amount in atomic USDC units")
  .refine((s) => !DECIMAL_INTEGER.test(s) || BigInt(s) <= MAX_ATOMIC, "amount exceeds uint256");

export type UsdcAtomic = z.infer<typeof UsdcAtomic>;

/**
 * Converts a string to atomic units when it is a valid UsdcAtomic, else returns
 * null. Refinements use this so that malformed input fails validation instead of
 * throwing from `BigInt`.
 */
export function atomicOrNull(value: unknown): bigint | null {
  return typeof value === "string" && UsdcAtomic.safeParse(value).success ? BigInt(value) : null;
}

/** Parses a human decimal amount such as `"1.25"` into atomic units. */
export function parseUsdc(decimal: string): bigint {
  const match = /^(0|[1-9][0-9]{0,71})(?:\.([0-9]{1,6}))?$/.exec(decimal);
  if (!match) throw new RangeError(`invalid USDC amount: ${JSON.stringify(decimal)}`);
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  const atomic = whole * SCALE + fraction;
  if (atomic > MAX_ATOMIC) throw new RangeError("USDC amount exceeds uint256");
  return atomic;
}

/** Formats atomic units as a human decimal amount without trailing zeros. */
export function formatUsdc(atomic: bigint): string {
  if (atomic < 0n) throw new RangeError("USDC amounts are never negative");
  const whole = atomic / SCALE;
  const fraction = (atomic % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function toAtomic(value: UsdcAtomic): bigint {
  return BigInt(UsdcAtomic.parse(value));
}

export function fromAtomic(atomic: bigint): UsdcAtomic {
  if (atomic < 0n) throw new RangeError("USDC amounts are never negative");
  if (atomic > MAX_ATOMIC) throw new RangeError("USDC amount exceeds uint256");
  return atomic.toString();
}
