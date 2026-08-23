export type StatusKind = "running" | "ok" | "err" | "muted";

/** 状态圆点（装饰性，aria-hidden）：running 带呼吸动画 */
export function StatusDot({ status }: { status: StatusKind }) {
  return <span aria-hidden="true" className={`status-dot status-dot--${status}`} />;
}
