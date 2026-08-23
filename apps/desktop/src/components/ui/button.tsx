import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle";
  size?: "normal" | "compact" | "icon" | "xs";
  /** v2：加载态（spinner + 禁用） */
  loading?: boolean;
}

export function Button({
  children,
  className = "",
  type = "button",
  variant = "secondary",
  size = "normal",
  loading = false,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button--${variant} button--${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="button__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
