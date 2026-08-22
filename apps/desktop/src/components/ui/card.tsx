import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: "default" | "muted" | "accent";
}

export function Card({ children, className = "", tone = "default", ...props }: CardProps) {
  return (
    <div className={`card card--${tone} ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}
