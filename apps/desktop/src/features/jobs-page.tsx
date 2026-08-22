import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Clock3, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { JobStatus } from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { CopyButton } from "../components/ui/copy-button";
import { Select } from "../components/ui/select";
import { formatTimestamp, OperationError, TranslatedStatus } from "./shared";

export function JobsPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const client = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [query, setQuery] = useState("");
  const jobs = useQuery({
    queryKey: ["jobs", status, query],
    queryFn: () => adapter.listJobs({
      ...(status === "all" ? {} : { status }),
      ...(query.trim() === "" ? {} : { query: query.trim() }),
    }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => adapter.cancelJob(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const statuses: Array<{ label: string; value: string }> = [
    { label: t("jobs.allStatuses"), value: "all" },
    ...(["queued", "running", "completed", "failed", "cancelled", "timed_out", "interrupted"] as const).map((value) => ({ label: t(`state.${value}`), value })),
  ];

  return (
    <div className="page-stack">
      <PageHeader description={t("jobs.description")} eyebrow={t("jobs.eyebrow")} title={t("jobs.title")} />
      <div className="filters-row">
        <label className="search-field"><Search aria-hidden="true" size={15} /><span className="sr-only">{t("common.search")}</span><input onChange={(event) => setQuery(event.target.value)} placeholder={t("jobs.searchPlaceholder")} type="search" value={query} /></label>
        <Select ariaLabel={t("jobs.filterStatus")} onChange={(value) => setStatus(value as JobStatus | "all")} options={statuses} value={status} />
      </div>
      {jobs.isError || cancel.isError ? <OperationError /> : null}
      <div className="job-list">
        {(jobs.data ?? []).length === 0 ? <Card className="empty-panel"><Clock3 aria-hidden="true" size={26} /><p>{t("jobs.empty")}</p></Card> : jobs.data?.map((job) => (
          <Card className="job-card" key={job.id}>
            <div className="job-card__top">
              <div><h2>{job.label}</h2><p>{job.runner} · {t("jobs.started", { value: formatTimestamp(job.createdAt, i18n.language) })}</p></div>
              <TranslatedStatus status={job.status} />
            </div>
            <div className="job-output">
              <div><span>{t("jobs.output")}</span>{job.sanitizedOutput === undefined ? null : <CopyButton compact value={job.sanitizedOutput} />}</div>
              <pre>{job.sanitizedOutput ?? t("jobs.noOutput")}</pre>
            </div>
            {job.status === "queued" || job.status === "running" ? (
              <div className="job-card__actions">
                <ConfirmDialog
                  confirmLabel={t("jobs.cancel")}
                  description={t("jobs.cancelDescription")}
                  destructive
                  onConfirm={() => cancel.mutate(job.id)}
                  title={t("jobs.cancelTitle")}
                  trigger={<Button size="compact" variant="danger"><Ban aria-hidden="true" size={14} />{t("jobs.cancel")}</Button>}
                />
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
