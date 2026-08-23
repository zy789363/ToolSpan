import type { ReactNode } from "react";

export interface StatProps {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  mono?: boolean;
  meta?: ReactNode;
  tone?: "brand" | "positive";
}

/** 概览状态卡（v2：渐变图标底） */
export function Stat({ icon, label, value, mono = false, meta, tone = "brand" }: StatProps) {
  return (
    <div className={`card metric-card metric-card--${tone}`}>
      <span className="metric-icon">{icon}</span>
      <div>
        <span className="metric-label">{label}</span>
        <strong className={mono ? "metric-value metric-value--mono" : "metric-value"}>{value}</strong>
        {meta ? <span className="metric-detail">{meta}</span> : null}
      </div>
    </div>
  );
}
