import { ImageBrokenIcon } from "@phosphor-icons/react";
import { useAssetUrl } from "../../lib/assets";

/** An image from the asset store, with a quiet placeholder while it loads and a plain message if it is gone. */
/** `natural` shows the whole picture at its own proportions instead of cropping to the box. */
export function AssetImage({ assetId, alt, className = "", ratio, natural = false, contain = false }: { assetId: string; alt: string; className?: string; ratio?: string; natural?: boolean; contain?: boolean }) {
  const url = useAssetUrl(assetId);
  const box = `grid place-items-center bg-sunken text-fg-3 ${className}`;

  if (url.isError) {
    return (
      <div className={box} style={ratio ? { aspectRatio: ratio } : undefined} role="img" aria-label={alt}>
        <span className="grid justify-items-center gap-1 px-3 text-center text-meta">
          <ImageBrokenIcon size={20} aria-hidden />
          {url.error.message}
        </span>
      </div>
    );
  }
  if (!url.data) {
    return (
      <div className={box} style={ratio ? { aspectRatio: ratio } : undefined} role="status" aria-label="Memuat gambar">
        <span className="node node-run" aria-hidden />
      </div>
    );
  }
  return <img src={url.data} alt={alt} className={`${natural ? "h-auto w-full" : contain ? "object-contain" : "object-cover"} ${className}`} style={ratio ? { aspectRatio: ratio } : undefined} draggable={false} />;
}
