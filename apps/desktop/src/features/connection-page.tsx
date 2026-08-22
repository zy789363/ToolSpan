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
import { formatTimestamp, OperationError, SectionTitle, useRuntimeSnapshot } from "./shared";

function EndpointCard({
  icon,
  title,
  description,
  url,
  ready,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  url: string | null;
  ready: boolean | null;
  action: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card className="endpoint-card">
      <div className="endpoint-card__icon" aria-hidden="true">{icon}</div>
      <div className="endpoint-card__body">
        <div className="endpoint-card__title"><h2>{title}</h2><Badge tone={ready === true ? "positive" : "neutral"}>{ready === true ? t("state.ready") : t("common.notConfigured")}</Badge></div>
        <p>{description}</p>
        <div className="copy-field"><code>{url ?? t("common.notConfigured")}</code>{url === null ? null : <CopyButton compact value={url} />}</div>
        <div>{action}</div>
      </div>
    </Card>
  );
}

export function ConnectionPage() {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const snapshot = useRuntimeSnapshot();
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const test = useMutation({
    mutationFn: (target: "local" | "public") => target === "local" ? adapter.testLocal() : adapter.testPublic(),
    onSuccess: setResult,
  });
  if (snapshot.data === undefined) return null;
  const data = snapshot.data.connection;
  const hostUrl = data.publicBaseUrl ?? data.localUrl;
  const jsonSnippet = hostUrl === null ? "" : JSON.stringify({ mcpServers: { toolspan: { url: hostUrl } } }, null, 2);
  const cliSnippet = hostUrl === null ? "" : `MCP endpoint: ${hostUrl}`;

  return (
    <div className="page-stack">
      <PageHeader description={t("connection.description")} eyebrow={t("connection.eyebrow")} title={t("connection.title")} />
      {test.isError ? <OperationError /> : null}
      <div className="two-column endpoints-grid">
        <EndpointCard
          action={<Button disabled={test.isPending} onClick={() => test.mutate("local")} variant="primary"><Cable aria-hidden="true" size={15} />{t("connection.testLocal")}</Button>}
          description={t("connection.localDescription")}
          icon={<Cable size={18} />}
          ready={data.localReady}
          title={t("connection.localTitle")}
          url={data.localUrl}
        />
        <EndpointCard
          action={<Button disabled={data.publicBaseUrl === null || test.isPending} onClick={() => test.mutate("public")}><Globe2 aria-hidden="true" size={15} />{t("connection.testPublic")}</Button>}
          description={data.publicBaseUrl === null ? t("connection.unavailablePublic") : t("connection.publicDescription")}
          icon={<Globe2 size={18} />}
          ready={data.publicReady}
          title={t("connection.publicTitle")}
          url={data.publicBaseUrl}
        />
      </div>

      {result === null ? null : (
        <Card className="test-result" role="status" aria-live="polite">
          <CheckCircle2 aria-hidden="true" size={19} />
          <div><strong>{t("connection.testResult")}: {result.status}</strong><span>{t("connection.latency", { value: result.latencyMs })} · {t("connection.checkedAt", { value: formatTimestamp(result.checkedAt, i18n.language) })}</span></div>
        </Card>
      )}

      <section>
        <SectionTitle>{t("connection.hostSnippets")}</SectionTitle>
        <p className="section-description">{t("connection.hostDescription")}</p>
        {hostUrl === null ? <Card><p className="empty-state">{t("common.notConfigured")}</p></Card> : <div className="two-column">
          <Card><h3>{t("connection.jsonSnippet")}</h3><div className="code-block"><pre>{jsonSnippet}</pre><CopyButton compact value={jsonSnippet} /></div></Card>
          <Card><h3>{t("connection.cliSnippet")}</h3><div className="code-block"><pre>{cliSnippet}</pre><CopyButton compact value={cliSnippet} /></div></Card>
        </div>}
      </section>

      <Card className="security-callout" tone="accent">
        <LockKeyhole aria-hidden="true" size={19} />
        <div><strong>{t("connection.securityNote")}</strong><div className="docs-row"><BookOpen aria-hidden="true" size={15} /><span>{t("connection.docsDescription")}</span><CopyButton compact label={t("connection.docs")} value="docs/deployment.md" /></div></div>
      </Card>
      {data.oauthDiscoveryUrl === null ? null : <p className="oauth-line"><strong>{t("connection.oauthDiscovery")}</strong><code>{data.oauthDiscoveryUrl}</code><CopyButton compact value={data.oauthDiscoveryUrl} /></p>}
    </div>
  );
}
