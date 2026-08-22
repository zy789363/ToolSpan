import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  FileOutput,
  FolderPlus,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Square,
  Timer,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { PageId } from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CopyButton } from "../components/ui/copy-button";
import {
  formatBytes,
  formatTimestamp,
  formatUptime,
  OperationError,
  SectionTitle,
  TranslatedStatus,
  useRuntimeSnapshot,
} from "./shared";

export function OverviewPage({ navigate }: { navigate(page: PageId): void }) {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const client = useQueryClient();
  const snapshot = useRuntimeSnapshot();
  const refresh = () => client.invalidateQueries({ queryKey: ["runtime-snapshot"] });
  const lifecycle = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => adapter[action](),
    onSuccess: refresh,
  });
  const localTest = useMutation({ mutationFn: () => adapter.testLocal(), onSuccess: refresh });
  const addWorkspace = useMutation({
    mutationFn: () => adapter.pickAllowedRoot(),
    onSuccess: refresh,
  });

  if (snapshot.data === undefined) return null;
  const data = snapshot.data;
  const canControl = data.core.managedByDesktop && lifecycle.isPending === false;
  const running = data.core.state === "running";

  return (
    <div className="page-stack">
      <PageHeader
        description={t("overview.description")}
        eyebrow={t("overview.eyebrow")}
        title={t("overview.title", { name: data.instanceName })}
        actions={(
          <div className="button-row">
            {data.connection.localUrl === null ? null : <CopyButton label={t("overview.copyMcp")} value={data.connection.localUrl} />}
            <Button
              disabled={!canControl}
              onClick={() => lifecycle.mutate(running ? "restart" : "start")}
              variant="primary"
            >
              {running ? <RefreshCw aria-hidden="true" size={15} /> : <Play aria-hidden="true" size={15} />}
              {running ? t("overview.restart") : t("overview.start")}
            </Button>
          </div>
        )}
      />

      {lifecycle.isError || localTest.isError || addWorkspace.isError ? <OperationError /> : null}

      <section className="metrics-grid" aria-label={t("overview.readiness")}>
        <Card className="metric-card">
          <div className="metric-icon"><Activity aria-hidden="true" size={18} /></div>
          <div><span className="metric-label">{t("overview.coreState")}</span><TranslatedStatus status={data.core.state} /></div>
          <span className="metric-detail">{data.core.managedByDesktop ? t("overview.managed") : t("overview.external")}</span>
        </Card>
        <Card className="metric-card">
          <div className="metric-icon"><Wrench aria-hidden="true" size={18} /></div>
          <div><span className="metric-label">{t("overview.toolContract")}</span><strong>{data.toolContract.available}/{data.toolContract.total}</strong></div>
          <span className="metric-detail">{t("overview.coreVersion")}: {data.core.version}</span>
        </Card>
        <Card className="metric-card">
          <div className="metric-icon"><Timer aria-hidden="true" size={18} /></div>
          <div><span className="metric-label">{t("overview.uptime")}</span><strong>{formatUptime(data.core.uptimeSeconds)}</strong></div>
          <span className="metric-detail mono truncate">{data.connection.localUrl ?? t("common.notConfigured")}</span>
        </Card>
        <Card className="metric-card">
          <div className="metric-icon"><ShieldCheck aria-hidden="true" size={18} /></div>
          <div className="readiness-pair">
            <span><span className="metric-label">{t("overview.local")}</span><Badge tone={data.connection.localReady ? "positive" : "danger"}>{data.connection.localReady ? t("state.ready") : t("state.unavailableShort")}</Badge></span>
            <span><span className="metric-label">{t("overview.public")}</span><Badge tone={data.connection.publicReady === true ? "positive" : "neutral"}>{data.connection.publicReady === true ? t("state.ready") : t("common.notConfigured")}</Badge></span>
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle>{t("overview.primaryActions")}</SectionTitle>
        <Card className="quick-actions">
          <Button onClick={() => localTest.mutate()}>
            <Activity aria-hidden="true" size={15} />{t("overview.testLocal")}
          </Button>
          <Button onClick={() => addWorkspace.mutate()}>
            <FolderPlus aria-hidden="true" size={15} />{t("overview.addWorkspace")}
          </Button>
          <Button onClick={() => navigate("logs")}>
            <ScrollText aria-hidden="true" size={15} />{t("overview.openLogs")}
          </Button>
          {running && data.core.managedByDesktop ? (
            <Button disabled={!canControl} onClick={() => lifecycle.mutate("stop")} variant="ghost">
              <Square aria-hidden="true" size={14} />{t("overview.stop")}
            </Button>
          ) : null}
        </Card>
      </section>

      <div className="two-column">
        <section>
          <SectionTitle meta={<Button onClick={() => navigate("jobs")} size="compact" variant="ghost">{t("common.open")}</Button>}>
            {t("overview.recentJobs")}
          </SectionTitle>
          <Card className="list-card">
            {data.recentJobs.length === 0 ? <p className="empty-state">{t("overview.noJobs")}</p> : data.recentJobs.map((job) => (
              <div className="list-row" key={job.id}>
                <div><strong>{job.label}</strong><small>{formatTimestamp(job.createdAt, i18n.language)}</small></div>
                <TranslatedStatus status={job.status} />
              </div>
            ))}
          </Card>
        </section>
        <section>
          <SectionTitle meta={<Button onClick={() => navigate("artifacts")} size="compact" variant="ghost">{t("common.open")}</Button>}>
            {t("overview.recentArtifacts")}
          </SectionTitle>
          <Card className="list-card">
            {data.recentArtifacts.length === 0 ? <p className="empty-state">{t("overview.noArtifacts")}</p> : data.recentArtifacts.map((artifact) => (
              <div className="list-row" key={artifact.id}>
                <div className="row-with-icon"><FileOutput aria-hidden="true" size={16} /><span><strong>{artifact.name}</strong><small>{formatBytes(artifact.sizeBytes)}</small></span></div>
                <CopyButton compact value={artifact.localPath} />
              </div>
            ))}
          </Card>
        </section>
      </div>
    </div>
  );
}
