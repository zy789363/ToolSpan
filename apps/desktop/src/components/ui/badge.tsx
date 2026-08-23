import type { ReactNode } from "react";

export type BadgeTone = "positive" | "warning" | "danger" | "neutral" | "info";

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  /** v2：状态点呼吸动画（运行中） */
  pulse?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? (
        <span aria-hidden="true" className={`badge__dot${pulse ? " badge__dot--pulse" : ""}`} />
      ) : null}
      {children}
    </span>
  );
}
