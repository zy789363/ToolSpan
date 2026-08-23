import type { ReactNode } from "react";

export interface NavBadgeProps {
  children: ReactNode;
  className?: string;
}

/** 导航角标（v2） */
export function NavBadge({ children, className = "" }: NavBadgeProps) {
  return <span className={`nav-badge ${className}`.trim()}>{children}</span>;
}
