import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderPlus, LockKeyhole, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { OperationError, useRuntimeSnapshot } from "./shared";

export function WorkspacesPage() {
  const { t } = useTranslation();
  const adapter = useDesktopAdapter();
  const client = useQueryClient();
  const snapshot = useRuntimeSnapshot();
  const refresh = () => client.invalidateQueries({ queryKey: ["runtime-snapshot"] });
  const add = useMutation({ mutationFn: () => adapter.pickAllowedRoot(), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => adapter.removeAllowedRoot(id), onSuccess: refresh });
  if (snapshot.data === undefined) return null;

  return (
    <div className="page-stack">
      <PageHeader
        actions={<Button disabled={add.isPending} onClick={() => add.mutate()} variant="primary"><FolderPlus aria-hidden="true" size={15} />{t("workspaces.add")}</Button>}
        description={t("workspaces.description")}
        eyebrow={t("workspaces.eyebrow")}
        title={t("workspaces.title")}
      />
      {add.isError || remove.isError ? <OperationError /> : null}
      <Card className="info-strip" tone="accent"><LockKeyhole aria-hidden="true" size={17} /><span>{t("workspaces.addHint")}</span></Card>
      <div className="workspace-list">
        {snapshot.data.workspaces.length === 0 ? (
          <Card className="empty-panel"><Folder aria-hidden="true" size={26} /><p>{t("workspaces.empty")}</p></Card>
        ) : snapshot.data.workspaces.map((workspace) => (
          <Card className="workspace-card" key={workspace.id}>
            <div className="workspace-card__icon"><Folder aria-hidden="true" size={20} /></div>
            <div className="workspace-card__details">
              <div><h2>{workspace.name}</h2><Badge tone="info">{workspace.access === "read" ? t("workspaces.read") : t("workspaces.readWrite")}</Badge></div>
              <code>{workspace.path}</code>
            </div>
            <ConfirmDialog
              confirmLabel={t("common.remove")}
              description={t("workspaces.removeDescription", { name: workspace.name })}
              destructive
              onConfirm={() => remove.mutate(workspace.id)}
              title={t("workspaces.removeTitle")}
              trigger={<Button aria-label={`${t("common.remove")} ${workspace.name}`} size="icon" variant="ghost"><Trash2 aria-hidden="true" size={16} /></Button>}
            />
          </Card>
        ))}
      </div>
    </div>
  );
}
