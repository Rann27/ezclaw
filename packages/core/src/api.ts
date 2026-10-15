import { z } from "zod";

/** Header carrying the per-launch session token on every /api request. */
export const TOKEN_HEADER = "x-ezclaw-token";
/** <meta name> the server fills with the session token when it serves index.html. */
export const TOKEN_META = "ezclaw-session";
/** Placeholder in the built index.html that the server replaces with the token. */
export const TOKEN_PLACEHOLDER = "__EZCLAW_SESSION__";

export const MODES = ["chat", "agent", "image", "edit"] as const;
export const modeSchema = z.enum(MODES);
export type Mode = z.infer<typeof modeSchema>;

export const THEMES = ["system", "light", "dark"] as const;
export const themeSchema = z.enum(THEMES);
export type ThemePreference = z.infer<typeof themeSchema>;

export const MODEL_ROLES = ["chat", "agent", "image", "edit", "composer", "title"] as const;
export const modelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  chat: "Chat",
  agent: "Agent",
  image: "Generate gambar",
  edit: "Edit gambar",
  composer: "Prompt Composer",
  title: "Judul dan ringkasan",
};

export const settingsSchema = z.object({
  theme: themeSchema,
  /** Model row id per role, used when a new thread starts. */
  defaultModels: z.partialRecord(modelRoleSchema, z.string()),
  /** Retry once without a field the provider names in a 400 error. */
  autoRetryRejectedParams: z.boolean(),
  /** Folder of an existing Codex install, whose models.json the "Codex-ref" harness profile reads. */
  codexDir: z.string().max(1000).nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = { theme: "system", defaultModels: {}, autoRetryRejectedParams: true, codexDir: null };

export interface HealthResponse {
  ok: true;
  version: string;
  listen: string;
  dataDir: string;
  dbPath: string;
  startedAt: string;
  secretStore: { backend: "keyring" | "file" | "memory"; secure: boolean; detail: string };
}

export interface ThreadSummary {
  id: string;
  mode: Mode;
  title: string;
  pinned: boolean;
  updatedAt: string;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
