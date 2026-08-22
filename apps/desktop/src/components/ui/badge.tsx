import type { ReactNode } from "react";

export type BadgeTone = "positive" | "warning" | "danger" | "neutral" | "info";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
