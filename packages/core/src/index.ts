export const LEMMA_SCHEMA_VERSION = "1" as const;

export const LEMMA_DECISIONS = ["reuse", "adapt", "build", "decline"] as const;

export type LemmaDecision = (typeof LEMMA_DECISIONS)[number];

export const CORE_COMPONENT = {
  name: "@lemma/core",
  status: "scaffold",
  schemaVersion: LEMMA_SCHEMA_VERSION,
} as const;
