import {
  compileEditPrompt,
  compileReferencePrompt,
  resolveImageParams,
  type ChatImageMessage,
  type ImageParams,
  type ImageReference,
  type ImageTurnMeta,
  type KeepId,
  type Part,
  type RunEvent,
} from "@ezclaw/core";
import { asc, eq } from "drizzle-orm";
import type { AgentDeps } from "./agent/loop.js";
import { updateMessage } from "./agent/store.js";
import { messages } from "./db/schema.js";
import { callModel, newAccumulator } from "./provider/call.js";
import { generateImages, type GeneratedImage, type ImageRef } from "./provider/image.js";
import type { AssetService } from "./services/assets.js";
import { sniffImage, toDataUrl } from "./services/imageInfo.js";
import { matchSize, tierFor } from "./services/resize.js";

export interface ImageRunDeps extends AgentDeps {
  assets: AssetService;
  /** Wait between polls of an async task (tests shorten it). */
  pollMs?: number;
}

export interface ImageRunInput {
  threadId: string;
  assistantMessageId: string;
  modelRowId: string;
  /** What the owner typed. */
  text: string;
  /** Send `text` untouched: no Prompt Composer, no reference template. */
  exact: boolean;
  params: ImageParams;
  references: ImageReference[];
  /** Model that writes standalone prompts for single-prompt image models; null when none is set. */
  composerModelRowId: string | null;
  /** Set for an edit: the image being changed and what must stay as it is. */
  edit?: { target: string; keep: KeepId[] };
}

interface PriorTurn {
  userText: string;
  sentPrompt: string;
  resultAssetIds: string[];
}

const COMPOSER_SYSTEM = [
  "You write prompts for an image generation model. That model sees one prompt only, never the conversation.",
  "You get the earlier prompts of a session and the user's new instruction.",
  "Write ONE standalone prompt describing the complete image wanted now. Keep everything from the earlier prompts that the new instruction does not change.",
  "Also decide whether the previous result image should be given to the model as an input image: true when the instruction edits or varies the previous result, false when it asks for something new.",
  "Write the prompt in English, except for any text that must appear inside the image.",
  'Answer with JSON only, no commentary: {"prompt": "...", "use_last_image": true}',
].join("\n");

const POLISH_SYSTEM = [
  "You tidy prompts for an image editing model. The prompt you get says which input image is which (Image 1 is the one to edit, the others are references), then gives an instruction and what to keep.",
  "Rewrite it as one clear prompt. Keep every statement about which image is which and what must stay unchanged, and keep the meaning of the instruction. Remove repetition and vagueness; do not add new requirements.",
  "Write the prompt in English, except for any text that must appear inside the image.",
  'Answer with JSON only, no commentary: {"prompt": "..."}',
].join("\n");

function priorTurns(deps: ImageRunDeps, threadId: string, beforeMessageId: string): PriorTurn[] {
  const rows = deps.db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.seq)).all();
  const turns: PriorTurn[] = [];
  let pendingUser: string | null = null;
  for (const m of rows) {
    if (m.id === beforeMessageId) break;
    if (m.role === "user") {
      pendingUser = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    } else if (m.role === "assistant" && pendingUser !== null && m.status === "complete") {
      const meta = m.raw?.protocol === "image" ? (m.raw.data as ImageTurnMeta) : null;
      const ids = m.parts.flatMap((p) => (p.type === "image" ? [p.assetId] : []));
      turns.push({ userText: pendingUser, sentPrompt: meta?.sentPrompt ?? pendingUser, resultAssetIds: ids });
      pendingUser = null;
    }
  }
  return turns.slice(-6);
}

function parseComposed(text: string): { prompt: string; useLastImage: boolean } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof v.prompt === "string" && v.prompt.trim()) return { prompt: v.prompt.trim(), useLastImage: v.use_last_image === true };
    } catch {
      // Fall back to plain text below.
    }
  }
  const plain = text.trim();
  return plain ? { prompt: plain, useLastImage: false } : null;
}

export interface ImageRunResult {
  status: "complete" | "stopped" | "error";
  error?: string;
}

/** One image turn: optional prompt composing, the provider call, saving results, and writing the message. */
export async function runImage(
  deps: ImageRunDeps,
  handle: { signal: AbortSignal; emit: (e: RunEvent) => void },
  input: ImageRunInput,
): Promise<ImageRunResult> {
  const started = Date.now();
  const notes: string[] = [];
  const note = (t: string) => {
    if (notes.includes(t)) return;
    notes.push(t);
    handle.emit({ type: "note", text: t });
  };
  const { registry, assets } = deps;
  const model = registry.resolveModel(input.modelRowId);
  const { spec, wire } = registry.imageSpecFor(input.modelRowId);

  const finalize = (patch: Parameters<typeof updateMessage>[2]) =>
    updateMessage(deps.db, input.assistantMessageId, { notes, modelLabel: `${model.endpoint.name} / ${model.row.modelId}`, durationMs: Date.now() - started, ...patch });

  const saved = new Map<number, string>();

  try {
    const prior = priorTurns(deps, input.threadId, input.assistantMessageId);
    const lastResult = [...prior].reverse().find((t) => t.resultAssetIds.length > 0)?.resultAssetIds[0] ?? null;

    const isEdit = !!input.edit;
    if (!isEdit && spec.editOnly && input.references.length === 0) {
      throw new Error("Model ini khusus edit gambar dan butuh gambar input. Pakai di mode Edit, atau tambahkan gambar referensi.");
    }
    if (isEdit && spec.maxInputImages < 1) {
      throw new Error("Model ini tidak menerima gambar input, jadi tidak bisa mengedit gambar. Pilih model gambar yang mendukung edit, atau ganti jalurnya di Pengaturan.");
    }

    /* ---- references ---- */
    // Image generation: references fill every input slot. Edit: the target takes one and references get the rest.
    const resolved = resolveImageParams(spec, input.params, isEdit ? 0 : input.references.length);
    for (const n of resolved.notes) note(n);
    let wanted = input.references;
    if (isEdit) {
      const allowed = spec.maxInputImages - 1;
      if (wanted.length > allowed) {
        note(
          allowed === 0
            ? `Model ini hanya menerima satu gambar input, yaitu gambar yang diedit, jadi ${wanted.length} referensi tidak dikirim.`
            : `Model ini menerima ${spec.maxInputImages} gambar input: 1 gambar yang diedit dan ${allowed} referensi. ${wanted.length - allowed} referensi terakhir tidak dikirim.`,
        );
        wanted = wanted.slice(0, allowed);
      }
    } else {
      wanted = wanted.slice(0, resolved.referencesUsed);
    }
    const refEntries: { ref: ImageReference; file: ImageRef; previous?: boolean }[] = wanted.map((ref) => {
      const { bytes, mime } = assets.read(ref.assetId);
      return { ref, file: { bytes, mime } };
    });
    const targetFile: ImageRef | null = input.edit ? assets.read(input.edit.target) : null;

    /* ---- prompt ---- */
    let prompt = input.text;
    let composed = false;
    let sentPrompt: string;

    const compose = async (system: string, user: string) => {
      const acc = newAccumulator();
      await callModel(
        deps,
        {
          modelRowId: input.composerModelRowId!,
          params: {},
          system,
          messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
          logMessageId: input.assistantMessageId,
          signal: handle.signal,
          onText: () => {},
          onReasoning: () => {},
          onNote: () => {},
          onUsage: () => {},
        },
        acc,
      );
      return parseComposed(acc.text.join(""));
    };

    if (input.edit) {
      const compiled = compileEditPrompt(input.text, refEntries.map((e) => ({ role: e.ref.role })), input.edit.keep);
      sentPrompt = input.exact ? input.text : compiled;
      // Tidying the compiled prompt is opt-in for edits: the template is usually what you want.
      if (!input.exact && input.params.composer === true) {
        if (!input.composerModelRowId) {
          note("Prompt Composer tidak jalan karena belum ada model teks untuk peran Composer atau Chat di Settings. Prompt dikirim sesuai template.");
        } else {
          const out = await compose(POLISH_SYSTEM, compiled);
          if (out) {
            sentPrompt = out.prompt;
            composed = true;
            handle.emit({ type: "composed", prompt: out.prompt, useLastImage: false });
          } else {
            note("Prompt Composer tidak menghasilkan prompt yang bisa dipakai. Prompt dikirim sesuai template.");
          }
        }
      }
    } else {
      if (!input.exact && !spec.conversational && input.params.composer !== false && prior.length > 0) {
        if (!input.composerModelRowId) {
          note("Prompt Composer tidak jalan karena belum ada model teks untuk peran Composer atau Chat di Settings. Prompt dikirim apa adanya.");
        } else {
          const history = prior.map((t, i) => `Prompt ${i + 1}: ${t.sentPrompt}`).join("\n");
          const out = await compose(COMPOSER_SYSTEM, `Earlier prompts:\n${history}\n\nNew instruction: ${input.text}`);
          if (out) {
            prompt = out.prompt;
            composed = true;
            handle.emit({ type: "composed", prompt: out.prompt, useLastImage: out.useLastImage });
            if (out.useLastImage && lastResult && spec.maxInputImages > refEntries.length) {
              const { bytes, mime } = assets.read(lastResult);
              refEntries.unshift({ ref: { assetId: lastResult }, file: { bytes, mime }, previous: true });
            }
          } else {
            note("Prompt Composer tidak menghasilkan prompt yang bisa dipakai. Prompt dikirim apa adanya.");
          }
        }
      }
      sentPrompt = input.exact ? input.text : compileReferencePrompt(prompt, refEntries.map((e) => ({ role: e.ref.role, previous: e.previous })));
    }

    /* ---- the images that go along, in order: the one being edited first ---- */
    const inputFiles: ImageRef[] = [...(targetFile ? [targetFile] : []), ...refEntries.map((e) => e.file)];

    /* ---- conversation for models that see it ---- */
    let chat: ChatImageMessage[] | undefined;
    if (spec.conversational) {
      if (isEdit) {
        // An edit is one self-contained request; earlier turns would only confuse which image is Image 1.
        chat = [{ role: "user", text: sentPrompt, images: inputFiles.map((f) => toDataUrl(f.mime, f.bytes)) }];
      } else {
        chat = prior.slice(-4).flatMap<ChatImageMessage>((t) => [
          { role: "user", text: t.userText, images: [] },
          { role: "assistant", text: "(gambar dibuat)", images: [] },
        ]);
        const images = [...(lastResult && prior.length ? [lastResult] : []).map((id) => assets.read(id)), ...refEntries.map((e) => e.file)].map((f) => toDataUrl(f.mime, f.bytes));
        chat.push({ role: "user", text: sentPrompt, images });
      }
    }

    /* ---- size: an edit comes back at the size of the image being edited ---- */
    const targetSize = targetFile ? sniffImage(targetFile.bytes) : null;
    const matchTo = input.edit && input.params.matchTarget !== false && targetSize?.width && targetSize.height ? { width: targetSize.width, height: targetSize.height } : null;
    const callParams = { ...resolved.params };
    if (matchTo && wire === "venice-image" && !callParams.resolution && spec.resolutions.length > 0) {
      callParams.resolution = tierFor(Math.max(matchTo.width, matchTo.height), spec.resolutions);
    }

    /* ---- slots ---- */
    for (let i = 0; i < resolved.n; i++) handle.emit({ type: "image_slot", index: i, status: "queued" });
    const meta: ImageTurnMeta = {
      wire,
      prompt: input.text,
      sentPrompt,
      composed,
      params: callParams,
      references: refEntries.map((e) => ({ assetId: e.ref.assetId, ...(e.ref.role ? { role: e.ref.role } : {}) })),
      n: resolved.n,
      ...(input.edit ? { target: input.edit.target, keep: input.edit.keep } : {}),
    };

    const result = await generateImages(deps, {
      modelRowId: input.modelRowId,
      prompt: sentPrompt,
      params: callParams,
      n: resolved.n,
      references: inputFiles,
      edit: isEdit,
      ...(chat ? { chat } : {}),
      logMessageId: input.assistantMessageId,
      signal: handle.signal,
      onImage: async (i, image: GeneratedImage) => {
        let bytes = image.bytes;
        if (matchTo) {
          const fixed = await matchSize(bytes, matchTo.width, matchTo.height);
          if (fixed) {
            bytes = fixed.bytes;
            note(`Hasil provider berukuran ${fixed.from.width}x${fixed.from.height}, diubah ke ${matchTo.width}x${matchTo.height} agar sama dengan gambar yang diedit.`);
          }
        }
        const id = assets.save(bytes, "generated").id;
        saved.set(i, id);
        return id;
      },
      onSlot: (index, status, extra) => handle.emit({ type: "image_slot", index, status, ...extra }),
      onNote: note,
    });

    const parts: Part[] = [];
    let firstError: string | null = null;
    const failures: string[] = [];
    result.slots.forEach((s, i) => {
      const id = saved.get(i);
      if (s.ok && id) parts.push({ type: "image", assetId: id, ...(s.image.seed !== undefined ? { seed: s.image.seed } : {}) });
      else if (!s.ok) {
        firstError ??= s.error;
        failures.push(`Gambar ${i + 1} gagal: ${s.error}`);
      }
    });
    const made = parts.length;
    // When nothing was made the turn's error says it; per-image notes only matter next to images that did arrive.
    if (made > 0) failures.forEach(note);
    if (result.text) parts.push({ type: "text", text: result.text });

    const raw = { protocol: "image", data: meta };
    if (made === 0) {
      finalize({ parts, status: "error", error: firstError ?? "Tidak ada gambar yang dihasilkan.", raw });
      return { status: "error", error: firstError ?? undefined };
    }
    finalize({ parts, status: "complete", error: null, raw });
    return { status: "complete" };
  } catch (err) {
    if (handle.signal.aborted) {
      const parts: Part[] = [...saved.entries()].sort((a, b) => a[0] - b[0]).map(([, assetId]) => ({ type: "image", assetId }));
      finalize({ parts, status: "stopped", error: null });
      return { status: "stopped" };
    }
    const message = err instanceof Error ? err.message : String(err);
    finalize({ status: "error", error: message });
    return { status: "error", error: message };
  }
}
