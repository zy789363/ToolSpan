import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";

type ToastTone = "ok" | "warn";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, opts?: { tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, opts?: { tone?: ToastTone }) => {
    const id = nextId++;
    const tone = opts?.tone ?? "ok";
    setItems((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2100);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="toast-region">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.tone === "warn" ? " toast--warn" : ""}`}>
            {t.tone === "ok" ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
  return ctx;
}
