import { useTranslation } from "react-i18next";

export const MIN_OWNER_PASSWORD_LENGTH = 8;
const STRONG_OWNER_PASSWORD_LENGTH = 12;

export function getPasswordLength(value: string): number {
  return Array.from(value).length;
}

function getPasswordStrength(value: string): 0 | 1 | 2 | 3 {
  const length = getPasswordLength(value);
  if (length === 0) return 0;
  if (length < MIN_OWNER_PASSWORD_LENGTH) return 1;
  if (length < STRONG_OWNER_PASSWORD_LENGTH) return 2;
  return 3;
}

export function PasswordStrength({ value }: { value: string }) {
  const { t } = useTranslation();
  const strength = getPasswordStrength(value);
  const strengthLabel = strength === 0
    ? t("onboarding.strengthEmpty")
    : strength === 1
      ? t("onboarding.strengthWeak")
      : strength === 2
        ? t("onboarding.strengthMedium")
        : t("onboarding.strengthStrong");

  return (
    <div
      aria-label={t("onboarding.passwordStrength", { strength: strengthLabel })}
      className="password-strength"
      role="status"
    >
      {[1, 2, 3].map((level) => (
        <span
          aria-hidden="true"
          className={`password-strength__bar${level <= strength ? ` is-${strength}` : ""}`}
          key={level}
        />
      ))}
      <span className="password-strength__label">{strengthLabel}</span>
    </div>
  );
}
