import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: "default" | "muted" | "accent";
  /** v2：可交互卡片（hover 上浮 + 品牌边框） */
  interactive?: boolean;
}

export function Card({
  children,
  className = "",
  tone = "default",
  interactive = false,
  ...props
}: CardProps) {
  const cls = interactive ? `card card--interactive ${className}` : `card card--${tone} ${className}`;
  return (
    <div className={cls.trim()} {...props}>
      {children}
    </div>
  );
}
