import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "normal" | "compact" | "icon";
}

export function Button({
  children,
  className = "",
  type = "button",
  variant = "secondary",
  size = "normal",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button--${variant} button--${size} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
