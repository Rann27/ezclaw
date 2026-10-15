import type { ImageVersion } from "@ezclaw/core";
import { AssetImage } from "../image/AssetImage";

/**
 * The versions in the order they were made. Each card says which version it came from, so a branch
 * (editing an older version) reads as a branch. Picking a card makes it the image the next edit starts from.
 */
export function LineageStrip({ versions, target, onPick, disabled }: { versions: ImageVersion[]; target: string | null; onPick: (assetId: string) => void; disabled: boolean }) {
  if (versions.length === 0) return null;
  const labelOf = (assetId: string | null) => versions.find((v) => v.assetId === assetId)?.label ?? null;
  return (
    <section aria-labelledby="lineage-h" className="grid gap-2">
      <h2 id="lineage-h" className="text-dense font-semibold text-fg-2">
        Rangkaian versi
      </h2>
      <ol className="flex gap-3 overflow-x-auto pb-2" aria-label="Versi gambar">
        {versions.map((v) => {
          const current = v.assetId === target;
          const from = labelOf(v.parent);
          return (
            <li key={v.assetId} className="w-28 shrink-0">
              <button
                type="button"
                disabled={disabled}
                aria-pressed={current}
                aria-label={`${v.label}${from ? `, dari ${from}` : ", gambar asli"}. Lanjutkan dari versi ini`}
                onClick={() => onPick(v.assetId)}
                className={`grid w-full gap-1 rounded-md border p-1 text-left transition-colors duration-150 ${current ? "border-brand-strong bg-brand-soft" : "border-line bg-surface hover:border-line-strong"}`}
              >
                <AssetImage assetId={v.assetId} alt="" className="h-24 w-full rounded-sm" />
                <span className="flex items-center justify-between gap-1 px-1 text-meta">
                  <strong className="font-semibold text-fg">{v.label}</strong>
                  <span className="truncate text-fg-3">{from ? `dari ${from}` : "asli"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="text-meta text-fg-3">Pilih versi untuk melanjutkan edit dari sana. Versi lain tidak berubah.</p>
    </section>
  );
}
