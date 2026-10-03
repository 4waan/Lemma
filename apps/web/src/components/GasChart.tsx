import type { GasStep } from "../deployment.js";
import { explorerTxUrl } from "../links.js";
import { dataEndPath, usePlotWidth } from "./CostChart.js";
import { ExplorerLink } from "./chain.js";

const BAR_HEIGHT = 14;

/**
 * Gas per on-chain step of one purchase: one series in one color, the value
 * printed beside each bar, and each step linked to its transaction. The rows
 * are text, so the list reads the same without the bars, which are drawn in
 * pixels and hidden from assistive technology. Hovering a row, or focusing its
 * link, lifts its bar.
 */
export function GasChart({ steps, explorer, label }: { steps: readonly GasStep[]; explorer: string; label: string }) {
  const [plotRef, width] = usePlotWidth();
  const max = Math.max(1, ...steps.map((step) => step.gas));
  return (
    <ol className="gas-chart" aria-label={label}>
      {steps.map((step, i) => {
        const w = Math.max(4, Math.round((step.gas / max) * width));
        return (
          <li className="gas-row" key={step.tx}>
            <div className="gas-head">
              <span className="gas-title">{step.title}</span>
              <span className="gas-value">{step.gas.toLocaleString("en-US")} gas</span>
            </div>
            <div ref={i === 0 ? plotRef : undefined} className="gas-plot">
              <svg className="gas-bar" width={width} height={BAR_HEIGHT} aria-hidden="true">
                <path className="gas-mark" d={dataEndPath(0, 0, w, BAR_HEIGHT)} />
              </svg>
            </div>
            <p className="gas-detail">
              {step.detail} <ExplorerLink href={explorerTxUrl(explorer, step.tx)} explorer={explorer} label={`View the ${step.title.toLowerCase()} transaction`} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}
