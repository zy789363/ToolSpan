import { CheckCircle2, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export interface NoticeProps {
  /** v2：四态统一 */
  tone?: "info" | "success" | "warn" | "danger";
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

const TONE_ICON: Record<NonNullable<NoticeProps["tone"]>, ReactNode> = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warn: <ShieldAlert size={15} />,
  danger: <TriangleAlert size={15} />,
};

/** 信息/警告横幅（风险披露） */
export function Notice({ tone = "info", icon, className = "", children }: NoticeProps) {
  return (
    <div className={`notice notice--${tone} ${className}`.trim()}>
      <span className="notice__icon" aria-hidden="true">
        {icon ?? TONE_ICON[tone]}
      </span>
      <span>{children}</span>
    </div>
  );
}
