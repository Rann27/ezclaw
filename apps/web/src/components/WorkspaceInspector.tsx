import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function WorkspaceInspector({ label, mode, children }: { label: string; mode: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className="workspace-inspector w-[var(--inspector-w)] shrink-0 overflow-y-auto">
      <header className="inspector-heading">
        <SlidersHorizontalIcon size={14} aria-hidden />
        <span>Konfigurasi</span>
        <span className="inspector-mode">{mode}</span>
      </header>
      {children}
    </aside>
  );
}
