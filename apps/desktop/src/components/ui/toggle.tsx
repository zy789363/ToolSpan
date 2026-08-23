import type { ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** 开关（v2：role="switch"） */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
  ...rest
}: ToggleProps) {
  return (
    <label className={`toggle ${className}`.trim()}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`toggle__track${checked ? " toggle__track--on" : ""}`}
      >
        <span className="toggle__thumb" aria-hidden="true" />
      </button>
      {label ? <span className="toggle__label">{label}</span> : null}
    </label>
  );
}
