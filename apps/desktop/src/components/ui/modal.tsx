import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "./button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/** 受控对话框（v2：Escape/遮罩关闭，焦点管理由 Radix 提供） */
export function Modal({ open, onClose, title, children, footer, icon, className = "" }: ModalProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className={`dialog-content ${className}`.trim()}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <AlertDialog.Title className="dialog-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {icon ? (
                <span className="modal-icon" aria-hidden="true">{icon}</span>
              ) : null}
              {title}
            </AlertDialog.Title>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" size="icon" aria-label="关闭">
                <X size={15} />
              </Button>
            </AlertDialog.Cancel>
          </div>
          <AlertDialog.Description asChild>
            <div className="dialog-description">{children}</div>
          </AlertDialog.Description>
          {footer ? <div className="dialog-actions" style={{ marginTop: 18 }}>{footer}</div> : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
