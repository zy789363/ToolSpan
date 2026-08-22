import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "light" | "dark" | "system";
export type MotionMode = "system" | "reduce";

const THEME_STORAGE_KEY = "toolspan.ui.theme";
const MOTION_STORAGE_KEY = "toolspan.ui.motion";

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  motion: MotionMode;
  setTheme(theme: ThemeMode): void;
  setMotion(motion: MotionMode): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readTheme(): ThemeMode {
  const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readMotion(): MotionMode {
  return globalThis.localStorage?.getItem(MOTION_STORAGE_KEY) === "reduce" ? "reduce" : "system";
}

function systemDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export interface ThemeProviderProps {
  children: ReactNode;
  initialTheme?: ThemeMode | undefined;
  initialMotion?: MotionMode | undefined;
}

export function ThemeProvider({
  children,
  initialTheme,
  initialMotion,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<ThemeMode>(() => initialTheme ?? readTheme());
  const [motion, setMotion] = useState<MotionMode>(() => initialMotion ?? readMotion());
  const [darkSystem, setDarkSystem] = useState(systemDark);
  const resolvedTheme = theme === "system" ? (darkSystem ? "dark" : "light") : theme;

  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (query === undefined) return;
    const update = () => setDarkSystem(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
    document.documentElement.style.colorScheme = resolvedTheme;
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  }, [resolvedTheme, theme]);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(motion === "reduce");
    globalThis.localStorage?.setItem(MOTION_STORAGE_KEY, motion);
  }, [motion]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, motion, setTheme, setMotion }),
    [theme, resolvedTheme, motion],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("ThemeProvider is required");
  return value;
}
