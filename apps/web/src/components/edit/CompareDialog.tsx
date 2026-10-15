import type { ImageVersion } from "@ezclaw/core";
import { useEffect, useId, useState } from "react";
import { Dialog } from "../Dialog";
import { AssetImage } from "../image/AssetImage";

type View = "side" | "slide";

const describe = (v: ImageVersion) => (v.parent === null ? `${v.label}, gambar asli` : v.label);

/** Any two versions, side by side or with a slider that reveals one over the other. */
export function CompareDialog({ open, onClose, versions, initial }: { open: boolean; onClose: () => void; versions: ImageVersion[]; initial: { a: string; b: string } | null }) {
  const id = useId();
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [view, setView] = useState<View>("slide");
  const [pos, setPos] = useState(50);

  useEffect(() => {
    if (!open) return;
    setA(initial?.a ?? versions[0]?.assetId ?? "");
    setB(initial?.b ?? versions.at(-1)?.assetId ?? "");
    setPos(50);
  }, [open, initial?.a, initial?.b, versions]);

  const va = versions.find((v) => v.assetId === a);
  const vb = versions.find((v) => v.assetId === b);

  return (
    <Dialog open={open} onClose={onClose} title="Bandingkan versi" width="max-w-5xl">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <VersionSelect id={`${id}-a`} label="Kiri" value={a} versions={versions} onChange={setA} />
          <VersionSelect id={`${id}-b`} label="Kanan" value={b} versions={versions} onChange={setB} />
          <div className="flex gap-1" role="group" aria-label="Tampilan perbandingan">
            <button type="button" className="chip-toggle" aria-pressed={view === "slide"} onClick={() => setView("slide")}>
              Geser
            </button>
            <button type="button" className="chip-toggle" aria-pressed={view === "side"} onClick={() => setView("side")}>
              Berdampingan
            </button>
          </div>
        </div>

        {versions.length < 2 && <p className="text-ui text-fg-2">Belum ada versi untuk dibandingkan. Buat satu edit dulu.</p>}

        {a && b && view === "side" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="grid gap-1">
              <AssetImage assetId={a} alt={`Versi ${va?.label ?? "kiri"}`} contain className="h-[50vh] w-full rounded-sm bg-sunken" />
              <figcaption className="text-meta text-fg-2">{va ? describe(va) : ""}</figcaption>
            </figure>
            <figure className="grid gap-1">
              <AssetImage assetId={b} alt={`Versi ${vb?.label ?? "kanan"}`} contain className="h-[50vh] w-full rounded-sm bg-sunken" />
              <figcaption className="text-meta text-fg-2">{vb ? describe(vb) : ""}</figcaption>
            </figure>
          </div>
        )}

        {a && b && view === "slide" && (
          <div className="grid gap-2">
            <div className="relative grid overflow-hidden rounded-sm bg-sunken">
              <div className="[grid-area:1/1]">
                <AssetImage assetId={b} alt={`Versi ${vb?.label ?? "kanan"}`} contain className="h-[52vh] w-full" />
              </div>
              <div className="[grid-area:1/1]" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
                <AssetImage assetId={a} alt={`Versi ${va?.label ?? "kiri"}`} contain className="h-[52vh] w-full" />
              </div>
              <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-surface shadow-popover" style={{ left: `${pos}%` }} />
              <span className="absolute left-2 top-2 rounded-sm bg-surface px-1.5 text-meta text-fg">{va?.label}</span>
              <span className="absolute right-2 top-2 rounded-sm bg-surface px-1.5 text-meta text-fg">{vb?.label}</span>
            </div>
            <label htmlFor={`${id}-pos`} className="sr-only">
              Posisi geser: kiri {pos}%, kanan {100 - pos}%
            </label>
            <input id={`${id}-pos`} type="range" min={0} max={100} step={1} value={pos} onChange={(e) => setPos(Number(e.target.value))} className="w-full accent-[var(--color-brand-strong)]" />
            <p className="text-meta text-fg-3">Geser untuk melihat {va?.label} di kiri dan {vb?.label} di kanan.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function VersionSelect({ id, label, value, versions, onChange }: { id: string; label: string; value: string; versions: ImageVersion[]; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-meta text-fg-3">
        {label}
      </label>
      <select id={id} className="select w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
        {versions.map((v) => (
          <option key={v.assetId} value={v.assetId}>
            {v.parent === null ? `${v.label} (asli)` : v.label}
          </option>
        ))}
      </select>
    </div>
  );
}
