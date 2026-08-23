import { useQuery } from "@tanstack/react-query";
import { FileOutput, Link2, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { CopyButton } from "../components/ui/copy-button";
import { Notice } from "../components/ui/notice";
import { formatBytes, formatTimestamp, OperationError } from "./shared";

export function ArtifactsPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const artifacts = useQuery({ queryKey: ["artifacts"], queryFn: () => adapter.listArtifacts() });
  return (
    <div className="page-stack">
      <PageHeader description={t("artifacts.description")} eyebrow={t("artifacts.eyebrow")} title={t("artifacts.title")} />
      {artifacts.isError ? <OperationError /> : null}
      <Card>
        {(artifacts.data ?? []).length === 0 ? (
          <p className="empty-note">{t("artifacts.empty")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("artifacts.name")}</th>
                  <th scope="col">{t("artifacts.type")}</th>
                  <th scope="col">{t("artifacts.size")}</th>
                  <th scope="col">{t("artifacts.createdAt")}</th>
                  <th scope="col">{t("artifacts.link")}</th>
                  <th className="table__th-actions" scope="col"><span className="sr-only">{t("jobs.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {artifacts.data?.map((artifact) => (
                  <tr key={artifact.id}>
                    <td>
                      <div className="table__cell-main">
                        <span className="artifact-icon"><FileOutput aria-hidden="true" size={16} /></span>
                        <span className="table__mono">{artifact.name}</span>
                      </div>
                    </td>
                    <td className="table__muted">{artifact.mediaType}</td>
                    <td className="table__muted">{formatBytes(artifact.sizeBytes)}</td>
                    <td className="table__muted">{formatTimestamp(artifact.createdAt, i18n.language)}</td>
                    <td>
                      <Badge tone={artifact.publicUrl === undefined ? "neutral" : "warning"}>
                        {artifact.publicUrl === undefined ? t("artifacts.noPublic") : t("artifacts.publicLink")}
                      </Badge>
                    </td>
                    <td>
                      <div className="table__cell-actions">
                        {artifact.publicUrl === undefined ? null : (
                          <ConfirmDialog
                            confirmLabel={t("artifacts.copyPublic")}
                            description={t("artifacts.exposureDescription")}
                            onConfirm={() => { void navigator.clipboard.writeText(artifact.publicUrl ?? ""); }}
                            title={t("artifacts.exposureTitle")}
                            trigger={<Button size="compact"><Link2 aria-hidden="true" size={14} />{t("artifacts.copyPublic")}</Button>}
                          />
                        )}
                        <CopyButton compact value={artifact.localPath} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Notice icon={<ShieldAlert aria-hidden="true" size={15} />} tone="warn">{t("artifacts.exposureDescription")}</Notice>
    </div>
  );
}
