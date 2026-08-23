import type { HTMLAttributes } from "react";

/** 等宽展示盒（v2，配合复制按钮） */
export function MonoBox({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`mono-box ${className}`.trim()} {...props} />;
}
