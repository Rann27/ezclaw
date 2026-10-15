import { THEMES, type Settings, type ThemePreference } from "@ezclaw/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

const STORAGE_KEY = "ezclaw.theme";

function readLocal(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return (THEMES as readonly string[]).includes(value ?? "") ? (value as ThemePreference) : "system";
  } catch {
    return "system";
  }
}

function writeLocal(pref: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage can be blocked; the server copy still holds the preference.
  }
}

function applyToDocument(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

interface ThemeState {
  pref: ThemePreference;
  setPref: (pref: ThemePreference) => void;
  saving: boolean;
  saveError: string | null;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * The database is the source of truth; localStorage only mirrors it so the pre-paint
 * script in index.html can pick the right theme before React loads.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [pref, setPrefState] = useState<ThemePreference>(readLocal);
  const changedLocally = useRef(false);

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/settings") });
  const { mutate, isPending, error } = useMutation({
    mutationFn: (theme: ThemePreference) =>
      api<Settings>("/settings", { method: "PUT", body: JSON.stringify({ theme }) }),
    onSuccess: (data) => queryClient.setQueryData(["settings"], data),
  });

  useEffect(() => {
    if (settings.data && !changedLocally.current) setPrefState(settings.data.theme);
  }, [settings.data]);

  useEffect(() => {
    applyToDocument(pref);
    writeLocal(pref);
  }, [pref]);

  const setPref = useCallback(
    (next: ThemePreference) => {
      changedLocally.current = true;
      setPrefState(next);
      mutate(next);
    },
    [mutate],
  );

  return (
    <ThemeContext.Provider value={{ pref, setPref, saving: isPending, saveError: error?.message ?? null }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme dipakai di luar ThemeProvider");
  return ctx;
}
