import type { Protocol } from "@ezclaw/core";

export type EndpointKind = "provider" | "gateway" | "local" | "custom";
export type AuthType = "bearer" | "header" | "none";
export type DiscoveryParser = "openrouter" | "venice" | "anthropic" | "openai";

export interface AuthSpec {
  type: AuthType;
  /** Header name when type is "header" (e.g. "x-api-key", "api-key"). */
  headerName?: string;
}

export interface EndpointPreset {
  id: string;
  name: string;
  kind: EndpointKind;
  protocol: Protocol;
  /** Other protocols the provider also accepts. */
  alsoSupports?: Protocol[];
  baseUrl: string;
  /** Alternative base URLs for providers that run separate regions. */
  regions?: { id: string; label: string; baseUrl: string }[];
  auth: AuthSpec;
  needsKey: boolean;
  discovery: DiscoveryParser;
  /** Used when the provider has no model list endpoint (or it fails with 404/405). */
  suggestedModels?: { modelId: string; name: string }[];
  docsUrl?: string;
  notes?: string[];
}

const bearer: AuthSpec = { type: "bearer" };

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "provider",
    protocol: "openai-responses",
    alsoSupports: ["openai-chat"],
    baseUrl: "https://api.openai.com/v1",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    docsUrl: "https://developers.openai.com/api/docs",
    notes: ["Memakai Responses API, yang dibutuhkan untuk tools di GPT-6 Astra dan Sol. Chat Completions tetap bisa dipilih untuk model yang mendukungnya."],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "provider",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { type: "header", headerName: "x-api-key" },
    needsKey: true,
    discovery: "anthropic",
    docsUrl: "https://platform.claude.com/docs",
  },
  {
    id: "google",
    name: "Google Gemini",
    kind: "provider",
    protocol: "openai-chat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    notes: ["Lewat lapisan kompatibel OpenAI. Generate gambar Gemini native menyusul di M3."],
  },
  {
    id: "xai",
    name: "xAI",
    kind: "provider",
    protocol: "openai-chat",
    alsoSupports: ["openai-responses"],
    baseUrl: "https://api.x.ai/v1",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    docsUrl: "https://docs.x.ai/docs",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    kind: "provider",
    protocol: "openai-chat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    regions: [
      { id: "intl", label: "Internasional (Singapura)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      { id: "cn", label: "China (Beijing)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/",
    notes: ["Alibaba menyarankan domain per-workspace (https://WORKSPACE.REGION.maas.aliyuncs.com/compatible-mode/v1). Domain lama ini masih berfungsi. Ganti base URL jika kamu memakai domain workspace."],
  },
  {
    id: "zai",
    name: "Z.ai GLM",
    kind: "provider",
    protocol: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    suggestedModels: [{ modelId: "glm-4.6", name: "GLM-4.6" }],
    docsUrl: "https://docs.z.ai",
    notes: ["Hanya region internasional yang terverifikasi. Untuk region lain, ubah base URL secara manual."],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "provider",
    protocol: "openai-chat",
    alsoSupports: ["openai-responses"],
    baseUrl: "https://api.deepseek.com",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    suggestedModels: [
      { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
      { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
    docsUrl: "https://api-docs.deepseek.com",
    notes: [
      "Daftar model tidak terdokumentasi resmi. Jika gagal dimuat, model yang disarankan dipakai dan kamu bisa menambah ID manual.",
      "Chat Completions mendukung deepseek-flash dan deepseek-v4-pro. Responses (wire yang dipakai Codex) terdokumentasi untuk deepseek-flash.",
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    kind: "provider",
    protocol: "openai-chat",
    baseUrl: "https://api.minimax.io/v1",
    auth: bearer,
    needsKey: true,
    discovery: "openai",
    suggestedModels: [
      { modelId: "MiniMax-M3", name: "MiniMax M3" },
      { modelId: "MiniMax-M2.7", name: "MiniMax M2.7" },
    ],
    docsUrl: "https://platform.minimax.io/docs",
    notes: ["Hanya base URL internasional yang terverifikasi."],
  },
  {
    id: "mimo",
    name: "Xiaomi MiMo",
    kind: "provider",
    protocol: "openai-chat",
    baseUrl: "https://api.xiaomimimo.com/v1",
    regions: [
      { id: "payg", label: "Bayar sesuai pemakaian", baseUrl: "https://api.xiaomimimo.com/v1" },
      { id: "token-plan", label: "Token Plan (kunci tp-...)", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
    ],
    auth: { type: "header", headerName: "api-key" },
    needsKey: true,
    discovery: "openai",
    suggestedModels: [{ modelId: "mimo-v2.6-pro", name: "MiMo V2.6 Pro" }],
    docsUrl: "https://mimo.mi.com/static/docs/",
    notes: ["Auth memakai header api-key, bukan Bearer. Token Plan memakai host dan kunci tersendiri."],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "gateway",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: bearer,
    needsKey: true,
    discovery: "openrouter",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "venice",
    name: "Venice.ai",
    kind: "gateway",
    protocol: "openai-chat",
    baseUrl: "https://api.venice.ai/api/v1",
    auth: bearer,
    needsKey: true,
    discovery: "venice",
    docsUrl: "https://docs.venice.ai",
  },
  {
    id: "ollama",
    name: "Ollama (lokal)",
    kind: "local",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: { type: "none" },
    needsKey: false,
    discovery: "openai",
  },
  {
    id: "lmstudio",
    name: "LM Studio (lokal)",
    kind: "local",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:1234/v1",
    auth: { type: "none" },
    needsKey: false,
    discovery: "openai",
  },
  {
    id: "llamacpp",
    name: "llama.cpp server (lokal)",
    kind: "local",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8080/v1",
    auth: { type: "none" },
    needsKey: false,
    discovery: "openai",
  },
  {
    id: "vllm",
    name: "vLLM (lokal)",
    kind: "local",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    auth: { type: "none" },
    needsKey: false,
    discovery: "openai",
  },
];

export const CUSTOM_PRESET_ID = "custom";
export const LOCAL_FAMILY = "local";

const BY_ID = new Map(ENDPOINT_PRESETS.map((p) => [p.id, p]));

export function getEndpointPreset(id: string | null | undefined): EndpointPreset | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Rules are keyed by family, so every local runtime shares one set of rules. */
export function profileFamily(presetId: string | null | undefined): string {
  const preset = getEndpointPreset(presetId);
  return preset?.kind === "local" ? LOCAL_FAMILY : (presetId ?? CUSTOM_PRESET_ID);
}

/** Families an owner can pick for a custom endpoint, so it borrows that provider's parameter handling. */
export function selectableFamilies(): { id: string; name: string }[] {
  return ENDPOINT_PRESETS.filter((p) => p.kind !== "local").map((p) => ({ id: p.id, name: p.name }));
}
