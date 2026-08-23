import { useMutation } from "@tanstack/react-query";
import { BookOpen, Cable, CheckCircle2, Globe2, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { ConnectionTestResult } from "../adapters/types";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CopyButton } from "../components/ui/copy-button";
import { Notice } from "../components/ui/notice";
import { HOST_META, hostSnippet, type HostId } from "../lib/host-snippets";
import { formatTimestamp, OperationError, useRuntimeSnapshot } from "./shared";

const HOST_IDS: HostId[] = ["chatgpt", "claude", "codex"];

export function ConnectionPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const snapshot = useRuntimeSnapshot();
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [host, setHost] = useState<HostId>("chatgpt");
  const test = useMutation({
    mutationFn: (target: "local" | "public") => target === "local" ? adapter.testLocal() : adapter.testPublic(),
    onSuccess: setResult,
  });
  if (snapshot.data === undefined) return null;
  const data = snapshot.data.connection;
  const hostUrl = data.publicBaseUrl ?? data.localUrl;

  return (
    <div className="page-stack">
      <PageHeader
        actions={<Badge dot tone="positive">{t("connection.localBadge")}</Badge>}
        description={t("connection.description")}
        eyebrow={t("connection.eyebrow")}
        title={t("connection.title")}
      />
      {test.isError ? <OperationError /> : null}

      {/* 本地连接 */}
      <Card className="panel">
        <div className="panel__head">
          <span className="panel__title">{t("connection.localTitle")}</span>
          <Badge tone="neutral">{t("connection.localOnly")}</Badge>
        </div>
        <div className="panel__body">
          <div className="field-group">
            <label className="field">
              <span className="field__label">{t("connection.localMcpUrl")}</span>
              <span className="field__control">
                <code className="mono-box">{data.localUrl ?? t("common.notConfigured")}</code>
                {data.localUrl === null ? null : <CopyButton compact value={data.localUrl} />}
              </span>
            </label>
            {data.oauthDiscoveryUrl === null ? null : (
              <label className="field">
                <span className="field__label">{t("connection.oauthUrlLabel")}</span>
                <span className="field__control">
                  <code className="mono-box">{data.oauthDiscoveryUrl}</code>
                  <CopyButton compact value={data.oauthDiscoveryUrl} />
                </span>
              </label>
            )}
          </div>
        </div>
        <div className="panel__foot">
          <Button disabled={test.isPending} onClick={() => test.mutate("local")} variant="primary"><Cable aria-hidden="true" size={15} />{t("connection.testLocal")}</Button>
          {result === null ? <span className="table__muted">{t("connection.localDescription")}</span> : (
            <span className="test-result" role="status" aria-live="polite">
              <CheckCircle2 aria-hidden="true" size={15} />
              <span>{t("connection.testResult")}: {result.status} · {t("connection.latency", { value: result.latencyMs })} · {formatTimestamp(result.checkedAt, i18n.language)}</span>
            </span>
          )}
        </div>
      </Card>

      {/* 公网连接 */}
      <Card className="panel">
        <div className="panel__head">
          <span className="panel__title">{t("connection.publicTitle")}</span>
          <Badge tone="warning">{t("connection.requiresHttps")}</Badge>
        </div>
        <div className="panel__body">
          <label className="field">
            <span className="field__label">{t("connection.publicUrlLabel")}</span>
            <span className="field__control">
              <code className="mono-box">{data.publicBaseUrl ?? t("common.notConfigured")}</code>
              {data.publicBaseUrl === null ? null : <CopyButton compact value={data.publicBaseUrl} />}
            </span>
          </label>
          <Notice icon={<LockKeyhole aria-hidden="true" size={15} />}>{t("connection.securityNote")}</Notice>
        </div>
        <div className="panel__foot">
          <Button disabled={data.publicBaseUrl === null || test.isPending} onClick={() => test.mutate("public")}><Globe2 aria-hidden="true" size={15} />{t("connection.testPublic")}</Button>
          <span className="table__muted">{data.publicBaseUrl === null ? t("connection.unavailablePublic") : t("connection.publicDescription")}</span>
        </div>
      </Card>

      {/* Agent Host 接入 */}
      <Card className="panel">
        <div className="panel__head">
          <div className="panel__title-wrap">
            <span className="panel__title">{t("connection.hostCard")}</span>
          </div>
        </div>
        <div className="panel__sub" style={{ padding: "0 18px 2px" }}>{t("connection.hostSub")}</div>
        <div role="tablist" aria-label={t("connection.hostCard")} className="tab-list">
          {HOST_IDS.map((id) => (
            <button
              aria-controls={`host-panel-${id}`}
              aria-selected={host === id}
              className={`tab${host === id ? " is-active" : ""}`}
              id={`host-tab-${id}`}
              key={id}
              onClick={() => setHost(id)}
              role="tab"
              type="button"
            >
              {HOST_META[id].label}
            </button>
          ))}
        </div>
        <div className="panel__body">
          {hostUrl === null ? (
            <p className="empty-note">{t("common.notConfigured")}</p>
          ) : HOST_IDS.map((id) => (
            <div
              aria-labelledby={`host-tab-${id}`}
              className="host-snippet"
              hidden={host !== id}
              id={`host-panel-${id}`}
              key={id}
              role="tabpanel"
            >
              <div className="host-snippet__head">
                <span className="mono-tag">{HOST_META[id].file}</span>
                <CopyButton compact value={hostSnippet(id, hostUrl)} />
              </div>
              <pre className="code-block">{hostSnippet(id, hostUrl)}</pre>
            </div>
          ))}
        </div>
        <div className="panel__foot">
          <span className="docs-row" style={{ marginTop: 0 }}>
            <BookOpen aria-hidden="true" size={14} />
            <span>{t("connection.docsDescription")}</span>
            <CopyButton compact label={t("connection.docs")} value="docs/deployment.md" />
          </span>
        </div>
      </Card>
    </div>
  );
}
