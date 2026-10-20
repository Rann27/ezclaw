import sharp from "sharp";
import { sniffImage } from "./imageInfo.js";

/**
 * Resizes an image to exactly width x height, keeping its format. Providers that only take an aspect
 * ratio and a size tier return a size near the target; this closes the gap. The whole frame is kept
 * (a slight stretch rather than a crop), so the result still lines up with the original.
 * Returns null when the image already has that size or cannot be read.
 */
export async function matchSize(bytes: Buffer, width: number, height: number): Promise<{ bytes: Buffer; from: { width: number; height: number } } | null> {
  const info = sniffImage(bytes);
  if (!info || info.width === null || info.height === null) return null;
  if (info.width === width && info.height === height) return null;
  const img = sharp(bytes, { failOn: "none" }).resize(width, height, { fit: "fill", kernel: "lanczos3" });
  const out =
    info.mime === "image/jpeg"
      ? await img.jpeg({ quality: 95, mozjpeg: true }).toBuffer()
      : info.mime === "image/webp"
        ? await img.webp({ quality: 95 }).toBuffer()
        : await img.png().toBuffer();
  return { bytes: out, from: { width: info.width, height: info.height } };
}

/** Smallest size tier whose long side covers `longSide`, so downscaling never has to invent detail. */
export function tierFor(longSide: number, tiers: readonly string[] = ["1K", "2K", "4K"]): string {
  const px = (t: string) => Number.parseInt(t, 10) * 1024;
  return tiers.find((t) => px(t) >= longSide) ?? tiers[tiers.length - 1]!;
}
