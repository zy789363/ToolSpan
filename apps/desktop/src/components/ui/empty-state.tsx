import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** 空状态（v2：教育性引导） */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? " empty-state--compact" : ""} ${className}`.trim()}>
      {icon ? (
        <span className="empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="empty-state__title">{title}</div>
      {description ? <div className="empty-state__desc">{description}</div> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
