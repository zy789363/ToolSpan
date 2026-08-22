import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Boxes,
  Cable,
  FileOutput,
  FolderKanban,
  Gauge,
  Languages,
  ListChecks,
  RefreshCw,
  Route,
  ScrollText,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CoreState, PageId } from "../adapters/types";
import { Badge, type BadgeTone } from "./ui/badge";
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

function stateTone(state: CoreState): BadgeTone {
  if (state === "running") return "positive";
  if (state === "starting" || state === "attention") return "warning";
  if (state === "unavailable") return "danger";
  return "neutral";
}

interface AppShellProps {
  activePage: PageId;
  state: CoreState;
  instanceName: string;
  children: ReactNode;
  onNavigate(page: PageId): void;
  onRefresh(): void;
  refreshing: boolean;
}

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
  return (
    <Tooltip.Provider delayDuration={350}>
      <a className="skip-link" href="#main-content">{t("app.skipToContent")}</a>
      <div className="app-frame">
        <aside className="sidebar">
          <div className="brand-block">
            <div className="brand-mark" aria-hidden="true"><Boxes size={19} /></div>
            <div>
              <div className="brand-name">{t("app.name")}</div>
              <div className="brand-tagline">{t("app.tagline")}</div>
            </div>
          </div>

          <nav className="nav-list" aria-label={t("app.name")}>
            {navigation.map(({ id, icon: Icon }) => (
              <button
                aria-current={activePage === id ? "page" : undefined}
                className="nav-item"
                key={id}
                onClick={() => onNavigate(id)}
                type="button"
              >
                <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{t(`nav.${id}`)}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-status">
            <div className="sidebar-status__header">
              <span className="status-dot" data-state={state} aria-hidden="true" />
              <span className="truncate">{instanceName}</span>
            </div>
            <Badge tone={stateTone(state)}>{t(`state.${state}`)}</Badge>
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
