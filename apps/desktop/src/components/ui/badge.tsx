import type { ReactNode } from "react";

export type BadgeTone = "positive" | "warning" | "danger" | "neutral" | "info";

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span aria-hidden="true" className="badge__dot" /> : null}
      {children}
    </span>
  );
}
