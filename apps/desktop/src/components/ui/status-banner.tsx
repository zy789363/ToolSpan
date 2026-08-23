import type { ReactNode } from "react";
import { CheckCircle2, CircleX, Info, Loader2, TriangleAlert } from "lucide-react";

export interface StatusBannerProps {
  status: "idle" | "running" | "ok" | "warn" | "err";
  title: string;
  description?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

const STATUS_META: Record<StatusBannerProps["status"], { icon: ReactNode; cls: string }> = {
  idle: { icon: <Info size={20} />, cls: "" },
  running: { icon: <Loader2 size={20} className="spin" />, cls: "status-banner--running" },
  ok: { icon: <CheckCircle2 size={20} />, cls: "status-banner--ok" },
  warn: { icon: <TriangleAlert size={20} />, cls: "status-banner--warn" },
  err: { icon: <CircleX size={20} />, cls: "status-banner--err" },
};

/** 状态横幅（v2：诊断/回滚/Apply 状态机展示） */
export function StatusBanner({
  status,
  title,
  description,
  primaryAction,
  secondaryAction,
  className = "",
}: StatusBannerProps) {
  const meta = STATUS_META[status];
  return (
    <div role="status" className={`status-banner ${meta.cls} ${className}`.trim()}>
      <span className="status-banner__icon" aria-hidden="true">{meta.icon}</span>
      <div>
        <div className="status-banner__title">{title}</div>
        {description ? <div className="status-banner__desc">{description}</div> : null}
        {primaryAction || secondaryAction ? (
          <div className="status-banner__actions">
            {primaryAction}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}
