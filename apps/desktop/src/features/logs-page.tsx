import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, Pause, Play, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { LogLevel } from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Seg } from "../components/ui/seg";
import { formatTimestamp, OperationError, TranslatedStatus } from "./shared";

export function LogsPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [query, setQuery] = useState("");
  const logs = useQuery({
    queryKey: ["logs", level, query],
    queryFn: () => adapter.getLogs({
      ...(level === "all" ? {} : { level }),
      ...(query.trim() === "" ? {} : { query: query.trim() }),
    }),
    refetchInterval: paused ? false : 2500,
  });
  const copyValue = useMemo(() => (logs.data ?? []).map((entry) => `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message}`).join("\n"), [logs.data]);

  return (
    <div className="page-stack">
      <PageHeader
        actions={<Button disabled={copyValue === ""} onClick={() => { void navigator.clipboard.writeText(copyValue); }}><ClipboardCopy aria-hidden="true" size={15} />{t("logs.copyVisible")}</Button>}
        description={t("logs.description")}
        eyebrow={t("logs.eyebrow")}
        title={t("logs.title")}
      />
      <div className="filters-row">
        <Seg<LogLevel | "all">
          aria-label={t("logs.filterLevel")}
          onChange={setLevel}
          options={[
            { value: "all", label: t("logs.allLevels") },
            ...(["debug", "info", "warn", "error"] as const).map((value) => ({ label: t(`state.${value}`), value })),
          ]}
          value={level}
        />
        <label className="search-field"><Search aria-hidden="true" size={15} /><span className="sr-only">{t("common.search")}</span><input onChange={(event) => setQuery(event.target.value)} placeholder={t("logs.searchPlaceholder")} type="search" value={query} /></label>
        <Button onClick={() => setPaused((value) => !value)}>{paused ? <Play aria-hidden="true" size={15} /> : <Pause aria-hidden="true" size={15} />}{paused ? t("common.resume") : t("common.pause")}</Button>
      </div>
      <div className="tail-status"><span className={paused ? "tail-dot tail-dot--paused" : "tail-dot"} aria-hidden="true" /><span>{paused ? t("logs.paused") : t("logs.live")}</span><Badge tone="positive"><ShieldCheck aria-hidden="true" size={12} /> {t("logs.sanitized")}</Badge></div>
      {logs.isError ? <OperationError /> : null}
      <Card className="log-viewer" aria-live={paused ? "off" : "polite"}>
        {(logs.data ?? []).length === 0 ? <p className="empty-state">{t("logs.empty")}</p> : logs.data?.map((entry) => (
          <div className="log-line" key={entry.id}><time>{formatTimestamp(entry.timestamp, i18n.language)}</time><TranslatedStatus status={entry.level} /><span className="log-source">{entry.source}</span><span>{entry.message}</span></div>
        ))}
      </Card>
    </div>
  );
}
