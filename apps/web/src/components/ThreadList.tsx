import type { Mode } from "@ezclaw/core";
import { PlusIcon } from "@phosphor-icons/react";
import { Link, useSearch } from "@tanstack/react-router";
import { MODE_INFO } from "../modes";
import { useThreadList } from "../lib/queries";

export function ThreadList({ mode }: { mode: Mode }) {
  const info = MODE_INFO[mode];
  const base = mode === "agent" ? "/agent" : mode === "image" ? "/image" : mode === "edit" ? "/edit" : "/chat";
  const newLabel = mode === "agent" ? "Tugas baru" : mode === "image" ? "Gambar baru" : mode === "edit" ? "Edit baru" : "Thread baru";
  const query = useThreadList(mode);
  const active = (useSearch({ strict: false }) as { t?: string }).t;

  return (
    <section aria-labelledby="thread-list-title" className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        <h2 id="thread-list-title" className="text-meta font-semibold text-fg-3">
          {mode === "agent" ? "Tugas Agent" : `Thread ${info.label}`}
        </h2>
      </div>
      <Link to={base} className="btn btn-secondary justify-start no-underline" aria-label={newLabel}>
        <PlusIcon size={16} aria-hidden />
        {newLabel}
      </Link>

      {query.isPending && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-dense text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat thread
        </p>
      )}

      {query.isError && (
        <div className="grid gap-2 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          <p>{query.error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void query.refetch()}>
            Coba lagi
          </button>
        </div>
      )}

      {query.isSuccess && query.data.threads.length === 0 && (
        <p className="px-2 py-1.5 text-dense text-fg-3">{mode === "agent" ? "Belum ada tugas. Pilih folder dan jelaskan tugas pertama." : mode === "image" ? "Belum ada gambar. Tulis prompt pertama untuk membuatnya." : mode === "edit" ? "Belum ada edit. Pilih gambar dan tulis instruksi pertama." : "Belum ada thread. Kirim pesan pertama untuk membuatnya."}</p>
      )}

      {query.isSuccess && query.data.threads.length > 0 && (
        <ul className="grid gap-px overflow-y-auto">
          {query.data.threads.map((t) => {
            const current = t.id === active;
            return (
              <li key={t.id}>
                <Link
                  to={base}
                  search={{ t: t.id }}
                  aria-current={current ? "page" : undefined}
                  title={t.title}
                  className={[
                    "flex min-h-8 items-center gap-2 rounded-sm px-2 text-dense no-underline transition-colors duration-150",
                    current ? "bg-sunken text-fg" : "text-fg-2 hover:bg-sunken hover:text-fg",
                  ].join(" ")}
                >
                  {t.pinned && <span className="node node-done" aria-label="Disematkan" />}
                  <span className="truncate">{t.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
