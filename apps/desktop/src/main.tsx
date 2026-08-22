import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ToolSpanApp } from "./App";
import { createDemoDesktopAdapter, demoSnapshot } from "./adapters/demo-adapter";
import { createTauriDesktopAdapter } from "./adapters/tauri-adapter";
import { createAppI18n, preferredLanguage } from "./i18n";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Application root is missing");

const i18n = await createAppI18n(preferredLanguage());
const query = new URLSearchParams(globalThis.location.search);
const demoEnabled = query.get("demo") === "1";
const firstRunDemo = query.get("firstRun") === "1";
const adapter = demoEnabled
  ? createDemoDesktopAdapter(firstRunDemo ? {
      snapshot: {
        ...structuredClone(demoSnapshot),
        firstRunRequired: true,
        instanceName: "",
        workspaces: [],
        ownerPasswordConfigured: false,
      },
    } : {})
  : createTauriDesktopAdapter();

createRoot(rootElement).render(
  <StrictMode>
    <ToolSpanApp adapter={adapter} i18n={i18n} />
  </StrictMode>,
);
