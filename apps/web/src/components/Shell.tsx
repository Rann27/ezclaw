import { MODES, type Mode } from "@ezclaw/core";
import { GearSixIcon, ImagesIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type RefObject } from "react";
import { MODE_INFO } from "../modes";
import { ThemeSwitch } from "./ThemeSwitch";
import { ThreadList } from "./ThreadList";
import { StaleServerBanner } from "./StaleServerBanner";
import { SearchDialog } from "./SearchDialog";

function modeFromPath(pathname: string): Mode | null {
  const first = pathname.split("/")[1] ?? "";
  return (MODES as readonly string[]).includes(first) ? (first as Mode) : null;
}

/**
 * The thread header and the composer float over the scrolling work (glass shows what passes under
 * them), so each work stage gets its scroller padded by their live heights: nothing ever hides
 * behind them, however tall the composer grows. One observer here instead of a hook in every page.
 */
function useFloatingChrome(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const watched = new WeakSet<Element>();
    const sync = () => {
      for (const stage of el.querySelectorAll<HTMLElement>(".workbench-stage")) {
        const head = stage.querySelector<HTMLElement>(":scope > .thread-header");
        const foot = stage.querySelector<HTMLElement>(":scope > form");
        for (const node of [head, foot]) {
          if (node && !watched.has(node)) {
            watched.add(node);
            sizes.observe(node);
          }
        }
        const footMargin = foot ? parseFloat(getComputedStyle(foot).marginBottom) || 0 : 0;
        stage.style.setProperty("--float-top", `${head?.offsetHeight ?? 0}px`);
        stage.style.setProperty("--float-bottom", `${foot ? foot.offsetHeight + footMargin : 0}px`);
      }
    };
    const sizes = new ResizeObserver(sync);
    const tree = new MutationObserver(sync);
    tree.observe(el, { childList: true, subtree: true });
    sync();
    return () => {
      sizes.disconnect();
      tree.disconnect();
    };
  }, [root]);
}

/** Mode and page changes ease in, so the eye follows the switch instead of seeing a jump. */
function useRouteEntrance(target: RefObject<HTMLElement | null>, section: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    target.current?.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [section, target]);
}

function Wordmark() {
  return (
    <span className="wordmark">
      <span className="text-brand-text">EZ</span>Claw
    </span>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = pathname.startsWith("/settings");
  const currentMode = modeFromPath(pathname);
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useFloatingChrome(mainRef);
  // A thread change inside the same mode is not a page change; only the section is.
  useRouteEntrance(bodyRef, inSettings ? `settings${pathname}` : (pathname.split("/")[1] ?? ""));

  // Ctrl+K (Cmd+K) opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  return (
    <div className="app-shell">
      <a href="#workspace" className="skip-link" onClick={() => mainRef.current?.focus()}>Ke ruang kerja</a>
      <aside
        id="rail"
        aria-label="Navigasi"
        className="app-rail"
      >
        <div className="rail-brand">
          <div>
            <Wordmark />
            <p className="mt-1 text-dense text-fg-2">Ruang kerja pribadi</p>
          </div>
        </div>

        <button type="button" className="rail-search" onClick={() => setSearchOpen(true)}>
          <MagnifyingGlassIcon size={19} aria-hidden />
          <span>Cari percakapan</span>
          <kbd aria-label="Pintasan Ctrl K">Ctrl K</kbd>
        </button>

        <nav aria-label="Mode">
          <ul className="grid gap-1">
            {MODES.map((mode, i) => {
              const info = MODE_INFO[mode];
              const active = currentMode === mode;
              const IconCmp = info.icon;
              return (
                <li key={mode}>
                  <Link
                    to={`/${mode}`}
                    aria-current={active ? "page" : undefined}
                    className={`rail-link ${active ? "rail-link-active" : ""}`}
                  >
                    <IconCmp size={20} weight={active ? "fill" : "regular"} aria-hidden />
                    <span className="flex-1">{info.label}</span>
                    <kbd className="rail-shortcut" aria-label={`Pintasan Alt ${i + 1}`}>
                      Alt {i + 1}
                    </kbd>
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul className="mt-1 grid gap-1">
            <li>
              <Link
                to="/library"
                aria-current={pathname.startsWith("/library") ? "page" : undefined}
                className={`rail-link ${pathname.startsWith("/library") ? "rail-link-active" : ""}`}
              >
                <ImagesIcon size={20} weight={pathname.startsWith("/library") ? "fill" : "regular"} aria-hidden />
                <span className="flex-1">Library</span>
              </Link>
            </li>
          </ul>
        </nav>

        {currentMode && <ThreadList mode={currentMode} />}
        {!currentMode && <div className="flex-1" />}

        <footer className="rail-footer">
          <Link
            to="/settings"
            aria-current={inSettings ? "page" : undefined}
            className={`rail-link ${inSettings ? "rail-link-active" : ""}`}
          >
            <GearSixIcon size={20} weight={inSettings ? "fill" : "regular"} aria-hidden />
            Settings
          </Link>
          <div className="flex items-center justify-between gap-2 px-2 pt-2">
            <span className="text-dense text-fg-2">Tampilan</span>
            <ThemeSwitch compact />
          </div>
        </footer>
      </aside>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />

      <main id="workspace" ref={mainRef} tabIndex={-1} className="app-workspace">
        <StaleServerBanner />
        {/* The only scroller at this level: a banner above it no longer pushes the page past the window. */}
        <div ref={bodyRef} className="workspace-body">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
