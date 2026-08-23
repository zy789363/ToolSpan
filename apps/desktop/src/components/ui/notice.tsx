import { Info, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

export interface NoticeProps {
  tone?: "info" | "warn";
  icon?: ReactNode;
  children: ReactNode;
}

/** 信息/警告横幅（风险披露） */
export function Notice({ tone = "info", icon, children }: NoticeProps) {
  return (
    <div className={`notice notice--${tone}`}>
      <span className="notice__icon" aria-hidden="true">
        {icon ?? (tone === "warn" ? <ShieldAlert size={15} /> : <Info size={15} />)}
      </span>
      <span>{children}</span>
    </div>
  );
}
