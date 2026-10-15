import type { ThemePreference } from "@ezclaw/core";
import { type Icon, MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useRef, type KeyboardEvent } from "react";
import { useTheme } from "../theme";

const OPTIONS: { value: ThemePreference; label: string; icon: Icon }[] = [
  { value: "system", label: "Ikut OS", icon: MonitorIcon },
  { value: "light", label: "Terang", icon: SunIcon },
  { value: "dark", label: "Gelap", icon: MoonIcon },
];

/** Segmented radio group. `compact` hides the labels visually but keeps them for screen readers. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { pref, setPref } = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent, index: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    const option = OPTIONS[next];
    if (!option) return;
    setPref(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema"
      className="inline-flex w-fit gap-0.5 rounded-sm border border-line bg-sunken p-0.5"
    >
      {OPTIONS.map((option, i) => {
        const checked = option.value === pref;
        const IconCmp = option.icon;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={compact ? option.label : undefined}
            title={compact ? option.label : undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => setPref(option.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={[
              "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-xs text-dense transition-colors duration-150",
              compact ? "w-8" : "px-3",
              checked ? "bg-brand-soft font-semibold text-brand-soft-text" : "text-fg-2 hover:text-fg",
            ].join(" ")}
          >
            <IconCmp size={16} weight={checked ? "fill" : "regular"} aria-hidden />
            {!compact && option.label}
          </button>
        );
      })}
    </div>
  );
}
