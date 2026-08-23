import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Clock3, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { JobStatus } from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { CopyButton } from "../components/ui/copy-button";
import { Seg } from "../components/ui/seg";
import { StatusDot, type StatusKind } from "../components/ui/status-dot";
import { formatDuration, formatTimestamp, OperationError, TranslatedStatus } from "./shared";

function dotFor(status: JobStatus): StatusKind {
  if (status === "running") return "running";
  if (status === "completed") return "ok";
  if (status === "failed" || status === "timed_out" || status === "interrupted") return "err";
  return "muted";
}

export function JobsPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const client = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  return (
    <div className="page-stack">
      <PageHeader description={t("jobs.description")} eyebrow={t("jobs.eyebrow")} title={t("jobs.title")} />
      <div className="filters-row">
        <Seg<JobStatus | "all">
          aria-label={t("jobs.filterStatus")}
          onChange={setStatus}
          options={[
            { value: "all", label: t("jobs.allStatuses") },
            ...(["queued", "running", "completed", "failed"] as const).map((value) => ({ label: t(`state.${value}`), value })),
          ]}
          value={status}
        />
        <label className="search-field"><Search aria-hidden="true" size={15} /><span className="sr-only">{t("common.search")}</span><input onChange={(event) => setQuery(event.target.value)} placeholder={t("jobs.searchPlaceholder")} type="search" value={query} /></label>
      </div>
      {jobs.isError || cancel.isError ? <OperationError /> : null}
      <Card>
        {(jobs.data ?? []).length === 0 ? (
          <p className="empty-note"><Clock3 aria-hidden="true" size={16} /> {t("jobs.empty")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("jobs.name")}</th>
                  <th scope="col">{t("jobs.runner")}</th>
                  <th scope="col">{t("jobs.status")}</th>
                  <th scope="col">{t("jobs.startedAt")}</th>
                  <th scope="col">{t("jobs.duration")}</th>
                  <th className="table__th-actions" scope="col">{t("jobs.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data?.map((job) => (
                  <Fragment key={job.id}>
                    <tr>
                      <td>
                        <div className="table__cell-main">
                          <StatusDot status={dotFor(job.status)} />
                          <span className="table__mono">{job.label}</span>
                        </div>
                      </td>
                      <td className="table__muted">{job.runner}</td>
                      <td><TranslatedStatus status={job.status} /></td>
                      <td className="table__muted">{formatTimestamp(job.createdAt, i18n.language)}</td>
                      <td className="table__muted">{formatDuration(job.createdAt, job.finishedAt)}</td>
                      <td>
                        <div className="table__cell-actions">
                          <Button
                            aria-expanded={expandedId === job.id}
                            onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                            size="compact"
                            variant="ghost"
                          >
                            {t("jobs.outputAction")}
                          </Button>
                          {job.status === "queued" || job.status === "running" ? (
                            <ConfirmDialog
                              confirmLabel={t("jobs.cancel")}
                              description={t("jobs.cancelDescription")}
                              destructive
                              onConfirm={() => cancel.mutate(job.id)}
                              title={t("jobs.cancelTitle")}
                              trigger={<Button size="compact" variant="danger"><Ban aria-hidden="true" size={14} />{t("jobs.cancel")}</Button>}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {expandedId === job.id ? (
                      <tr className="job-row-detail">
                        <td colSpan={6}>
                          <div className="job-row-detail__head">
                            <span>{t("jobs.output")}</span>
                            {job.sanitizedOutput === undefined ? null : <CopyButton compact value={job.sanitizedOutput} />}
                          </div>
                          <pre>{job.sanitizedOutput ?? t("jobs.noOutput")}</pre>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
