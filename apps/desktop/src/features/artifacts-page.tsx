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
import { formatBytes, formatTimestamp, OperationError } from "./shared";

export function ArtifactsPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const artifacts = useQuery({ queryKey: ["artifacts"], queryFn: () => adapter.listArtifacts() });
  return (
    <div className="page-stack">
      <PageHeader description={t("artifacts.description")} eyebrow={t("artifacts.eyebrow")} title={t("artifacts.title")} />
      {artifacts.isError ? <OperationError /> : null}
      <div className="artifact-grid">
        {(artifacts.data ?? []).length === 0 ? <Card className="empty-panel"><FileOutput aria-hidden="true" size={26} /><p>{t("artifacts.empty")}</p></Card> : artifacts.data?.map((artifact) => (
          <Card className="artifact-card" key={artifact.id}>
            <div className="artifact-card__header"><div className="artifact-icon"><FileOutput aria-hidden="true" size={19} /></div><div><h2>{artifact.name}</h2><p>{artifact.mediaType} · {formatBytes(artifact.sizeBytes)} · {formatTimestamp(artifact.createdAt, i18n.language)}</p></div></div>
            <div className="artifact-path"><span>{t("artifacts.localPath")}</span><div className="copy-field"><code>{artifact.localPath}</code><CopyButton compact value={artifact.localPath} /></div></div>
            <div className="artifact-card__footer">
              <Badge tone={artifact.publicUrl === undefined ? "neutral" : "warning"}>{artifact.publicUrl === undefined ? t("artifacts.noPublic") : t("artifacts.publicLink")}</Badge>
              {artifact.publicUrl === undefined ? null : (
                <ConfirmDialog
                  confirmLabel={t("artifacts.copyPublic")}
                  description={t("artifacts.exposureDescription")}
                  onConfirm={() => { void navigator.clipboard.writeText(artifact.publicUrl ?? ""); }}
                  title={t("artifacts.exposureTitle")}
                  trigger={<Button size="compact"><Link2 aria-hidden="true" size={14} />{t("artifacts.copyPublic")}</Button>}
                />
              )}
            </div>
          </Card>
        ))}
      </div>
      <Card className="info-strip" tone="accent"><ShieldAlert aria-hidden="true" size={17} /><span>{t("artifacts.exposureDescription")}</span></Card>
    </div>
  );
}
