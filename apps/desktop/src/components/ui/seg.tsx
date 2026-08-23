import type { ReactNode } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
}

export interface SegProps<T extends string> {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange(value: T): void;
  "aria-label": string;
  className?: string;
}

/** 分段控件（segmented control）：CSS 类驱动，role="group" + aria-pressed */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className = "",
}: SegProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={`seg ${className}`.trim()}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            aria-pressed={active}
            className="seg__item"
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.icon}
            {option.label}
            {option.count === undefined ? null : <span className="seg__count">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
