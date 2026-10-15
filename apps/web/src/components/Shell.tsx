import { MODES, type Mode } from "@ezclaw/core";
import { GearSixIcon, ListIcon, XIcon } from "@phosphor-icons/react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MODE_INFO } from "../modes";
import { ThemeSwitch } from "./ThemeSwitch";
import { ThreadList } from "./ThreadList";

const DESKTOP_QUERY = "(min-width: 768px)";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );
}

function modeFromPath(pathname: string): Mode | null {
  const first = pathname.split("/")[1] ?? "";
  return (MODES as readonly string[]).includes(first) ? (first as Mode) : null;
}

function Wordmark() {
  return (
    <span className="text-title font-bold tracking-tight">
      <span className="text-brand-text">EZ</span>Claw
    </span>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = pathname.startsWith("/settings");
  const currentMode = modeFromPath(pathname);
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  // Close the drawer after navigating, and whenever the layout becomes desktop.
  useEffect(() => setDrawerOpen(false), [pathname, isDesktop]);

  useEffect(() => {
    if (!drawerOpen) return;
    railRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Alt+1..4 switches mode (Ctrl+number is taken by the browser's tab switching).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const mode = MODES[Number(e.key) - 1];
      if (!mode) return;
      e.preventDefault();
      void navigate({ to: `/${mode}` });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const railHidden = !isDesktop && !drawerOpen;

  return (
    <div className="flex h-full flex-col bg-canvas md:flex-row">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 md:hidden">
        <button
          ref={menuButton}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Buka navigasi"
          aria-expanded={drawerOpen}
          aria-controls="rail"
          onClick={() => setDrawerOpen(true)}
        >
          <ListIcon size={20} aria-hidden />
        </button>
        <Wordmark />
      </header>

      {drawerOpen && (
        <button
          type="button"
          aria-label="Tutup navigasi"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-scrim md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <aside
        id="rail"
        ref={railRef}
        aria-label="Navigasi"
        inert={railHidden}
        className={[
          "fixed inset-y-0 left-0 z-40 flex w-[var(--rail-w)] max-w-[85vw] flex-col gap-5 border-r border-line bg-surface p-3",
          "transition-transform duration-200 ease-ez md:static md:z-auto md:max-w-none md:translate-x-0",
          railHidden ? "-translate-x-full" : "translate-x-0",
        ].join(" ")}
      >
        <div className="flex items-center justify-between px-2 pt-1">
          <Wordmark />
          <button
            type="button"
            className="btn btn-ghost btn-icon md:hidden"
            aria-label="Tutup navigasi"
            onClick={() => {
              setDrawerOpen(false);
              menuButton.current?.focus();
            }}
          >
            <XIcon size={18} aria-hidden />
          </button>
        </div>

        <nav aria-label="Mode">
          <ul className="grid gap-0.5">
            {MODES.map((mode, i) => {
              const info = MODE_INFO[mode];
              const active = currentMode === mode;
              const IconCmp = info.icon;
              return (
                <li key={mode}>
                  <Link
                    to={`/${mode}`}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "flex min-h-9 items-center gap-2 rounded-sm px-2 text-ui no-underline transition-colors duration-150",
                      active ? "bg-brand-soft font-semibold text-brand-soft-text" : "text-fg-2 hover:bg-sunken hover:text-fg",
                    ].join(" ")}
                  >
                    <IconCmp size={20} weight={active ? "fill" : "regular"} aria-hidden />
                    <span className="flex-1">{info.label}</span>
                    <kbd className="text-meta text-fg-3" aria-label={`Pintasan Alt ${i + 1}`}>
                      Alt {i + 1}
                    </kbd>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {currentMode && <ThreadList mode={currentMode} />}
        {!currentMode && <div className="flex-1" />}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
          <Link
            to="/settings"
            aria-current={inSettings ? "page" : undefined}
            className={[
              "flex min-h-9 items-center gap-2 rounded-sm px-2 text-ui no-underline transition-colors duration-150",
              inSettings ? "bg-brand-soft font-semibold text-brand-soft-text" : "text-fg-2 hover:bg-sunken hover:text-fg",
            ].join(" ")}
          >
            <GearSixIcon size={20} weight={inSettings ? "fill" : "regular"} aria-hidden />
            Settings
          </Link>
          <ThemeSwitch compact />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
