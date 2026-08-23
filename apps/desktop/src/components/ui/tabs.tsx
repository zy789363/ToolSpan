import type { ReactNode } from "react";

export interface TabItem {
  value: string;
  label: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
  "aria-label"?: string;
}

/** 下划线式 Tabs（v2） */
export function Tabs({ items, value, onChange, className = "", ...rest }: TabsProps) {
  return (
    <div role="tablist" aria-label={rest["aria-label"] ?? "切换"} className={`tab-list ${className}`.trim()}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={`tab${active ? " is-active" : ""}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
