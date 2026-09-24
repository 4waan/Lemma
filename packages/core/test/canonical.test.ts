import { describe, expect, it } from "vitest";

import { DIGEST_KINDS, RepositoryProfile, canonicalize, digest, digestOf, profileDigest } from "../src/index.js";
import * as ex from "./examples.js";

describe("canonicalize", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [{ d: "x", c: null }] })).toBe('{"a":[{"c":null,"d":"x"}],"b":1}');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalize({ x: 1, y: { p: true, q: "s" } })).toBe(canonicalize({ y: { q: "s", p: true }, x: 1 }));
  });

  it("rejects values outside the I-JSON data model, at any depth", () => {
    expect(() => canonicalize({ amount: 1n })).toThrow(/bigint/);
    expect(() => canonicalize([1n])).toThrow(/bigint/);
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize([1, undefined])).toThrow();
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize([[Number.POSITIVE_INFINITY]])).toThrow(/non-finite/);
    expect(() => canonicalize({ a: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalize([new Date(0)])).toThrow(/plain objects/);
    expect(() => canonicalize({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalize([() => 1])).toThrow(/function/);
  });

  it("rejects inputs that would serialize ambiguously", () => {
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/surrogate/);
    expect(() => canonicalize({ ["\udc00"]: 1 })).toThrow(/surrogate/);
    expect(() => canonicalize({ n: 2 ** 53 })).toThrow(/safe range/);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point
    expect(() => canonicalize([1, , 3])).toThrow(/sparse/);
    expect(() => canonicalize({ toJSON: "x" })).toThrow(/toJSON/);
    expect(canonicalize({ s: "😀" })).toBe('{"s":"😀"}');
  });
});

describe("digest", () => {
  it("is a lowercase 32-byte hex keccak", () => {
    expect(digest("preview", { a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable across key order", () => {
    expect(digest("preview", { a: 1, b: 2 })).toBe(digest("preview", { b: 2, a: 1 }));
  });

  it("separates domains by kind", () => {
    const seen = new Set(DIGEST_KINDS.map((kind) => digest(kind, { a: 1 })));
    expect(seen.size).toBe(DIGEST_KINDS.length);
  });

  it("refuses unregistered kinds at runtime", () => {
    expect(() => digest("made-up" as never, { a: 1 })).toThrow(/unknown digest kind/);
  });

  it("typed helpers validate before hashing", () => {
    expect(profileDigest(ex.profile)).toBe(digest("repository-profile", ex.profile));
    expect(digestOf("repository-profile", RepositoryProfile, ex.profile)).toBe(profileDigest(ex.profile));
    expect(() => profileDigest({ ...ex.profile, frameworks: ["next", "hono"] })).toThrow();
  });
});
