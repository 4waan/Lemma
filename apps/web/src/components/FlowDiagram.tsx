import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface FlowStep {
  readonly title: string;
  /** Where the step happens: on the buyer's machine, on Arbitrum, on this server. */
  readonly where: string;
  readonly icon: IconName;
  readonly text: string;
  /** The step's state on this server, when it can be off. */
  readonly state?: ReactNode;
}

/**
 * Steps joined by arrows. It is an ordered list of text, so it reads the same
 * without the arrows, which are CSS and never reach assistive technology; no
 * element carries a style attribute, which the CSP would refuse.
 */
export function FlowDiagram({ label, steps }: { label: string; steps: readonly FlowStep[] }) {
  return (
    <ol className="flow" aria-label={label}>
      {steps.map((step) => (
        <li className="flow-step" key={step.title}>
          <span className="flow-icon" aria-hidden="true">
            <Icon name={step.icon} size={18} />
          </span>
          <div className="flow-body">
            <div className="flow-head">
              <h3>{step.title}</h3>
              {step.state}
            </div>
            <span className="flow-where">{step.where}</span>
            <p>{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
