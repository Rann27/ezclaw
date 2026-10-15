import { profilePatchSchema, type ProfilePatch } from "@ezclaw/core";
import { z } from "zod";
import anthropic from "./presets/anthropic.json" with { type: "json" };
import deepseek from "./presets/deepseek.json" with { type: "json" };
import openai from "./presets/openai.json" with { type: "json" };
import providers from "./presets/providers.json" with { type: "json" };

export const presetRuleSchema = z.object({
  /** Profile family: an endpoint preset id, "local", or "*" for any. */
  endpoint: z.string().min(1),
  /** Regex tested against the model id, case-insensitive. */
  model: z.string().min(1),
  /** "fallback" fills gaps before discovery; the default "correction" is applied after it. */
  priority: z.enum(["fallback", "correction"]).default("correction"),
  patch: profilePatchSchema,
});
export type PresetRule = z.infer<typeof presetRuleSchema>;

export const presetFileSchema = z.object({
  source: z.string().min(1),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rules: z.array(presetRuleSchema).min(1),
});
export type PresetFile = z.infer<typeof presetFileSchema>;

export const PRESET_FILES: PresetFile[] = [openai, anthropic, deepseek, providers].map((raw) => presetFileSchema.parse(raw));

const compiled = PRESET_FILES.flatMap((file) =>
  file.rules.map((rule) => ({ rule, regex: new RegExp(rule.model, "i") })),
);

export interface MatchedPresets {
  fallback: ProfilePatch[];
  corrections: ProfilePatch[];
}

/** Rules that apply to a model, in file order (general first, specific last). */
export function matchPresets(family: string, modelId: string): MatchedPresets {
  const out: MatchedPresets = { fallback: [], corrections: [] };
  for (const { rule, regex } of compiled) {
    if (rule.endpoint !== "*" && rule.endpoint !== family) continue;
    if (!regex.test(modelId)) continue;
    (rule.priority === "fallback" ? out.fallback : out.corrections).push(rule.patch);
  }
  return out;
}
