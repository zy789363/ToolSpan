import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./button";

interface CopyButtonProps {
  value: string;
  label?: string;
  compact?: boolean;
}

export function CopyButton({ value, label, compact = false }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = globalThis.setTimeout(() => setCopied(false), 1600);
    return () => globalThis.clearTimeout(timeout);
  }, [copied]);

  return (
    <Button
      aria-label={label ?? t("common.copy")}
      size={compact ? "compact" : "normal"}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false));
      }}
    >
      {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
      {compact ? null : <span>{copied ? t("common.copied") : (label ?? t("common.copy"))}</span>}
    </Button>
  );
}
