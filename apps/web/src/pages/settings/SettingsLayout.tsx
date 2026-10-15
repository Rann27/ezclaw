import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

const TABS = [
  { to: "/settings", label: "Umum", exact: true },
  { to: "/settings/endpoints", label: "Endpoint", exact: false },
  { to: "/settings/models", label: "Model", exact: false },
  { to: "/settings/harness", label: "Harness", exact: false },
] as const;

export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    document.title = "Settings · EZClaw";
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="mb-4 text-page font-semibold">Settings</h1>
      <nav aria-label="Bagian settings" className="mb-8 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.to : pathname.startsWith(tab.to);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? "page" : undefined}
              className={[
                "-mb-px min-h-9 border-b-2 px-3 py-2 text-ui no-underline transition-colors duration-150",
                active ? "border-brand-strong font-semibold text-fg" : "border-transparent text-fg-2 hover:text-fg",
              ].join(" ")}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}
