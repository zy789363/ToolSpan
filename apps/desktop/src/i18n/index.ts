import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";

import { resources, type AppLanguage } from "./resources";

export type { AppLanguage } from "./resources";

export const LANGUAGE_STORAGE_KEY = "toolspan.ui.language";

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "zh-CN";
}

export function preferredLanguage(): AppLanguage {
  const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
  if (isAppLanguage(stored)) return stored;
  return globalThis.navigator?.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export async function createAppI18n(language: AppLanguage): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
