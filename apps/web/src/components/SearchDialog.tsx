import type { SearchResponse } from "@ezclaw/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { MODE_INFO } from "../modes";
import { Dialog } from "./Dialog";

const BASE = { chat: "/chat", agent: "/agent", image: "/image", edit: "/edit" } as const;

/** Finds threads by title or by what was said in them, across every mode. */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (open) {
      setText("");
      setQ("");
    }
  }, [open]);

  const search = useQuery({
    queryKey: ["search", q],
    queryFn: () => api<SearchResponse>(`/search?q=${encodeURIComponent(q)}`),
    enabled: open && q.length >= 2,
    staleTime: 5_000,
  });
  const hits = search.data?.hits ?? [];
  useEffect(() => setActive(0), [q]);

  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    onClose();
    void navigate({ to: BASE[h.mode], search: { t: h.threadId } });
  };

  function onKey(e: KeyboardEvent) {
    if (!hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(active);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Cari" width="max-w-2xl" motion={false}>
      <div className="grid gap-3">
        <label htmlFor={`${id}-q`} className="text-dense font-semibold">
          Cari judul atau isi percakapan
        </label>
        <input
          id={`${id}-q`}
          autoFocus
          className="input"
          value={text}
          placeholder="Judul, isi pesan, atau prompt gambar"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={hits.length ? `${id}-${active}` : undefined}
        />
        {q.length >= 2 && search.isPending && (
          <p className="flex items-center gap-2 text-dense text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Mencari
          </p>
        )}
        {search.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {search.error.message}
          </p>
        )}
        {search.isSuccess && hits.length === 0 && <p className="text-dense text-fg-3">Tidak ada yang cocok dengan "{q}".</p>}
        {text.trim().length > 0 && text.trim().length < 2 && <p className="text-dense text-fg-3">Ketik minimal 2 huruf.</p>}
        <ul id={`${id}-list`} role="listbox" aria-label="Hasil pencarian" className="grid max-h-[60vh] gap-1 overflow-y-auto">
          {hits.map((h, i) => (
            <li
              key={`${h.threadId}-${h.in}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`grid cursor-pointer gap-0.5 rounded-sm px-3 py-2 ${i === active ? "bg-sunken" : "hover:bg-sunken"}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(i)}
            >
              <span className="flex min-w-0 items-center gap-2 text-dense">
                <span className="ep-tag shrink-0">{MODE_INFO[h.mode].label}</span>
                <span className="min-w-0 truncate font-semibold">{h.title}</span>
                <span className="ml-auto shrink-0 text-meta text-fg-3">{new Date(h.updatedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}</span>
              </span>
              {h.in === "message" && (
                <span className="line-clamp-2 break-words text-meta text-fg-2">
                  {h.role === "user" ? "Kamu: " : h.role === "tool" ? "Tool: " : ""}
                  {h.before}
                  <mark className="rounded-xs bg-brand-soft px-0.5 text-brand-soft-text">{h.match}</mark>
                  {h.after}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
