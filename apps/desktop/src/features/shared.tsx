import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { CoreState, JobStatus, LogLevel } from "../adapters/types";
import { Badge, type BadgeTone } from "../components/ui/badge";

export function useRuntimeSnapshot() {
  const adapter = useDesktopAdapter();
  return useQuery({
    queryKey: ["runtime-snapshot"],
    queryFn: () => adapter.getSnapshot(),
  });
}

export function statusTone(status: CoreState | JobStatus | LogLevel): BadgeTone {
  if (status === "running" || status === "completed" || status === "info") return "positive";
  if (status === "starting" || status === "queued" || status === "warn") return "warning";
  if (status === "failed" || status === "error" || status === "unavailable") return "danger";
  if (status === "debug") return "info";
  return "neutral";
}

export function TranslatedStatus({ status }: { status: CoreState | JobStatus | LogLevel }) {
  const { t } = useTranslation();
  return <Badge tone={statusTone(status)}>{t(`state.${status}`)}</Badge>;
}

export function SectionTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {meta === undefined ? null : <div>{meta}</div>}
    </div>
  );
}

export function OperationError() {
  const { t } = useTranslation();
  return <p className="inline-error" role="alert">{t("errors.operationDescription")}</p>;
}

export function formatTimestamp(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
