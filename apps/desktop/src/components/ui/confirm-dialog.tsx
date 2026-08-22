import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./button";

interface ConfirmDialogProps {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel?(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const confirmed = useRef(false);
  return (
    <AlertDialog.Root onOpenChange={(open) => {
      if (open) {
        confirmed.current = false;
      } else {
        if (!confirmed.current) onCancel?.();
        confirmed.current = false;
      }
    }}>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="dialog-content">
          <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-description">
            {description}
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <Button>{t("common.cancel")}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? "danger" : "primary"} onClick={() => {
                confirmed.current = true;
                onConfirm();
              }}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
