import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Monitor, MonitorCog, Moon, Palette, Route, Save, Settings2, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDesktopAdapter } from "../adapters/context";
import type { PageId } from "../adapters/types";
import { LANGUAGE_STORAGE_KEY, type AppLanguage } from "../i18n";
import { useTheme, type ThemeMode } from "../lib/theme";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Seg } from "../components/ui/seg";
import { OperationError, SectionTitle, useRuntimeSnapshot } from "./shared";

export function SettingsPage({ navigate }: { navigate(page: PageId): void }) {
  const { t, i18n } = useTranslation();
  const adapter = useDesktopAdapter();
  const client = useQueryClient();
  const snapshot = useRuntimeSnapshot();
  const { theme, motion, setTheme, setMotion } = useTheme();
  const [password, setPassword] = useState("");
  const [passwordUpdated, setPasswordUpdated] = useState(false);
  const passwordMutation = useMutation({
    mutationFn: async (plaintext: string) => {
      try {
        const hash = await adapter.hashOwnerPassword(plaintext);
        setPassword("");
        await adapter.updateOwnerPasswordHash(hash);
      } finally {
        setPassword("");
      }
    },
    onSuccess: () => setPasswordUpdated(true),
  });
  const chooseNode = useMutation({
    mutationFn: () => adapter.chooseNodeExecutable(),
    onSuccess: () => client.invalidateQueries({ queryKey: ["runtime-snapshot"] }),
  });

  useEffect(() => () => setPassword(""), []);
  if (snapshot.data === undefined) return null;
  const data = snapshot.data;

  return (
    <div className="page-stack">
      <PageHeader description={t("settings.description")} eyebrow={t("settings.eyebrow")} title={t("settings.title")} />
      <div className="settings-grid">
        <section className="settings-wide">
          <SectionTitle>{t("settings.assistant")}</SectionTitle>
          <Card className="settings-card">
            <div className="settings-icon"><Route aria-hidden="true" size={18} /></div>
            <div className="setting-row">
              <span><strong>{t("settings.assistantName")}</strong><small>{t("settings.assistantDesc")}</small></span>
              <Button onClick={() => navigate("setup")} size="compact" variant="primary">
                <Route aria-hidden="true" size={14} />{t("settings.assistantOpen")}
              </Button>
            </div>
          </Card>
        </section>

        <section>
          <SectionTitle>{t("settings.appearance")}</SectionTitle>
          <Card className="settings-card">
            <div className="settings-icon"><Palette aria-hidden="true" size={18} /></div>
            <label className="setting-row"><span><strong>{t("settings.theme")}</strong></span><Seg<ThemeMode> aria-label={t("settings.theme")} onChange={setTheme} options={[{ icon: <Sun aria-hidden="true" size={13} />, label: t("settings.light"), value: "light" }, { icon: <Moon aria-hidden="true" size={13} />, label: t("settings.dark"), value: "dark" }, { icon: <Monitor aria-hidden="true" size={13} />, label: t("settings.system"), value: "system" }]} value={theme} /></label>
            <label className="setting-row"><span><strong>{t("settings.language")}</strong></span><Seg<AppLanguage> aria-label={t("settings.language")} onChange={(language) => { globalThis.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); void i18n.changeLanguage(language); }} options={[{ label: t("settings.english"), value: "en" }, { label: t("settings.chinese"), value: "zh-CN" }]} value={i18n.language === "zh-CN" ? "zh-CN" : "en"} /></label>
            <label className="setting-row setting-row--checkbox"><span><strong>{t("settings.motion")}</strong><small>{t("settings.followsSystem")}</small></span><input checked={motion === "reduce"} onChange={(event) => setMotion(event.target.checked ? "reduce" : "system")} type="checkbox" /><span className="switch" aria-hidden="true" /></label>
          </Card>
        </section>

        <section>
          <SectionTitle>{t("settings.runtime")}</SectionTitle>
          <Card className="settings-card">
            <div className="settings-icon"><MonitorCog aria-hidden="true" size={18} /></div>
            <div className="setting-row"><span><strong>{t("settings.nodeVersion")}</strong></span><code>{data.core.nodeVersion ?? t("common.unknown")}</code></div>
            <div className="setting-row"><span><strong>{t("settings.nodePath")}</strong></span><Badge tone={data.core.nodePathConfigured ? "positive" : "warning"}>{data.core.nodePathConfigured ? t("settings.configured") : t("common.notConfigured")}</Badge></div>
            <Button disabled={chooseNode.isPending} onClick={() => chooseNode.mutate()}><Settings2 aria-hidden="true" size={15} />{t("settings.chooseNode")}</Button>
          </Card>
        </section>

        <section className="settings-wide">
          <SectionTitle>{t("settings.ownerAccess")}</SectionTitle>
          <Card className="settings-card">
            <div className="settings-icon"><KeyRound aria-hidden="true" size={18} /></div>
            <form className="password-form" onSubmit={(event) => { event.preventDefault(); setPasswordUpdated(false); passwordMutation.mutate(password); }}>
              <label><span>{t("settings.ownerPassword")}</span><input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} placeholder={t("settings.passwordPlaceholder")} type="password" value={password} /></label>
              <p>{t("settings.passwordHelp")}</p>
              <div className="button-row"><Button disabled={password.length < 12 || passwordMutation.isPending} type="submit" variant="primary"><Save aria-hidden="true" size={15} />{t("settings.updatePassword")}</Button>{password === "" ? null : <Button onClick={() => setPassword("")}>{t("common.cancel")}</Button>}</div>
              {passwordUpdated ? <p className="success-message" role="status">{t("settings.passwordUpdated")}</p> : null}
            </form>
          </Card>
        </section>

        <section className="settings-wide">
          <SectionTitle>{t("settings.paths")}</SectionTitle>
          <Card className="path-summary"><div><span>{t("settings.statePath")}</span><code>{data.statePath}</code></div><div><span>{t("settings.logPath")}</span><code>{data.logPath}</code></div></Card>
        </section>
      </div>
      {passwordMutation.isError || chooseNode.isError ? <OperationError /> : null}
    </div>
  );
}
