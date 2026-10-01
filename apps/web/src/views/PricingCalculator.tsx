import { useState } from "react";

import { type PricingField, type PricingInput, VERDICT_TEXT, WORKED_EXAMPLE, evaluatePricing } from "../calculator.js";
import { CostComparison } from "../components/CostChart.js";
import { Icon } from "../components/Icon.js";
import { Stat } from "../components/ui.js";
import { percent, usdcAmount } from "../format.js";

const FIELDS: ReadonlyArray<{ readonly name: PricingField; readonly label: string; readonly hint: string }> = [
  { name: "control", label: "Control cost to green (C)", hint: "Median model cost for an agent to finish the task alone." },
  { name: "saving", label: "Measured saving (S)", hint: "Conservative model-cost saving from the paired benchmark." },
  { name: "price", label: "Resolution price (P)", hint: "What the agent pays Lemma in USDC." },
  { name: "gas", label: "Chain cost (g)", hint: "Settlement, warranty activation, outcome and expiry." },
];

/** The sale rule and the buyer's target, recomputed with core's own pricing functions as you type. */
export function PricingCalculator() {
  const [input, setInput] = useState<PricingInput>(WORKED_EXAMPLE);
  const result = evaluatePricing(input);
  const changed = FIELDS.some(({ name }) => input[name] !== WORKED_EXAMPLE[name]);

  return (
    <div className="card calc">
      <div className="calc-inputs">
        {FIELDS.map(({ name, label, hint }) => {
          const error = result.ok ? undefined : result.errors[name];
          const id = `calc-${name}`;
          return (
            <div className="field" key={name}>
              <label className="field-label" htmlFor={id}>
                {label}
              </label>
              <div className="input-wrap">
                <input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={input[name]}
                  aria-invalid={error !== undefined}
                  aria-describedby={`${id}-note`}
                  onChange={(event) => setInput({ ...input, [name]: event.target.value })}
                />
                <span className="unit">USDC</span>
              </div>
              <span id={`${id}-note`} className={error === undefined ? "field-hint" : "field-error"}>
                {error ?? hint}
              </span>
            </div>
          );
        })}
        <p className="field-hint">
          Inputs start at the worked example in <code>docs/economic-gates.md</code>. They are illustrative assumptions, not measurements.
        </p>
        {changed ? (
          <button type="button" className="btn btn-secondary" onClick={() => setInput(WORKED_EXAMPLE)}>
            Reset to the worked example
          </button>
        ) : null}
      </div>
      <div>
        {result.ok ? (
          <>
            <p className={result.verdict === "ok" ? "verdict ok" : "verdict no"}>
              <Icon name={result.verdict === "ok" ? "check" : "x"} size={18} />
              <span>{VERDICT_TEXT[result.verdict]}</span>
            </p>
            <dl className="stats calc-results">
              <Stat label="Buyer's all-in reduction" value={percent(result.reductionBps)} note="target: at least 25.00 %" />
              <Stat
                label="Highest price allowed"
                value={result.maxPrice === 0n ? "None" : `${usdcAmount(result.maxPrice)} USDC`}
                note={result.maxPrice === 0n ? "preview only: no price meets both rules" : "min(30% of S, S − g − 25% of C)"}
              />
              <Stat label="Buyer's net saving" value={`${usdcAmount(result.saving - result.price - result.gas)} USDC`} note="S − P − g, per resolution" />
            </dl>
            <CostComparison control={result.control} residual={result.residual} price={result.price} gas={result.gas} caption="Expected cost to reach passing tests" />
          </>
        ) : (
          <p className="verdict no">
            <Icon name="alert" size={18} />
            <span>Fix the highlighted amounts to see the result.</span>
          </p>
        )}
      </div>
    </div>
  );
}
