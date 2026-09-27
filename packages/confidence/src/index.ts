export {
  type Confidence,
  EMPTY_STATS,
  type Folded,
  HALF_LIFE_SECONDS,
  MAX_WEIGHT_BPS,
  NO_PRIOR,
  type Outcome,
  type Prior,
  type Stats,
  WAD,
  WASM_URL,
  confidence,
  decay,
  fold,
  priorFromEvidence,
  record,
  unixSeconds,
} from "./engine.js";

export const CONFIDENCE_COMPONENT = {
  name: "@lemma/confidence",
  engine: "lemma-confidence (contracts/stylus), compiled to wasm32",
} as const;
