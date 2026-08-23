import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronLeft, ChevronRight, FolderPlus, LockKeyhole, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { useDesktopAdapter } from "../adapters/context";
import type { RuntimeSnapshot, WorkspaceRoot } from "../adapters/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CopyButton } from "../components/ui/copy-button";
import { Notice } from "../components/ui/notice";

const formSchema = z.object({
  instanceName: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9 ._-]+$/u),
  ownerPassword: z.string().min(12),
  ownerPasswordConfirm: z.string().min(12),
  startAfterSave: z.boolean(),
}).refine((value) => value.ownerPassword === value.ownerPasswordConfirm, {
  path: ["ownerPasswordConfirm"],
  message: "password_mismatch",
});

type FirstRunForm = z.infer<typeof formSchema>;

export function FirstRun({ snapshot, onFinished }: { snapshot: RuntimeSnapshot; onFinished(): void }) {
  const { t } = useTranslation();
  const adapter = useDesktopAdapter();
  const [step, setStep] = useState(1);
  const [roots, setRoots] = useState<WorkspaceRoot[]>(snapshot.workspaces);
  const [passwordHash, setPasswordHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const {
    formState: { errors },
    getValues,
    register,
    resetField,
    trigger,
    watch,
  } = useForm<FirstRunForm>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      instanceName: snapshot.instanceName,
      ownerPassword: "",
      ownerPasswordConfirm: "",
      startAfterSave: true,
    },
  });

  // 密码强度：<12 弱（不可提交）、12–15 中、≥16 强
  const passwordValue = watch("ownerPassword");
  const strength =
    passwordValue.length === 0 ? 0 : passwordValue.length < 12 ? 1 : passwordValue.length < 16 ? 2 : 3;
  const strengthLabel =
    strength === 0 ? "" : strength === 1 ? t("onboarding.strengthWeak") : strength === 2 ? t("onboarding.strengthMedium") : t("onboarding.strengthStrong");

  const clearPassword = () => {
    resetField("ownerPassword");
    resetField("ownerPasswordConfirm");
  };
  useEffect(() => clearPassword, []);

  async function next(): Promise<void> {
    setFailed(false);
    if (step === 2 && !await trigger("instanceName")) return;
    if (step === 3 && roots.length === 0) return;
    if (step === 4 && (snapshot.statePath.trim() === "" || snapshot.logPath.trim() === "")) return;
    if (step === 5) {
      if (!await trigger(["ownerPassword", "ownerPasswordConfirm"])) return;
      setBusy(true);
      try {
        const hash = await adapter.hashOwnerPassword(getValues("ownerPassword"));
        clearPassword();
        setPasswordHash(hash);
      } catch {
        clearPassword();
        setFailed(true);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setStep((value) => Math.min(7, value + 1));
  }

  async function finishSetup(): Promise<void> {
    if (passwordHash === "") return;
    setBusy(true);
    setFailed(false);
    try {
      await adapter.completeFirstRun({
        instanceName: getValues("instanceName").trim(),
        allowedRoots: roots.map(({ name, path, access }) => ({ name, path, access })),
        statePath: snapshot.statePath,
        logPath: snapshot.logPath,
        ownerPasswordHash: passwordHash,
        startAfterSave: getValues("startAfterSave"),
      });
      setPasswordHash("");
      setStep(7);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function back(): void {
    if (step === 5) clearPassword();
    if (step === 6) setPasswordHash("");
    setStep((value) => Math.max(1, value - 1));
  }

  const titleKey = ["", "welcomeTitle", "instanceTitle", "rootsTitle", "pathsTitle", "passwordTitle", "reviewTitle", "successTitle"][step] ?? "welcomeTitle";
  const descriptionKey = ["", "welcomeDescription", "instanceDescription", "rootsDescription", "pathsDescription", "passwordDescription", "reviewDescription", "successDescription"][step] ?? "welcomeDescription";

  return (
    <main className="onboarding-shell">
      <div className="onboarding-brand"><div className="brand-mark"><Sparkles aria-hidden="true" size={19} /></div><strong>ToolSpan</strong></div>
      <Card className="onboarding-card">
        <div className="onboarding-progress"><span>{t("onboarding.progress", { current: step, total: 7 })}</span><div className="progress-track" aria-hidden="true"><span style={{ width: `${(step / 7) * 100}%` }} /></div></div>
        <div className="onboarding-heading"><div className="onboarding-icon" aria-hidden="true">{step === 7 ? <Check size={24} /> : step >= 5 ? <LockKeyhole size={24} /> : <Rocket size={24} />}</div><h1>{t(`onboarding.${titleKey}`)}</h1><p>{t(`onboarding.${descriptionKey}`)}</p></div>

        <div className="onboarding-body">
          {step === 1 ? <div className="welcome-points"><span><ShieldCheck aria-hidden="true" size={17} />{t("onboarding.secureContract")}</span><span><Check aria-hidden="true" size={17} />{t("onboarding.noDomain")}</span></div> : null}
          {step === 2 ? <label className="field"><span>{t("onboarding.instanceLabel")}</span><input autoFocus placeholder={t("onboarding.instancePlaceholder")} {...register("instanceName")} />{errors.instanceName === undefined ? null : <small role="alert">{t("onboarding.validationName")}</small>}</label> : null}
          {step === 3 ? <div className="root-picker"><Button onClick={() => { void adapter.pickAllowedRoot().then((root) => { if (root !== null) setRoots((current) => current.some((item) => item.id === root.id) ? current : [...current, root]); }, () => setFailed(true)); }}><FolderPlus aria-hidden="true" size={15} />{t("onboarding.addRoot")}</Button>{roots.length === 0 ? <p>{t("onboarding.rootsEmpty")}</p> : roots.map((root) => <div className="selected-root" key={root.id}><span><strong>{root.name}</strong><code>{root.path}</code></span><Button aria-label={`${t("common.remove")} ${root.name}`} onClick={() => setRoots((current) => current.filter((item) => item.id !== root.id))} size="compact" variant="ghost">{t("common.remove")}</Button></div>)}<Notice className="onboarding-notice" icon={<ShieldCheck aria-hidden="true" size={15} />}>{t("onboarding.escapeNote")}</Notice></div> : null}
          {step === 4 ? <div className="path-summary"><div><span>{t("onboarding.statePath")}</span><code>{snapshot.statePath}</code></div><div><span>{t("onboarding.logPath")}</span><code>{snapshot.logPath}</code></div></div> : null}
          {step === 5 ? <div className="password-fields"><label className="field"><span>{t("onboarding.passwordLabel")}</span><input autoComplete="new-password" autoFocus placeholder={t("onboarding.passwordPlaceholder")} type="password" {...register("ownerPassword")} />{errors.ownerPassword === undefined ? null : <small role="alert">{t("onboarding.validationPassword")}</small>}</label><label className="field"><span>{t("onboarding.passwordConfirmLabel")}</span><input autoComplete="new-password" placeholder={t("onboarding.passwordPlaceholder")} type="password" {...register("ownerPasswordConfirm")} />{errors.ownerPasswordConfirm === undefined ? null : <small role="alert">{errors.ownerPasswordConfirm.message === "password_mismatch" ? t("onboarding.validationPasswordMatch") : t("onboarding.validationPassword")}</small>}</label><div className="password-strength" aria-hidden="true">{[1, 2, 3].map((level) => <span className={`password-strength__bar${level <= strength ? ` is-${strength}` : ""}`} key={level} />)}<span className="password-strength__label">{strengthLabel}</span></div></div> : null}
          {step === 6 ? <div className="review-list"><div><span>{t("onboarding.instanceLabel")}</span><strong>{getValues("instanceName")}</strong></div><div><span>{t("workspaces.title")}</span><strong>{roots.length}</strong></div><div><span>{t("settings.ownerPassword")}</span><strong>••••••••••••</strong></div><label className="check-row"><input type="checkbox" {...register("startAfterSave")} /><span>{t("onboarding.startAfterSave")}</span></label></div> : null}
          {step === 7 ? <div className="success-block"><div className="success-orbit" aria-hidden="true"><Check size={30} /></div><div className="onboarding-url"><span>{t("connection.localMcpUrl")}</span><div className="onboarding-url__row"><code className="mono-box">{snapshot.connection.localUrl ?? t("common.notConfigured")}</code>{snapshot.connection.localUrl === null ? null : <CopyButton compact value={snapshot.connection.localUrl} />}</div></div></div> : null}
          {failed ? <p className="inline-error" role="alert">{t("errors.operationDescription")}</p> : null}
        </div>

        <div className="onboarding-actions">
          {step > 1 && step < 7 ? <Button disabled={busy} onClick={back}><ChevronLeft aria-hidden="true" size={15} />{t("common.back")}</Button> : <span />}
          {step === 1 ? <Button onClick={() => setStep(2)} variant="primary">{t("onboarding.begin")}<ChevronRight aria-hidden="true" size={15} /></Button> : null}
          {step > 1 && step < 6 ? <Button disabled={busy || (step === 3 && roots.length === 0)} onClick={() => { void next(); }} variant="primary">{t("common.continue")}<ChevronRight aria-hidden="true" size={15} /></Button> : null}
          {step === 6 ? <Button disabled={busy || passwordHash === ""} onClick={() => { void finishSetup(); }} variant="primary"><Rocket aria-hidden="true" size={15} />{t("onboarding.validateStart")}</Button> : null}
          {step === 7 ? <Button onClick={onFinished} variant="primary">{t("onboarding.openOverview")}<ChevronRight aria-hidden="true" size={15} /></Button> : null}
        </div>
      </Card>
    </main>
  );
}
