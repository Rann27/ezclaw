import { useEffect, useState } from "react";
import { AssetImage } from "./AssetImage";

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Stand-in for an image that is still being made. Providers send the finished picture in one piece
 * (no partial frames), so this shows the shape of the result, a running clock, and for an edit the
 * image being changed, faded underneath.
 */
export function ImageLoader({
  status,
  ratio = "1 / 1",
  backdropAssetId,
  className = "",
}: {
  status: "queued" | "running";
  /** CSS aspect-ratio of the expected result; ignored when a backdrop gives the shape. */
  ratio?: string;
  /** Edit: the image being changed, shown faded so the result's shape and content are clear. */
  backdropAssetId?: string | null;
  className?: string;
}) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (status !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [status]);

  const running = status === "running";
  return (
    <div className={`img-loader relative overflow-hidden rounded-md border border-line bg-sunken ${className}`} role="status" aria-live="polite" data-running={running || undefined}>
      {backdropAssetId ? (
        <div className="img-loader-backdrop" aria-hidden>
          <AssetImage assetId={backdropAssetId} alt="" natural />
        </div>
      ) : (
        <div style={{ aspectRatio: ratio }} aria-hidden />
      )}
      <div className="absolute inset-0 grid place-items-center p-2 text-center">
        <span className="grid justify-items-center gap-1.5 rounded-sm bg-surface/85 px-3 py-2 text-dense text-fg-2">
          <span className={running ? "node node-run" : "node node-skip"} aria-hidden />
          <span className="font-semibold text-fg">{running ? "Sedang dibuat" : "Menunggu giliran"}</span>
          {running && <span className="font-code text-meta text-fg-3">{elapsed(now - start)}</span>}
        </span>
      </div>
    </div>
  );
}

/** "16:9" or "1536x1024" as a CSS aspect-ratio; square when unknown. */
export function ratioFromParams(p: { aspectRatio?: string; size?: string }): string {
  const m = (p.aspectRatio ?? "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/) ?? (p.size ?? "").match(/^(\d+)[x*](\d+)$/);
  return m ? `${m[1]} / ${m[2]}` : "1 / 1";
}
