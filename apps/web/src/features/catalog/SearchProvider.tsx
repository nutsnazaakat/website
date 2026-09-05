import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface SearchCtx {
  open: boolean;
  setOpen: (o: boolean) => void;
}

const Ctx = createContext<SearchCtx | null>(null);

/**
 * Owns the instant-search dialog's open state and its ⌘K / Ctrl-K shortcut.
 *
 * It lives here rather than inside `SearchDialog` because two separate surfaces open the
 * same dialog — the header's search button and the mobile tab bar's Search tab — and
 * neither should own the other's state. Mounted inside the root route's layout, so the
 * provider is in scope for every route without changing the app's provider stack.
 */
export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSearchDialog() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSearchDialog must be used inside SearchProvider");
  return c;
}
