import { canonicalizeEx } from "json-canonicalize";
import { keccak256, stringToBytes, type Hex } from "viem";
import type { z } from "zod";

/**
 * Domain-separation labels for `digest`. A value hashed under one kind can
 * never produce the digest of another kind. Every kind used anywhere in Lemma,
 * including the payment and contract work, is registered here.
 */
export const DIGEST_KINDS = [
  "repository-profile",
  "task-request",
  "capability-release",
  "catalog",
  "preview",
  "resolution",
  "resolution-id",
  "adoption-receipt",
  "patch-bundle",
  "run-record",
  "run-set",
] as const;

export type DigestKind = (typeof DIGEST_KINDS)[number];

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function assertWellFormed(s: string, path: string): void {
  if (LONE_SURROGATE.test(s)) throw new TypeError(`${path}: lone UTF-16 surrogate is not valid JSON text (RFC 8785 3.2.2.2)`);
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
      assertWellFormed(value, path);
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number is not JSON`);
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new TypeError(`${path}: integer outside the safe range; encode it as a decimal string`);
      }
      return;
    case "bigint":
      throw new TypeError(`${path}: bigint is not JSON; encode amounts as decimal strings`);
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new TypeError(`${path}[${i}]: sparse array hole is not JSON`);
          assertJsonValue(value[i], `${path}[${i}]`);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${path}: only plain objects are JSON`);
      }
      for (const [key, item] of Object.entries(value)) {
        assertWellFormed(key, `${path} key`);
        if (key === "toJSON") throw new TypeError(`${path}: a "toJSON" key changes serialization and is not allowed`);
        assertJsonValue(item, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new TypeError(`${path}: ${typeof value} is not JSON`);
  }
}

/**
 * RFC 8785 (JCS) canonical JSON. Rejects anything outside the I-JSON data
 * model instead of silently dropping or converting it.
 */
export function canonicalize(value: unknown): string {
  assertJsonValue(value, "$");
  return canonicalizeEx(value, { strictUndefined: true });
}

/**
 * keccak256 over the UTF-8 bytes of the canonical envelope `{ kind, value }`.
 * The value carries its own `schemaVersion`, so a version change of one kind
 * never changes the digests of another. Only hash values that have already been
 * parsed by their schema; prefer the typed helpers such as `digestOf`.
 */
export function digest(kind: DigestKind, value: unknown): Hex {
  if (!(DIGEST_KINDS as readonly string[]).includes(kind)) throw new TypeError(`unknown digest kind: ${String(kind)}`);
  return keccak256(stringToBytes(canonicalize({ kind, value })));
}

/** Parses `value` with `schema` (rejecting anything invalid), then digests the parsed value. */
export function digestOf<S extends z.ZodType>(kind: DigestKind, schema: S, value: z.input<S>): Hex {
  return digest(kind, schema.parse(value));
}
