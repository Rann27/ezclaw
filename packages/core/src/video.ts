import { z } from "zod";

/**
 * How a video model is reached. Every video API is a job: submit, poll, download.
 *  - openrouter-videos: OpenRouter /videos, frames as `frame_images`.
 *  - venice-video: Venice /video/queue and /video/retrieve; text and image models are separate ids.
 *  - xai-videos: xAI /videos/generations and /videos/{request_id}.
 */
export const VIDEO_WIRES = ["openrouter-videos", "venice-video", "xai-videos"] as const;
export const videoWireSchema = z.enum(VIDEO_WIRES);
export type VideoWire = z.infer<typeof videoWireSchema>;

export const VIDEO_WIRE_LABELS: Record<VideoWire, string> = {
  "openrouter-videos": "OpenRouter Videos",
  "venice-video": "Venice Video",
  "xai-videos": "xAI Videos",
};

export const videoSpecSchema = z.object({
  wire: videoWireSchema,
  /** Lengths in seconds the model accepts. Empty when any whole number in `durationRange` is fine. */
  durations: z.array(z.number().int()),
  durationRange: z.object({ min: z.number().int(), max: z.number().int() }).nullable(),
  defaultDuration: z.number().int().nullable(),
  resolutions: z.array(z.string()),
  aspectRatios: z.array(z.string()),
  /** Starts from text alone. */
  textToVideo: z.boolean(),
  /** Takes a start frame. */
  startFrame: z.boolean(),
  /** Takes an end frame too. */
  endFrame: z.boolean(),
  /** "optional": the owner switches sound on or off; "always": the model always adds it; "none": silent. */
  audio: z.enum(["none", "always", "optional"]),
  negativePrompt: z.boolean(),
  seed: z.boolean(),
  promptLimit: z.number().int().nullable(),
  /** Venice lists the text and image variants of a model as two ids; this is the other one. */
  pairedModelId: z.string().nullable(),
});
export type VideoSpec = z.infer<typeof videoSpecSchema>;

export const videoSpecPatchSchema = videoSpecSchema.partial();
export type VideoSpecPatch = z.infer<typeof videoSpecPatchSchema>;

/** Baseline for a wire before anything is known about the specific model. */
export function defaultVideoSpec(wire: VideoWire): VideoSpec {
  const base: VideoSpec = {
    wire,
    durations: [],
    durationRange: null,
    defaultDuration: null,
    resolutions: [],
    aspectRatios: [],
    textToVideo: true,
    startFrame: false,
    endFrame: false,
    audio: "none",
    negativePrompt: false,
    seed: false,
    promptLimit: null,
    pairedModelId: null,
  };
  switch (wire) {
    case "openrouter-videos":
      return { ...base, durations: [5, 8], resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16", "1:1"], startFrame: true };
    case "venice-video":
      return { ...base, durations: [5, 10], resolutions: ["480p", "720p", "1080p"], aspectRatios: ["16:9", "9:16", "1:1"], negativePrompt: true, promptLimit: 2500 };
    case "xai-videos":
      return {
        ...base,
        durationRange: { min: 1, max: 15 },
        defaultDuration: 8,
        resolutions: ["480p", "720p"],
        aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
        startFrame: true,
        audio: "optional",
      };
  }
}

export function mergeVideoSpec(base: VideoSpec, patch: VideoSpecPatch | null | undefined): VideoSpec {
  if (!patch) return base;
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

/** Picks the wire for a video model nobody has configured yet. */
export function defaultVideoWire(family: string, baseUrl: string): VideoWire {
  if (family === "openrouter" || /openrouter\.ai/i.test(baseUrl)) return "openrouter-videos";
  if (family === "venice" || /venice\.ai/i.test(baseUrl)) return "venice-video";
  return "xai-videos";
}

/** Names that mark a video model in lists that do not say so themselves. */
export const VIDEO_MODEL_NAME = /(imagine-video|text-to-video|image-to-video|\bveo\b|veo-?\d|sora|kling|seedance|hailuo|wan-?\d.*(t2v|i2v|video)|ltx-?video|runway|pika|luma|-video\b|video-)/i;

export const videoParamsSchema = z
  .object({
    duration: z.number().int().min(1).max(60).optional(),
    resolution: z.string().max(20).optional(),
    aspectRatio: z.string().max(10).optional(),
    audio: z.boolean().optional(),
    negativePrompt: z.string().max(4000).optional(),
    seed: z.number().int().optional(),
  })
  .strict();
export type VideoParams = z.infer<typeof videoParamsSchema>;

/** Ratio values that mean "the shape of the start frame". */
export const FOLLOW_FRAME = ["adaptive", "auto"];

export interface ResolvedVideoParams {
  params: VideoParams;
  notes: string[];
}

/** Keeps only what the model accepts and says why anything else was dropped or changed. */
export function resolveVideoParams(spec: VideoSpec, params: VideoParams, frames: { start: boolean; end: boolean }): ResolvedVideoParams {
  const notes: string[] = [];
  const out: VideoParams = {};

  let duration = params.duration ?? spec.defaultDuration ?? spec.durations[0] ?? spec.durationRange?.min;
  if (duration !== undefined) {
    if (spec.durations.length > 0 && !spec.durations.includes(duration)) {
      const nearest = spec.durations.reduce((a, b) => (Math.abs(b - duration!) < Math.abs(a - duration!) ? b : a));
      notes.push(`Durasi ${duration} detik tidak didukung model ini, jadi dipakai ${nearest} detik.`);
      duration = nearest;
    } else if (spec.durations.length === 0 && spec.durationRange) {
      const clamped = Math.min(spec.durationRange.max, Math.max(spec.durationRange.min, duration));
      if (clamped !== duration) notes.push(`Durasi diubah ke ${clamped} detik, batas model ini ${spec.durationRange.min} sampai ${spec.durationRange.max} detik.`);
      duration = clamped;
    }
    out.duration = duration;
  }

  const pick = (key: "resolution" | "aspectRatio", allowed: string[], label: string) => {
    const v = params[key];
    if (v === undefined || v === "") return;
    if (allowed.length === 0) notes.push(`${label} tidak dikirim: model ini tidak memakainya.`);
    else if (!allowed.includes(v)) notes.push(`${label} "${v}" tidak didukung model ini, jadi tidak dikirim.`);
    else out[key] = v;
  };
  pick("resolution", spec.resolutions, "Resolusi");

  // "adaptive" / "auto" mean: follow the start frame's shape.
  const follow = spec.aspectRatios.find((r) => FOLLOW_FRAME.includes(r));
  const fixed = spec.aspectRatios.filter((r) => !FOLLOW_FRAME.includes(r));
  if (params.aspectRatio && fixed.includes(params.aspectRatio)) out.aspectRatio = params.aspectRatio;
  else if (params.aspectRatio && !FOLLOW_FRAME.includes(params.aspectRatio)) {
    notes.push(fixed.length ? `Aspect ratio "${params.aspectRatio}" tidak didukung model ini, jadi tidak dikirim.` : "Aspect ratio tidak dikirim: model ini tidak memakainya.");
  }
  if (!out.aspectRatio) {
    if (frames.start && follow) out.aspectRatio = follow;
    // Venice rejects a request without a ratio on models that list ratios.
    else if (spec.wire === "venice-video" && fixed.length > 0) {
      out.aspectRatio = fixed[0]!;
      notes.push(
        frames.start
          ? `Model ini tidak bisa mengikuti bentuk frame dan wajib diberi rasio, jadi dipakai ${fixed[0]}.`
          : `Rasio tidak dipilih, jadi dipakai ${fixed[0]}, rasio pertama yang didukung model ini.`,
      );
    }
  }

  if (params.audio !== undefined) {
    if (spec.audio === "optional") out.audio = params.audio;
    else if (params.audio && spec.audio === "none") notes.push("Model ini membuat video tanpa suara.");
  }
  if (params.negativePrompt?.trim()) {
    if (spec.negativePrompt) out.negativePrompt = params.negativePrompt.trim();
    else notes.push("Negative prompt tidak dikirim: model ini tidak punya parameter itu.");
  }
  if (params.seed !== undefined) {
    if (spec.seed) out.seed = params.seed;
    else notes.push("Seed tidak dikirim: model ini tidak punya parameter itu.");
  }
  return { params: out, notes };
}

/** What a video turn was made from, stored with the assistant message. */
export interface VideoTurnMeta {
  wire: VideoWire;
  /** The model id actually called (Venice may switch to the image variant), and its row. */
  modelId: string;
  modelRowId?: string;
  prompt: string;
  params: VideoParams;
  startFrame?: string;
  endFrame?: string;
  /** The provider's job, saved as soon as it is accepted, so a restart can keep waiting for it. */
  job?: { id: string; pollUrl?: string; downloadUrl?: string; submittedAt: string };
  costUsd?: number;
}

/* ------------------------------------------------------------------ wire bodies */

export interface VideoBodyInput {
  modelId: string;
  prompt: string;
  params: VideoParams;
  /** data: URLs. */
  startFrame?: string;
  endFrame?: string;
}

export function openrouterVideoBody(i: VideoBodyInput): Record<string, unknown> {
  const frames = [
    ...(i.startFrame ? [{ type: "image_url", image_url: { url: i.startFrame }, frame_type: "first_frame" }] : []),
    ...(i.endFrame ? [{ type: "image_url", image_url: { url: i.endFrame }, frame_type: "last_frame" }] : []),
  ];
  return {
    model: i.modelId,
    ...(i.prompt ? { prompt: i.prompt } : {}),
    ...(i.params.duration !== undefined ? { duration: i.params.duration } : {}),
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.audio !== undefined ? { generate_audio: i.params.audio } : {}),
    ...(i.params.seed !== undefined ? { seed: i.params.seed } : {}),
    ...(frames.length ? { frame_images: frames } : {}),
  };
}

export function veniceVideoBody(i: VideoBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    prompt: i.prompt,
    duration: `${i.params.duration ?? 5}s`,
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.audio !== undefined ? { audio: i.params.audio } : {}),
    ...(i.params.negativePrompt ? { negative_prompt: i.params.negativePrompt } : {}),
    ...(i.startFrame ? { image_url: i.startFrame } : {}),
    ...(i.endFrame ? { end_image_url: i.endFrame } : {}),
  };
}

export function xaiVideoBody(i: VideoBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    ...(i.prompt ? { prompt: i.prompt } : {}),
    ...(i.params.duration !== undefined ? { duration: i.params.duration } : {}),
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.audio !== undefined ? { generate_audio: i.params.audio } : {}),
    ...(i.startFrame ? { image: { url: i.startFrame } } : {}),
  };
}

/** Venice names the two variants of a model "...-text-to-video" and "...-image-to-video". */
export function venicePairedId(modelId: string): string | null {
  if (/text-to-video/.test(modelId)) return modelId.replace("text-to-video", "image-to-video");
  if (/image-to-video/.test(modelId)) return modelId.replace("image-to-video", "text-to-video");
  return null;
}
