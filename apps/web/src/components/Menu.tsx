import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A button that opens a list of actions. The list is placed on top of the page (not inside the
 * scrolling sidebar), and works with the keyboard: arrows move, Enter picks, Esc closes.
 */
export function Menu({ label, items, trigger, className = "" }: { label: string; items: MenuItem[]; trigger: ReactNode; className?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = 208;
    const height = Math.min(items.length * 36 + 8, 320);
    const top = r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - height - 4) : r.bottom + 4;
    setPos({ top, left: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8) });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    setActive(enabled[0] ?? 0);
    list.current?.focus();
    const close = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => window.removeEventListener("mousedown", close);
    // Reset only when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    setOpen(false);
    button.current?.focus();
    it.onSelect();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className="fixed z-50 grid w-52 gap-px rounded-md border border-line bg-raised py-1 shadow-popover focus:outline-none"
            style={{ top: pos.top, left: pos.left }}
            onKeyDown={(e) => {
              const at = enabled.indexOf(active);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = enabled[(at + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length];
                if (next !== undefined) setActive(next);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick(active);
              } else if (e.key === "Escape" || e.key === "Tab") {
                e.preventDefault();
                setOpen(false);
                button.current?.focus();
              }
            }}
          >
            {items.map((it, i) => (
              <li
                key={it.label}
                role="menuitem"
                aria-disabled={it.disabled || undefined}
                className={[
                  "mx-1 flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-dense",
                  it.disabled ? "cursor-not-allowed text-fg-3" : it.danger ? "text-danger-text" : "text-fg",
                  i === active && !it.disabled ? "bg-sunken" : "",
                ].join(" ")}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => pick(i)}
              >
                {it.icon}
                {it.label}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
