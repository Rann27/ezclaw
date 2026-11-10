import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { BooksIcon, BrainIcon, CirclesThreePlusIcon, CpuIcon, GearSixIcon, PlugsConnectedIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";

const TABS = [
  { to: "/settings", label: "Umum", icon: GearSixIcon, exact: true },
  { to: "/settings/endpoints", label: "Endpoint", icon: PlugsConnectedIcon, exact: false },
  { to: "/settings/models", label: "Model", icon: CpuIcon, exact: false },
  { to: "/settings/harness", label: "Harness", icon: SlidersHorizontalIcon, exact: false },
  { to: "/settings/memory", label: "Memori", icon: BrainIcon, exact: false },
  { to: "/settings/mcp", label: "MCP", icon: CirclesThreePlusIcon, exact: false },
  { to: "/settings/skills", label: "Skills", icon: BooksIcon, exact: false },
] as const;

export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    document.title = "Settings · EZClaw";
  }, []);

  return (
    <div className="settings-layout">
      <header className="settings-heading">
        <GearSixIcon size={32} weight="duotone" aria-hidden />
        <div><h1>Atur ruang kerjamu</h1><p>Model, koneksi, dan cara EZClaw bekerja untukmu.</p></div>
      </header>
      <nav aria-label="Bagian settings" className="settings-tabs">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.to : pathname.startsWith(tab.to);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? "page" : undefined}
              className="settings-tab"
            >
              <Icon size={18} weight={active ? "fill" : "regular"} aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="settings-content"><Outlet /></div>
    </div>
  );
}
