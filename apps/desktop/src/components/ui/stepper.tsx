import { Check } from "lucide-react";
import type { ReactNode } from "react";

export interface StepperProps {
  steps: string[];
  /** 0-based 当前步骤 */
  current: number;
  ariaLabel?: string;
  className?: string;
}

/** 横向步骤条（v2：线性不可跳转） */
export function Stepper({ steps, current, ariaLabel = "流程步骤", className = "" }: StepperProps) {
  return (
    <ol className={`stepper ${className}`.trim()} aria-label={ariaLabel}>
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const node: ReactNode = done ? (
          <Check size={13} strokeWidth={2.5} />
        ) : (
          i + 1
        );
        return (
          <li key={step} className="stepper__item">
            <span
              aria-hidden="true"
              className={`stepper__node${done ? " stepper__node--done" : ""}${active ? " stepper__node--active" : ""}`}
            >
              {node}
            </span>
            <span className={`stepper__label${active ? " stepper__label--active" : ""}`}>{step}</span>
            {i < steps.length - 1 ? (
              <span aria-hidden="true" className={`stepper__line${done ? " stepper__line--done" : ""}`} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
