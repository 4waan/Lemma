import { z } from "zod";

import { isSortedUnique } from "./primitives.js";

/** Machine-readable reasons behind a decision. The resolver never returns prose. */
export const REASON_CODES = [
  "DEPENDENCY_OUT_OF_RANGE",
  "EVIDENCE_STALE",
  "MISSING_DEPENDENCY",
  "MISSING_FRAMEWORK",
  "NO_RELEASE_FOR_CAPABILITY",
  "PRICE_EXCEEDS_SAVING_RULE",
  "PROFILE_NOT_BENCHMARKED",
  "RELEASE_EXPIRED",
  "UNSUPPORTED_LANGUAGE",
  "UNSUPPORTED_MODULE_SYSTEM",
  "UNSUPPORTED_PACKAGE_MANAGER",
  "UNSUPPORTED_RUNTIME",
] as const;

export const ReasonCode = z.enum(REASON_CODES);

export type ReasonCode = z.infer<typeof ReasonCode>;

/** Reasons are a set: sorted and unique, so equal decisions have equal digests. */
export const Reasons = z.array(ReasonCode).max(REASON_CODES.length).refine(isSortedUnique, "reasons must be sorted and unique");

export function normalizeReasons(reasons: Iterable<ReasonCode>): ReasonCode[] {
  return [...new Set(reasons)].sort();
}
