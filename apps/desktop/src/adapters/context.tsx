import { createContext, type ReactNode, useContext } from "react";

import type { DesktopAdapter } from "./types";

const DesktopAdapterContext = createContext<DesktopAdapter | null>(null);

export function DesktopAdapterProvider({
  adapter,
  children,
}: {
  adapter: DesktopAdapter;
  children: ReactNode;
}) {
  return (
    <DesktopAdapterContext.Provider value={adapter}>
      {children}
    </DesktopAdapterContext.Provider>
  );
}

export function useDesktopAdapter(): DesktopAdapter {
  const adapter = useContext(DesktopAdapterContext);
  if (adapter === null) throw new Error("DesktopAdapterProvider is required");
  return adapter;
}
