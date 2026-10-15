import { XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
  footer?: ReactNode;
}

/**
 * Native <dialog>: focus is trapped, Esc closes, and focus returns to the opener.
 * Content mounts only while open so forms start fresh each time.
 */
export function Dialog({ open, onClose, title, children, width = "max-w-lg", footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal focuses the first control (the close button); inputs ask for focus with data-autofocus.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100vw-2rem)] ${width} rounded-lg bg-raised p-0 text-fg shadow-modal backdrop:bg-scrim`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
            <h2 id={titleId} className="text-title font-semibold">
              {title}
            </h2>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Tutup" onClick={onClose}>
              <XIcon size={18} aria-hidden />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
