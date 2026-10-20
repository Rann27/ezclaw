import type { HealthResponse } from "@ezclaw/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * The page is read from disk on every load, the server code only at start. After a rebuild the two
 * can disagree (new page, old server), which sends requests the page does not expect. Say so.
 */
/** The main script this page is running; compared with the latest build the server has on disk. */
function pageIsOld(latest: string | null | undefined): boolean {
  if (!latest) return false;
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
  // Dev server (Vite) pages have no built entry to compare.
  return !!mine && mine.startsWith("/assets/") && mine !== latest;
}

export function StaleServerBanner() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthResponse>("/health"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  if (health.data && pageIsOld(health.data.webEntry)) {
    return (
      <p className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ember-soft px-4 py-2 text-dense text-ember-text" role="alert">
        Halaman ini masih versi lama, EZClaw sudah diperbarui.
        <button type="button" className="btn btn-secondary min-h-8 px-2 text-dense" onClick={() => window.location.reload()}>
          Muat ulang halaman
        </button>
      </p>
    );
  }
  if (!health.data?.stale) return null;
  return (
    <p className="sticky top-0 z-20 border-b border-line bg-ember-soft px-4 py-2 text-dense text-ember-text" role="alert">
      EZClaw sudah diperbarui, tapi server masih menjalankan versi lama. Tutup jendela run.bat lalu jalankan lagi sebelum mengirim permintaan, supaya halaman dan server memakai versi yang sama.
    </p>
  );
}
