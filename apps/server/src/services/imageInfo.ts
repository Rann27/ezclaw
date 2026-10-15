export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  ext: "png" | "jpg" | "webp" | "gif";
  width: number | null;
  height: number | null;
}

/**
 * Identifies an image from its first bytes and reads its size. The type is never taken from a
 * file name or a header the sender controls, so a renamed file cannot pass as an image.
 * Returns null for anything else.
 */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg", ...jpegSize(buf) };
  }
  if (buf.length >= 10 && buf.subarray(0, 4).toString("latin1") === "GIF8") {
    return { mime: "image/gif", ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 16 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mime: "image/webp", ext: "webp", ...webpSize(buf) };
  }
  return null;
}

function jpegSize(buf: Buffer): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return { width: null, height: null };
}

function webpSize(buf: Buffer): { width: number | null; height: number | null } {
  const kind = buf.subarray(12, 16).toString("latin1");
  if (kind === "VP8X" && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (kind === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return { width: null, height: null };
}

export function toDataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Decodes a `data:image/...;base64,` URL. Returns null when it is anything else. */
export function fromDataUrl(url: string): Buffer | null {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  return m ? Buffer.from(m[1]!, "base64") : null;
}
