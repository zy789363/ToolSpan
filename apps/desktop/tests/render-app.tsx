import { render } from "@testing-library/react";

import { ToolSpanApp } from "../src/App";
import { createDemoDesktopAdapter } from "../src/adapters/demo-adapter";
import type { DesktopAdapter, PageId, RuntimeSnapshot } from "../src/adapters/types";
import { createAppI18n, type AppLanguage } from "../src/i18n";
import type { ThemeMode } from "../src/lib/theme";

interface RenderAppOptions {
  adapter?: DesktopAdapter;
  language?: AppLanguage;
  page?: PageId;
  snapshot?: RuntimeSnapshot;
  theme?: ThemeMode;
}

export async function renderApp(options: RenderAppOptions = {}) {
  const i18n = await createAppI18n(options.language ?? "en");
  const adapter = options.adapter ?? createDemoDesktopAdapter(
    options.snapshot === undefined ? {} : { snapshot: options.snapshot },
  );
  return {
    adapter,
    ...render(
      <ToolSpanApp
        adapter={adapter}
        i18n={i18n}
        initialPage={options.page}
        initialTheme={options.theme}
      />,
    ),
  };
}
