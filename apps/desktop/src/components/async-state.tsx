import { AlertTriangle, RotateCw, Settings2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./ui/button";
import { Card } from "./ui/card";

export function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-mark" aria-hidden="true" />
      <span>{t("common.loading")}</span>
    </div>
  );
}

export function AdapterErrorState({
  onChooseNode,
  onRetry,
}: {
  onChooseNode(): Promise<void>;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const [choosingNode, setChoosingNode] = useState(false);
  const chooseNode = async () => {
    setChoosingNode(true);
    try {
      await onChooseNode();
    } catch {
      // Keep the fail-closed snapshot error state when selection or retry fails.
    } finally {
      setChoosingNode(false);
    }
  };
  return (
    <Card className="error-state" role="alert">
      <AlertTriangle aria-hidden="true" size={24} />
      <div>
        <h1>{t("errors.adapterTitle")}</h1>
        <p>{t("errors.adapterDescription")}</p>
        <div className="button-row">
          <Button disabled={choosingNode} onClick={() => { void chooseNode(); }}>
            <Settings2 aria-hidden="true" size={15} />
            {t("settings.chooseNode")}
          </Button>
          <Button onClick={onRetry}>
            <RotateCw aria-hidden="true" size={15} />
            {t("common.retry")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
