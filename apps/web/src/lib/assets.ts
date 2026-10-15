import type { AssetDto } from "@ezclaw/core";
import { TOKEN_HEADER, TOKEN_META } from "@ezclaw/core";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api";

function sessionToken(): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
}

/** The page cannot give `<img>` a header, so images are fetched with the session token and shown from a blob. */
async function fetchBlob(assetId: string, download = false): Promise<Blob> {
  const res = await fetch(`/api/assets/${assetId}${download ? "?download=1" : ""}`, { headers: { [TOKEN_HEADER]: sessionToken() } });
  if (!res.ok) throw new ApiError(res.status, "asset", res.status === 404 ? "Gambar ini tidak ada lagi di folder data EZClaw." : "Gambar tidak bisa dimuat.");
  return res.blob();
}

export const assetKeys = {
  blob: (id: string) => ["asset-blob", id] as const,
  info: (id: string) => ["asset-info", id] as const,
};

/** Object URL for an asset. The blob is cached for the session; the URL is released with the cache entry. */
export function useAssetUrl(assetId: string | null | undefined) {
  return useQuery({
    queryKey: assetKeys.blob(assetId ?? ""),
    queryFn: async () => URL.createObjectURL(await fetchBlob(assetId!)),
    enabled: !!assetId,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

export const useAssetInfo = (assetId: string | null | undefined) =>
  useQuery({ queryKey: assetKeys.info(assetId ?? ""), queryFn: () => api<AssetDto>(`/assets/${assetId}/info`), enabled: !!assetId, staleTime: Infinity });

export async function uploadAsset(file: Blob): Promise<AssetDto> {
  const res = await fetch("/api/assets", { method: "POST", headers: { [TOKEN_HEADER]: sessionToken(), "content-type": "application/octet-stream" }, body: file });
  const body = (await res.json().catch(() => null)) as (AssetDto & { error?: { message?: string } }) | null;
  if (!res.ok || !body) throw new ApiError(res.status, "upload", body?.error?.message ?? "Gambar tidak bisa diunggah.");
  return body;
}

/** Saves an asset through the browser's download flow. */
export async function downloadAsset(assetId: string, name: string) {
  const url = URL.createObjectURL(await fetchBlob(assetId, true));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";
