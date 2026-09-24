import { describe, expect, it } from "vitest";

import { MAX_ATOMIC, UsdcAtomic, atomicOrNull, formatUsdc, fromAtomic, parseUsdc, toAtomic } from "../src/index.js";

describe("USDC amounts", () => {
  it("parses decimal amounts into atomic units", () => {
    expect(parseUsdc("1.25")).toBe(1_250_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("0")).toBe(0n);
    expect(parseUsdc("12")).toBe(12_000_000n);
  });

  it("round-trips through formatting", () => {
    for (const value of ["0", "0.000001", "1.25", "12", "999999.999999"]) {
      expect(formatUsdc(parseUsdc(value))).toBe(value);
    }
  });

  it("rejects precision beyond six decimals, signs, exponents and padding", () => {
    for (const bad of ["1.0000001", "-1", "+1", "1e6", " 1", "1 ", "01", "1.", ".5", "", "0x10"]) {
      expect(() => parseUsdc(bad), bad).toThrow(RangeError);
    }
  });

  it("accepts only canonical non-negative integer strings within uint256", () => {
    expect(UsdcAtomic.safeParse("250000").success).toBe(true);
    for (const bad of ["-1", "01", "1.5", "1e3", "", " 1"]) {
      expect(UsdcAtomic.safeParse(bad).success, bad).toBe(false);
    }
    expect(UsdcAtomic.safeParse(MAX_ATOMIC.toString()).success).toBe(true);
    expect(UsdcAtomic.safeParse((MAX_ATOMIC + 1n).toString()).success).toBe(false);
    // Independent of the exported constant.
    expect(MAX_ATOMIC).toBe(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
    expect(UsdcAtomic.safeParse("115792089237316195423570985008687907853269984665640564039457584007913129639936").success).toBe(false);
  });

  it("refuses to parse or produce amounts beyond uint256, and accepts both ends of the range", () => {
    expect(parseUsdc(`1${"0".repeat(71)}`)).toBe(10n ** 77n);
    expect(() => parseUsdc(`2${"0".repeat(71)}`)).toThrow(/uint256/);
    expect(fromAtomic(0n)).toBe("0");
    expect(fromAtomic(MAX_ATOMIC)).toBe(MAX_ATOMIC.toString());
  });

  it("converts safely in both directions", () => {
    expect(toAtomic("250000")).toBe(250_000n);
    for (const bad of ["-1", "01", "1.5", "1e3", ""]) expect(() => toAtomic(bad), bad).toThrow();
    expect(fromAtomic(250_000n)).toBe("250000");
    expect(() => fromAtomic(-1n)).toThrow(RangeError);
    expect(() => fromAtomic(MAX_ATOMIC + 1n)).toThrow(RangeError);
    expect(() => formatUsdc(-1n)).toThrow(RangeError);
    expect(atomicOrNull("12")).toBe(12n);
    for (const bad of ["1.5", 12, null, undefined, "x"]) expect(atomicOrNull(bad)).toBeNull();
  });
});
