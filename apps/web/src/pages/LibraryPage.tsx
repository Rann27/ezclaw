import type { LibraryItem, LibraryResponse } from "@ezclaw/core";
import { DownloadSimpleIcon, HeartIcon, ImagesIcon, PaintBrushIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { AssetImage } from "../components/image/AssetImage";
import { downloadAsset } from "../lib/assets";

const PAGE = 60;

/** Every image made in Image and Edit, in one place. */
export function LibraryPage() {
  const id = useId();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"" | "image" | "edit">("");
  const [model, setModel] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [open, setOpen] = useState<LibraryItem | null>(null);

  useEffect(() => {
    document.title = "Library · EZClaw";
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(favorite ? { favorite: "1" } : {}), limit: String(PAGE) });
  const lib = useInfiniteQuery({
    queryKey: ["library", params.toString()],
    queryFn: ({ pageParam }) => api<LibraryResponse>(`/library?${params.toString()}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const items = lib.data?.pages.flatMap((p) => p.items) ?? [];
  const total = lib.data?.pages[0]?.total ?? 0;
  const models = lib.data?.pages[0]?.models ?? [];

  async function toggleFavorite(item: LibraryItem) {
    await api(`/assets/${item.assetId}`, { method: "PATCH", body: JSON.stringify({ favorite: !item.favorite }) });
    if (open?.assetId === item.assetId) setOpen({ ...item, favorite: !item.favorite });
    void qc.invalidateQueries({ queryKey: ["library"] });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="library-layout mx-auto grid max-w-[1280px] gap-4">
        <header className="library-heading">
          <h1>Library gambar</h1>
          <p className="text-body text-fg-2">Semua gambar dari Image dan Edit. Klik gambar untuk melihat prompt, model, dan tindakan lanjutan.</p>
        </header>

        <div className="library-filters flex flex-wrap items-end gap-3">
          <div className="grid min-w-56 flex-1 gap-1">
            <label htmlFor={`${id}-q`} className="text-dense font-semibold">
              Cari prompt
            </label>
            <input id={`${id}-q`} className="input" value={text} placeholder="misalnya: senja, kucing, poster" onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-mode`} className="text-dense font-semibold">
              Dari
            </label>
            <select id={`${id}-mode`} className="select" value={mode} onChange={(e) => setMode(e.target.value as "" | "image" | "edit")}>
              <option value="">Image dan Edit</option>
              <option value="image">Image</option>
              <option value="edit">Edit</option>
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-model`} className="text-dense font-semibold">
              Model
            </label>
            <select id={`${id}-model`} className="select max-w-64" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Semua model</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="chip-toggle" aria-pressed={favorite} onClick={() => setFavorite((v) => !v)}>
            Hanya favorit
          </button>
        </div>

        {lib.isPending && (
          <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Memuat gambar
          </p>
        )}
        {lib.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">{lib.error.message}</p>
        )}
        {lib.isSuccess && (
          <p className="text-dense text-fg-3" role="status">
            {total} gambar
          </p>
        )}
        {lib.isSuccess && total === 0 && (
          <div className="library-empty rounded-md border border-line bg-surface">
            <ImagesIcon size={36} weight="duotone" aria-hidden />
            <h2 className="text-title font-semibold">{q || mode || model || favorite ? "Tidak ada yang cocok" : "Belum ada gambar"}</h2>
            <p className="text-dense text-fg-2">
              {q || mode || model || favorite ? "Ubah pencarian atau filter di atas." : "Gambar yang kamu buat di Image atau Edit akan terkumpul di sini."}
            </p>
          </div>
        )}

        <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {items.map((item) => (
            <li key={item.assetId} className="group relative">
              <button type="button" className="block w-full overflow-hidden rounded-md border border-line bg-sunken text-left" onClick={() => setOpen(item)} aria-label={`Buka gambar: ${item.prompt || item.threadTitle}`}>
                <AssetImage assetId={item.assetId} alt="" className="aspect-square w-full" />
              </button>
              {item.favorite && (
                <span className="absolute top-2 right-2 rounded-full bg-surface p-1 text-danger-text" role="img" aria-label="Favorit">
                  <HeartIcon size={14} weight="fill" aria-hidden />
                </span>
              )}
              <p className="mt-1 line-clamp-2 text-meta text-fg-2">{item.prompt || item.threadTitle}</p>
            </li>
          ))}
        </ul>

        {lib.hasNextPage && (
          <button type="button" className="btn btn-secondary justify-self-center" disabled={lib.isFetchingNextPage} onClick={() => void lib.fetchNextPage()}>
            {lib.isFetchingNextPage ? "Memuat" : "Muat lebih banyak"}
          </button>
        )}
      </div>

      {open && (
        <Dialog open onClose={() => setOpen(null)} title={open.threadTitle} width="max-w-4xl">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <AssetImage assetId={open.assetId} alt={open.prompt || "Gambar"} natural className="rounded-md" />
            <div className="grid content-start gap-3">
              {open.prompt && (
                <div className="grid gap-1">
                  <h3 className="text-dense font-semibold">Prompt</h3>
                  <p className="whitespace-pre-wrap break-words text-dense text-fg-2">{open.prompt}</p>
                </div>
              )}
              {open.sentPrompt && open.sentPrompt !== open.prompt && (
                <details className="rounded-sm bg-sunken px-3 py-2">
                  <summary className="cursor-pointer text-dense font-semibold text-fg-2">Prompt yang dikirim</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words font-code text-meta text-fg-2">{open.sentPrompt}</p>
                </details>
              )}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-dense">
                <dt className="text-fg-3">Model</dt>
                <dd className="break-all font-code">{open.model ?? "-"}</dd>
                <dt className="text-fg-3">Ukuran</dt>
                <dd>{open.width && open.height ? `${open.width}×${open.height}` : "-"}</dd>
                {open.seed !== null && (
                  <>
                    <dt className="text-fg-3">Seed</dt>
                    <dd className="font-code">{open.seed}</dd>
                  </>
                )}
                <dt className="text-fg-3">Dibuat</dt>
                <dd>{new Date(open.createdAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary" aria-pressed={open.favorite} onClick={() => void toggleFavorite(open)}>
                  <HeartIcon size={16} weight={open.favorite ? "fill" : "regular"} aria-hidden />
                  {open.favorite ? "Hapus dari favorit" : "Favorit"}
                </button>
                <Link to="/edit" search={{ target: open.assetId }} className="btn btn-secondary no-underline">
                  <PaintBrushIcon size={16} aria-hidden />
                  Edit gambar ini
                </Link>
                <button type="button" className="btn btn-ghost" onClick={() => void downloadAsset(open.assetId, `ezclaw-${open.assetId.slice(0, 8)}.png`)}>
                  <DownloadSimpleIcon size={16} aria-hidden />
                  Unduh
                </button>
                <Link to={open.mode === "edit" ? "/edit" : "/image"} search={{ t: open.threadId }} className="btn btn-ghost no-underline">
                  Buka thread
                </Link>
              </div>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
