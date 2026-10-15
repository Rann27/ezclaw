import { randomUUID } from "node:crypto";
import {
  defaultImageSpec,
  defaultImageWire,
  mergeImageSpec,
  resolveProfile,
  type ImageSpec,
  type ImageWire,
  type CatalogResponse,
  type EndpointDto,
  type EndpointInput,
  type EndpointPatch,
  type EndpointTestResponse,
  type ModelDto,
  type ModelPatch,
  type ModelProfileResponse,
  type ProfilePatch,
  type Protocol,
  type ResolvedProfile,
} from "@ezclaw/core";
import {
  CUSTOM_PRESET_ID,
  DiscoveryParseError,
  ENDPOINT_PRESETS,
  getEndpointPreset,
  listPath,
  matchPresets,
  parseModelList,
  PRESET_FILES,
  profileFamily,
  selectableFamilies,
  type DiscoveredModel,
  type DiscoveryParser,
} from "@ezclaw/registry";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { endpoints, models } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { buildHeaders, joinUrl, keyLast4, networkError, parseProviderError, ProviderError, type ConnectionInfo } from "../provider/http.js";
import type { SecretStore } from "../secrets.js";
import { getSettings, updateSettings } from "../settings.js";

type EndpointRow = typeof endpoints.$inferSelect;
type ModelRow = typeof models.$inferSelect;

const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_MODELS_PER_ENDPOINT = 5000;

export interface ResolvedModel {
  row: ModelRow;
  endpoint: EndpointRow;
  family: string;
  resolved: ResolvedProfile;
  matchedSources: { source: string; checked: string }[];
}

export class RegistryService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /* ---------------------------------------------------------------- catalog */

  catalog(): CatalogResponse {
    return {
      presets: ENDPOINT_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        protocol: p.protocol,
        protocols: [p.protocol, ...(p.alsoSupports ?? [])],
        baseUrl: p.baseUrl,
        regions: p.regions ?? [],
        auth: p.auth,
        needsKey: p.needsKey,
        docsUrl: p.docsUrl ?? null,
        notes: p.notes ?? [],
      })),
      families: selectableFamilies(),
    };
  }

  /* -------------------------------------------------------------- endpoints */

  private endpointRow(id: string): EndpointRow {
    const row = this.db.select().from(endpoints).where(eq(endpoints.id, id)).get();
    if (!row) throw new HttpError(404, "endpoint_not_found", "Endpoint tidak ditemukan.");
    return row;
  }

  private toDto(row: EndpointRow, modelCount: number): EndpointDto {
    const preset = getEndpointPreset(row.presetId);
    const needsKey = preset ? preset.needsKey : row.authType !== "none";
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      presetId: row.presetId,
      family: row.family,
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      auth: { type: row.authType, ...(row.authHeader ? { headerName: row.authHeader } : {}) },
      extraHeaders: row.extraHeaders,
      needsKey: needsKey && row.authType !== "none",
      hasKey: row.keyLast4 !== null,
      keyLast4: row.keyLast4,
      modelCount,
      lastTest:
        row.lastTestAt && row.lastTestOk !== null
          ? { at: row.lastTestAt.toISOString(), ok: row.lastTestOk, message: row.lastTestMessage ?? "" }
          : null,
    };
  }

  listEndpoints(): EndpointDto[] {
    const rows = this.db.select().from(endpoints).orderBy(endpoints.createdAt).all();
    const counts = new Map(
      this.db
        .select({ endpointId: models.endpointId, n: count() })
        .from(models)
        .groupBy(models.endpointId)
        .all()
        .map((r) => [r.endpointId, r.n]),
    );
    return rows.map((r) => this.toDto(r, counts.get(r.id) ?? 0));
  }

  getEndpoint(id: string): EndpointDto {
    const row = this.endpointRow(id);
    const n = this.db.select({ n: count() }).from(models).where(eq(models.endpointId, id)).get()?.n ?? 0;
    return this.toDto(row, n);
  }

  createEndpoint(input: EndpointInput): EndpointDto {
    const preset = getEndpointPreset(input.presetId);
    if (!preset && input.presetId !== CUSTOM_PRESET_ID) {
      throw new HttpError(400, "unknown_preset", `Preset "${input.presetId}" tidak dikenal.`);
    }
    if (input.family && !ENDPOINT_PRESETS.some((p) => p.id === input.family)) {
      throw new HttpError(400, "unknown_family", `Keluarga parameter "${input.family}" tidak dikenal.`);
    }
    if (preset && input.protocol !== preset.protocol && !preset.alsoSupports?.includes(input.protocol)) {
      throw new HttpError(400, "protocol_not_supported", `${preset.name} tidak mendukung protokol ${input.protocol}.`);
    }
    const id = randomUUID();
    const now = new Date();
    this.db
      .insert(endpoints)
      .values({
        id,
        name: input.name,
        kind: preset?.kind ?? "custom",
        presetId: input.presetId,
        family: preset ? null : (input.family ?? null),
        protocol: input.protocol,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        authType: input.auth.type,
        authHeader: input.auth.type === "header" ? (input.auth.headerName ?? null) : null,
        extraHeaders: input.extraHeaders ?? {},
        keyLast4: null,
        createdAt: now,
      })
      .run();

    // Providers without a list endpoint stay usable through suggested models.
    this.insertSuggested(id, preset?.suggestedModels ?? []);

    if (input.apiKey) this.setKey(id, input.apiKey);
    return this.getEndpoint(id);
  }

  updateEndpoint(id: string, patch: EndpointPatch): EndpointDto {
    const row = this.endpointRow(id);
    const set: Partial<typeof endpoints.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl.replace(/\/+$/, "");
    if (patch.auth !== undefined) {
      if (patch.auth.type === "header" && !patch.auth.headerName) {
        throw new HttpError(400, "invalid_request", "Nama header wajib diisi untuk auth header.");
      }
      set.authType = patch.auth.type;
      set.authHeader = patch.auth.type === "header" ? (patch.auth.headerName ?? null) : null;
    }
    if (patch.family !== undefined) {
      if (row.presetId !== CUSTOM_PRESET_ID) {
        throw new HttpError(400, "invalid_request", "Keluarga parameter hanya bisa diubah pada endpoint custom.");
      }
      set.family = patch.family;
    }
    if (patch.extraHeaders !== undefined) set.extraHeaders = patch.extraHeaders;
    if (Object.keys(set).length) this.db.update(endpoints).set(set).where(eq(endpoints.id, id)).run();
    return this.getEndpoint(id);
  }

  deleteEndpoint(id: string): void {
    this.endpointRow(id);
    this.db.delete(endpoints).where(eq(endpoints.id, id)).run();
    this.secrets.delete(secretId(id));
    this.pruneDefaultModels();
  }

  setKey(id: string, key: string): EndpointDto {
    this.endpointRow(id);
    const trimmed = key.trim();
    try {
      this.secrets.set(secretId(id), trimmed);
    } catch (err) {
      throw new HttpError(500, "secret_store_failed", `Key gagal disimpan di penyimpanan kredensial: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.db.update(endpoints).set({ keyLast4: keyLast4(trimmed) }).where(eq(endpoints.id, id)).run();
    return this.getEndpoint(id);
  }

  clearKey(id: string): EndpointDto {
    this.endpointRow(id);
    this.secrets.delete(secretId(id));
    this.db.update(endpoints).set({ keyLast4: null }).where(eq(endpoints.id, id)).run();
    return this.getEndpoint(id);
  }

  getApiKey(endpointId: string): string | null {
    return this.secrets.get(secretId(endpointId));
  }

  connectionFor(row: EndpointRow): ConnectionInfo {
    return {
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      authType: row.authType,
      authHeader: row.authHeader,
      extraHeaders: row.extraHeaders,
      name: row.name,
      isLocal: row.kind === "local",
    };
  }

  /* -------------------------------------------------------------- discovery */

  private parserFor(row: EndpointRow): DiscoveryParser {
    const family = getEndpointPreset(row.family ?? row.presetId);
    // Anthropic's list is shaped differently; every OpenAI-style wire shares the family's parser.
    if (family && (family.protocol === "anthropic") === (row.protocol === "anthropic")) return family.discovery;
    return row.protocol === "anthropic" ? "anthropic" : "openai";
  }

  async testEndpoint(id: string): Promise<EndpointTestResponse> {
    const row = this.endpointRow(id);
    const conn = this.connectionFor(row);
    const preset = getEndpointPreset(row.presetId);
    const record = (ok: boolean, message: string) =>
      this.db.update(endpoints).set({ lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message }).where(eq(endpoints.id, id)).run();

    const needsKey = row.authType !== "none";
    const key = needsKey ? this.getApiKey(id) : null;
    if (needsKey && !key) {
      const message = "Key belum diisi. Masukkan key lalu coba lagi.";
      record(false, message);
      return { ok: false, message, modelCount: this.modelCount(id), usedSuggestions: false };
    }

    const parser = this.parserFor(row);
    const url = joinUrl(row.baseUrl, listPath(parser));
    let discovered: DiscoveredModel[] | null = null;
    let failure: string | null = null;
    let status: number | undefined;

    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: buildHeaders(conn, key, "application/json"),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      status = res.status;
      const text = await res.text();
      if (!res.ok) {
        failure = parseProviderError(res.status, text, conn).message;
      } else {
        try {
          discovered = parseModelList(parser, JSON.parse(text));
        } catch (err) {
          failure = err instanceof DiscoveryParseError ? err.message : "Respons daftar model bukan JSON.";
        }
      }
    } catch (err) {
      failure = (err instanceof ProviderError ? err : networkError(conn, err)).message;
    }

    if (discovered) {
      const kept = discovered.slice(0, MAX_MODELS_PER_ENDPOINT);
      this.upsertDiscovered(id, kept);
      const message = `Tersambung. ${kept.length} model ditemukan.`;
      record(true, message);
      return { ok: true, message, modelCount: this.modelCount(id), usedSuggestions: false };
    }

    // A missing list endpoint is not a broken endpoint when we have models to suggest.
    const listMissing = status === 404 || status === 405 || status === 501;
    if (listMissing && preset?.suggestedModels?.length) {
      this.insertSuggested(id, preset.suggestedModels);
      const message = `${conn.name} tidak menyediakan daftar model, jadi model yang disarankan dipakai. Key belum bisa diverifikasi lewat daftar model; coba kirim satu pesan di Chat.`;
      record(true, message);
      return { ok: true, message, modelCount: this.modelCount(id), usedSuggestions: true };
    }

    const message = failure ?? "Gagal memuat daftar model.";
    record(false, message);
    return { ok: false, message, modelCount: this.modelCount(id), usedSuggestions: false };
  }

  private modelCount(endpointId: string): number {
    return this.db.select({ n: count() }).from(models).where(eq(models.endpointId, endpointId)).get()?.n ?? 0;
  }

  private insertSuggested(endpointId: string, suggested: { modelId: string; name: string }[]) {
    const now = new Date();
    for (const s of suggested) {
      this.db
        .insert(models)
        .values({ id: randomUUID(), endpointId, modelId: s.modelId, name: s.name, source: "suggested", kind: "text", createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  }

  private upsertDiscovered(endpointId: string, list: DiscoveredModel[]) {
    const now = new Date();
    this.db.transaction((tx) => {
      const existing = new Map(
        tx.select().from(models).where(eq(models.endpointId, endpointId)).all().map((m) => [m.modelId, m]),
      );
      for (const d of list) {
        const current = existing.get(d.modelId);
        if (current) {
          tx.update(models)
            .set({ name: d.name, kind: d.kind, discoveredPatch: d.patch, meta: d.meta, source: "discovered", discoveredAt: now })
            .where(eq(models.id, current.id))
            .run();
        } else {
          tx.insert(models)
            .values({
              id: randomUUID(),
              endpointId,
              modelId: d.modelId,
              name: d.name,
              source: "discovered",
              kind: d.kind,
              discoveredPatch: d.patch,
              meta: d.meta,
              discoveredAt: now,
              createdAt: now,
            })
            .run();
        }
      }
    });
  }

  /* ----------------------------------------------------------------- models */

  private modelRow(id: string): ModelRow {
    const row = this.db.select().from(models).where(eq(models.id, id)).get();
    if (!row) throw new HttpError(404, "model_not_found", "Model tidak ditemukan.");
    return row;
  }

  resolveModel(rowId: string): ResolvedModel {
    const row = this.modelRow(rowId);
    return this.resolveRow(row, this.endpointRow(row.endpointId));
  }

  private resolveRow(row: ModelRow, endpoint: EndpointRow): ResolvedModel {
    const family = endpoint.family ?? profileFamily(endpoint.presetId);
    const matched = matchPresets(family, row.modelId);
    const hasDiscovery = Object.keys(row.discoveredPatch).length > 0;
    const resolved = resolveProfile({
      protocol: endpoint.protocol as Protocol,
      fallbackPresets: matched.fallback,
      discovery: hasDiscovery ? row.discoveredPatch : null,
      presets: matched.corrections,
      override: row.override,
      omit: row.omit,
    });
    const matchedSources = PRESET_FILES.filter((file) =>
      file.rules.some((r) => (r.endpoint === family || r.endpoint === "*") && new RegExp(r.model, "i").test(row.modelId)),
    ).map((f) => ({ source: f.source, checked: f.checked }));
    return { row, endpoint, family, resolved, matchedSources };
  }

  private toModelDto(m: ResolvedModel): ModelDto {
    const { row, endpoint, resolved } = m;
    const profile = resolved.profile;
    return {
      id: row.id,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      endpointKind: endpoint.kind,
      modelId: row.modelId,
      name: row.name,
      alias: row.alias,
      favorite: row.favorite,
      source: row.source,
      kind: row.kind,
      summary: {
        inputModalities: profile.inputModalities,
        outputModalities: profile.outputModalities,
        tools: profile.tools,
        reasoning: profile.reasoning.style !== "none" || profile.reasoning.defaultOn,
        reasoningStyle: profile.reasoning.style,
        contextLength: profile.contextLength,
      },
      hasOverride: row.override !== null,
      omitCount: row.omit.length,
    };
  }

  listModels(): ModelDto[] {
    const eps = new Map(this.db.select().from(endpoints).all().map((e) => [e.id, e]));
    return this.db
      .select()
      .from(models)
      .all()
      .flatMap((row) => {
        const endpoint = eps.get(row.endpointId);
        return endpoint ? [this.toModelDto(this.resolveRow(row, endpoint))] : [];
      });
  }

  getModelDto(rowId: string): ModelDto {
    return this.toModelDto(this.resolveModel(rowId));
  }

  modelProfile(rowId: string): ModelProfileResponse {
    const m = this.resolveModel(rowId);
    return {
      model: this.toModelDto(m),
      profile: m.resolved.profile,
      provenance: m.resolved.provenance,
      omit: m.resolved.omit,
      override: m.row.override,
      imageSpec: m.row.kind === "image" ? this.imageSpecFor(rowId).spec : null,
      presetSources: m.matchedSources,
    };
  }

  /**
   * The wire an image model uses and what it accepts: the wire's defaults, refined by what discovery,
   * presets and the owner's override say. Models nobody configured get the wire their provider normally uses.
   */
  imageSpecFor(rowId: string): { wire: ImageWire; spec: ImageSpec; textOutput: boolean } {
    const m = this.resolveModel(rowId);
    const profile = m.resolved.profile;
    const known = profile.outputModalities.includes("image");
    const textOutput = known ? profile.outputModalities.includes("text") : false;
    const wire = profile.image?.wire ?? defaultImageWire(m.family, textOutput, m.endpoint.baseUrl);
    const spec = mergeImageSpec(defaultImageSpec(wire), { ...profile.image, wire });
    return { wire, spec, textOutput };
  }

  patchModel(rowId: string, patch: ModelPatch): ModelDto {
    this.modelRow(rowId);
    const set: Partial<typeof models.$inferInsert> = {};
    if (patch.alias !== undefined) set.alias = patch.alias && patch.alias.length ? patch.alias : null;
    if (patch.favorite !== undefined) set.favorite = patch.favorite;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.override !== undefined) set.override = patch.override === null || isEmptyPatch(patch.override) ? null : patch.override;
    if (patch.omit !== undefined) set.omit = [...new Set(patch.omit)];
    if (Object.keys(set).length) this.db.update(models).set(set).where(eq(models.id, rowId)).run();
    return this.getModelDto(rowId);
  }

  addManualModel(endpointId: string, input: { modelId: string; name?: string; kind?: "text" | "image" }): ModelDto {
    this.endpointRow(endpointId);
    const existing = this.db
      .select()
      .from(models)
      .where(and(eq(models.endpointId, endpointId), eq(models.modelId, input.modelId)))
      .get();
    if (existing) throw new HttpError(409, "model_exists", `Model "${input.modelId}" sudah ada di endpoint ini.`);
    const id = randomUUID();
    this.db
      .insert(models)
      .values({ id, endpointId, modelId: input.modelId, name: input.name || input.modelId, source: "manual", kind: input.kind ?? "text", createdAt: new Date() })
      .run();
    return this.getModelDto(id);
  }

  deleteModel(rowId: string): void {
    const row = this.modelRow(rowId);
    if (row.source === "discovered") {
      throw new HttpError(400, "model_discovered", "Model dari daftar provider tidak bisa dihapus; muncul lagi saat daftar dimuat ulang.");
    }
    this.db.delete(models).where(eq(models.id, rowId)).run();
    this.pruneDefaultModels();
  }

  /** Remembers that this model rejected a request field, so it is never sent again. */
  learnOmit(rowId: string, key: string): void {
    const row = this.modelRow(rowId);
    if (row.omit.includes(key)) return;
    this.db.update(models).set({ omit: [...row.omit, key] }).where(eq(models.id, rowId)).run();
  }

  private pruneDefaultModels() {
    const current = getSettings(this.db).defaultModels;
    const ids = Object.values(current).filter((v): v is string => !!v);
    if (!ids.length) return;
    const alive = new Set(this.db.select({ id: models.id }).from(models).where(inArray(models.id, ids)).all().map((r) => r.id));
    const kept = Object.fromEntries(Object.entries(current).filter(([, v]) => v && alive.has(v)));
    if (Object.keys(kept).length !== Object.keys(current).length) updateSettings(this.db, { defaultModels: kept });
  }
}

function secretId(endpointId: string): string {
  return `endpoint:${endpointId}`;
}

function isEmptyPatch(p: ProfilePatch): boolean {
  return Object.keys(p).length === 0;
}
