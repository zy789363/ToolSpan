import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { i18n } from "i18next";
import { useEffect, useRef, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";

import { DesktopAdapterProvider, useDesktopAdapter } from "./adapters/context";
import type { DesktopAdapter, PageId } from "./adapters/types";
import { AdapterErrorState, LoadingState } from "./components/async-state";
import { AppShell } from "./components/app-shell";
import { Button } from "./components/ui/button";
import { ArtifactsPage } from "./features/artifacts-page";
import { ConnectionPage } from "./features/connection-page";
import { FirstRun } from "./features/first-run";
import { JobsPage } from "./features/jobs-page";
import { LogsPage } from "./features/logs-page";
import { OverviewPage } from "./features/overview-page";
import { SettingsPage } from "./features/settings-page";
import { SetupPage } from "./features/setup-page";
import { WorkspacesPage } from "./features/workspaces-page";
import { ThemeProvider, type MotionMode, type ThemeMode } from "./lib/theme";

const defaultQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 2000 },
    mutations: { retry: false },
  },
});

interface ToolSpanAppProps {
  adapter: DesktopAdapter;
  i18n: i18n;
  initialPage?: PageId | undefined;
  initialTheme?: ThemeMode | undefined;
  initialMotion?: MotionMode | undefined;
  queryClient?: QueryClient | undefined;
}

function CurrentPage({
  page,
  navigate,
}: {
  page: PageId;
  navigate(page: PageId): void;
}) {
  switch (page) {
    case "overview": return <OverviewPage navigate={navigate} />;
    case "setup": return <SetupPage />;
    case "connection": return <ConnectionPage navigate={navigate} />;
    case "workspaces": return <WorkspacesPage />;
    case "jobs": return <JobsPage />;
    case "artifacts": return <ArtifactsPage />;
    case "logs": return <LogsPage />;
    case "settings": return <SettingsPage navigate={navigate} />;
  }
}

function DesktopApplication({ initialPage = "overview" }: Pick<ToolSpanAppProps, "initialPage">) {
  const [page, setPage] = useState<PageId>(initialPage);
  const [setupFinished, setSetupFinished] = useState(false);
  const [quitRequested, setQuitRequested] = useState(false);
  const adapter = useDesktopAdapter();
  const snapshot = useQuery({
    queryKey: ["runtime-snapshot"],
    queryFn: () => adapter.getSnapshot(),
    refetchInterval: 5000,
  });
  const localMcpUrl = useRef<string | null>(null);
  localMcpUrl.current = snapshot.data?.connection.localUrl ?? null;
  const recoverWithNodePicker = async () => {
    await adapter.chooseNodeExecutable();
    await snapshot.refetch();
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void adapter.onTrayAction((action) => {
      if (action === "copy-mcp-url" && localMcpUrl.current !== null) {
        void navigator.clipboard.writeText(localMcpUrl.current);
      } else if (action === "open-logs") {
        setPage("logs");
      }
    }).then((removeListener) => {
      if (disposed) removeListener();
      else unlisten = removeListener;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [adapter]);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void adapter.onQuitRequested((managedCore) => {
      if (managedCore) setQuitRequested(true);
    }).then((removeListener) => {
      if (disposed) removeListener();
      else unlisten = removeListener;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [adapter]);

  if (snapshot.isPending) return <LoadingState />;
  if (snapshot.isError || snapshot.data === undefined) {
    return (
      <AdapterErrorState
        onChooseNode={recoverWithNodePicker}
        onRetry={() => { void snapshot.refetch(); }}
      />
    );
  }
  if (snapshot.data.firstRunRequired && !setupFinished) {
    return (
      <FirstRun
        snapshot={snapshot.data}
        onFinished={() => {
          setSetupFinished(true);
          void snapshot.refetch();
        }}
      />
    );
  }

  return (
    <>
    <AppShell
      activePage={page}
      instanceName={snapshot.data.instanceName}
      onNavigate={setPage}
      onRefresh={() => { void snapshot.refetch(); }}
      refreshing={snapshot.isFetching}
      state={snapshot.data.core.state}
    >
      <CurrentPage navigate={setPage} page={page} />
    </AppShell>
    <QuitConfirmation
      open={quitRequested}
      onCancel={() => setQuitRequested(false)}
      onConfirm={() => {
        setQuitRequested(false);
        void adapter.confirmQuit(true);
      }}
    />
    </>
  );
}

function QuitConfirmation({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="dialog-content">
          <AlertDialog.Title className="dialog-title">{t("quit.title")}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-description">{t("quit.description")}</AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild><Button>{t("common.cancel")}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><Button onClick={onConfirm} variant="danger">{t("quit.stopAndQuit")}</Button></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function ToolSpanApp({
  adapter,
  i18n,
  initialPage,
  initialTheme,
  initialMotion,
  queryClient,
}: ToolSpanAppProps) {
  const [client] = useState(() => queryClient ?? defaultQueryClient());
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider initialMotion={initialMotion} initialTheme={initialTheme}>
        <QueryClientProvider client={client}>
          <DesktopAdapterProvider adapter={adapter}>
            <DesktopApplication initialPage={initialPage} />
          </DesktopAdapterProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
