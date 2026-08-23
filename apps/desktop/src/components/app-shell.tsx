import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Boxes,
  Cable,
  FileOutput,
  FolderKanban,
  Gauge,
  Languages,
  ListChecks,
  Moon,
  RefreshCw,
  Route,
  ScrollText,
  Settings,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CoreState, PageId } from "../adapters/types";
import { useTheme } from "../lib/theme";
import { Button } from "./ui/button";

const navigation: ReadonlyArray<{
  id: PageId;
  icon: typeof Gauge;
}> = [
  { id: "overview", icon: Gauge },
  { id: "setup", icon: Route },
  { id: "connection", icon: Cable },
  { id: "workspaces", icon: FolderKanban },
  { id: "jobs", icon: ListChecks },
  { id: "artifacts", icon: FileOutput },
  { id: "logs", icon: ScrollText },
  { id: "settings", icon: Settings },
];

interface AppShellProps {
  activePage: PageId;
  state: CoreState;
  instanceName: string;
  children: ReactNode;
  onNavigate(page: PageId): void;
  onRefresh(): void;
  refreshing: boolean;
}

/**
 * 应用外壳：52px 图标 rail（紧凑导航 + tooltip）+ 内容区。
 * 导航按钮保留可见文本为 sr-only，同时满足可访问名与视觉紧凑两种需求。
 */
export function AppShell({
  activePage,
  state,
  instanceName,
  children,
  onNavigate,
  onRefresh,
  refreshing,
}: AppShellProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();
  const toggleTheme = () =>
    setTheme(resolvedTheme === "dark" ? "light" : "dark");

  return (
    <Tooltip.Provider delayDuration={350}>
      <a className="skip-link" href="#main-content">{t("app.skipToContent")}</a>
      <div className="app-frame">
        <aside className="sidebar">
          <div className="brand-block">
            <div className="brand-mark" aria-hidden="true"><Boxes size={19} /></div>
            <div className="brand-name sr-only">{t("app.name")}</div>
          </div>

          <nav className="nav-list" aria-label={t("app.name")}>
            {navigation.map(({ id, icon: Icon }) => (
              <Tooltip.Root key={id}>
                <Tooltip.Trigger asChild>
                  <button
                    aria-current={activePage === id ? "page" : undefined}
                    className="nav-item"
                    onClick={() => onNavigate(id)}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span className="sr-only">{t(`nav.${id}`)}</span>
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip" sideOffset={10}>
                    {t(`nav.${id}`)}
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </nav>

          <div className="rail-footer">
            {/* 状态指示（信息性，非交互） */}
            <div
              className="rail-status"
              title={`${instanceName} · ${t(`state.${state}`)}`}
            >
              <span className="status-dot" data-state={state} aria-hidden="true" />
              <span className="sr-only">
                {instanceName} · {t(`state.${state}`)}
              </span>
            </div>
            {/* 主题快速切换 */}
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className="theme-toggle"
                  aria-label={t("app.toggleTheme")}
                  onClick={toggleTheme}
                >
                  {resolvedTheme === "dark" ? (
                    <Sun key="sun" aria-hidden="true" className="theme-icon" size={16} strokeWidth={1.8} />
                  ) : (
                    <Moon key="moon" aria-hidden="true" className="theme-icon" size={16} strokeWidth={1.8} />
                  )}
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip" sideOffset={10}>
                  {t("app.toggleTheme")}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </div>
        </aside>

        <section className="workspace-frame">
          <header className="titlebar">
            <div className="titlebar__context">
              <span>{t(`nav.${activePage}`)}</span>
            </div>
            <div className="titlebar__actions">
              <span className="language-indicator">
                <Languages aria-hidden="true" size={14} />
                {i18n.language === "zh-CN" ? "简体中文" : "English"}
              </span>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    aria-label={t("app.refresh")}
                    onClick={onRefresh}
                    size="icon"
                    variant="ghost"
                  >
                    <RefreshCw aria-hidden="true" className={refreshing ? "spin" : ""} size={16} />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip" sideOffset={6}>
                    {t("app.refresh")}
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </div>
          </header>
          <main className="main-content" id="main-content" tabIndex={-1}>{children}</main>
        </section>
      </div>
    </Tooltip.Provider>
  );
}
