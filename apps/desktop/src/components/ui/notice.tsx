import { Info, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

export interface NoticeProps {
  tone?: "info" | "warn";
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** 信息/警告横幅（风险披露） */
export function Notice({ tone = "info", icon, className = "", children }: NoticeProps) {
  return (
    <div className={`notice notice--${tone} ${className}`.trim()}>
      <span className="notice__icon" aria-hidden="true">
        {icon ?? (tone === "warn" ? <ShieldAlert size={15} /> : <Info size={15} />)}
      </span>
      <span>{children}</span>
    </div>
  );
}
