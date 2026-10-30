import type { ModelDto } from "@ezclaw/core";
import { CaretDownIcon, StarIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { modelLabel, useModels } from "../lib/queries";
import { Dialog } from "./Dialog";

type Filter = "favorite" | "tools" | "reasoning" | "image-in";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "favorite", label: "Favorit" },
  { id: "tools", label: "Tools" },
  { id: "reasoning", label: "Reasoning" },
  { id: "image-in", label: "Terima gambar" },
];

function matches(m: ModelDto, filter: Filter): boolean {
  switch (filter) {
    case "favorite":
      return m.favorite;
    case "tools":
      return m.summary.tools;
    case "reasoning":
      return m.summary.reasoning;
    case "image-in":
      return m.kind === "image" ? (m.summary.imageInputs ?? 0) > 0 : m.summary.inputModalities.includes("image");
  }
}

/** Who made a model, read from its id: "anthropic/claude-x" on gateways, or a known family name. */
const MAKERS: [RegExp, string][] = [
  [/claude|anthropic/i, "Anthropic"],
  [/gpt|^o\d|chatgpt|dall-e|codex|openai|sora/i, "OpenAI"],
  [/gemini|gemma|imagen|google|veo/i, "Google"],
  [/deepseek/i, "DeepSeek"],
  [/qwen|qwq|wanx|wan-/i, "Qwen"],
  [/glm|z-ai|zai|cogview/i, "Z.ai"],
  [/grok|xai|x-ai/i, "xAI"],
  [/llama|meta/i, "Meta"],
  [/mistral|mixtral|codestral|magistral|devstral|pixtral/i, "Mistral"],
  [/kimi|moonshot/i, "Moonshot"],
  [/minimax/i, "MiniMax"],
  [/flux|black-forest/i, "Black Forest Labs"],
  [/seedream|seededit|doubao|bytedance/i, "ByteDance"],
  [/hunyuan|tencent/i, "Tencent"],
  [/command|cohere/i, "Cohere"],
  [/nemotron|nvidia/i, "NVIDIA"],
];

export function modelMaker(m: ModelDto): string {
  const prefix = m.modelId.includes("/") ? m.modelId.split("/")[0]! : null;
  const probe = prefix ?? m.modelId;
  for (const [re, name] of MAKERS) if (re.test(probe)) return name;
  if (prefix) return prefix.replace(/^~/, "");
  return "Lainnya";
}

const ENDPOINT_PREF = (kind: string) => `ezclaw.picker.endpoints.${kind}`;

/** The endpoints chosen last time in this kind of picker; a convenience only. */
function readEndpointPref(kind: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDPOINT_PREF(kind)) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveEndpointPref(kind: string, ids: Set<string>) {
  try {
    localStorage.setItem(ENDPOINT_PREF(kind), JSON.stringify([...ids]));
  } catch {
    // Only the remembered choice is lost.
  }
}

function CapTags({ m }: { m: ModelDto }) {
  // Tools and reasoning describe text models; for an image model they would only mislead.
  const imageModel = m.kind === "image";
  const tags = [
    !imageModel && m.summary.tools && "tools",
    !imageModel && m.summary.reasoning && "reasoning",
    imageModel ? m.summary.editOnly && "khusus edit" : m.summary.inputModalities.includes("image") && "gambar",
    imageModel && !m.summary.editOnly && (m.summary.imageInputs ?? 0) > 0 && "terima referensi",
  ].filter(Boolean) as string[];
  if (!tags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-xs bg-sunken px-1.5 text-meta text-fg-2">
          {t}
        </span>
      ))}
    </span>
  );
}

interface PickerProps {
  open: boolean;
  onClose: () => void;
  selectedId: string | null;
  onSelect: (model: ModelDto) => void;
  /** Which kind of model the caller needs. */
  kind?: "text" | "image";
  /** Narrows the list further, e.g. Edit shows only models that take an input image. */
  accept?: (m: ModelDto) => boolean;
}

export function ModelPickerDialog({ open, onClose, selectedId, onSelect, kind = "text", accept }: PickerProps) {
  const { data, isPending, isError, error, refetch } = useModels();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  // Endpoint choice is remembered per picker kind; maker and capability filters start fresh.
  const [endpointIds, setEndpointIds] = useState<Set<string>>(() => readEndpointPref(kind));
  const [maker, setMaker] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setFilters(new Set());
      setMaker("");
      setEndpointIds(readEndpointPref(kind));
    }
  }, [open, kind]);

  const all = useMemo(() => (data?.models ?? []).filter((m) => m.kind === kind && (!accept || accept(m))), [data, kind, accept]);

  const endpointOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const m of all) {
      const e = map.get(m.endpointId) ?? { id: m.endpointId, name: m.endpointName, count: 0 };
      e.count++;
      map.set(m.endpointId, e);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  // A remembered endpoint that was removed must not hide everything.
  const activeEndpoints = useMemo(() => new Set([...endpointIds].filter((id) => endpointOptions.some((e) => e.id === id))), [endpointIds, endpointOptions]);

  const byEndpoint = useMemo(() => (activeEndpoints.size ? all.filter((m) => activeEndpoints.has(m.endpointId)) : all), [all, activeEndpoints]);
  const makerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of byEndpoint) counts.set(modelMaker(m), (counts.get(modelMaker(m)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [byEndpoint]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return byEndpoint
      .filter((m) => !maker || modelMaker(m) === maker)
      .filter((m) => [...filters].every((f) => matches(m, f)))
      .filter((m) => !q || `${m.name} ${m.alias ?? ""} ${m.modelId} ${m.endpointName}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.endpointName.localeCompare(b.endpointName) || a.modelId.localeCompare(b.modelId));
  }, [byEndpoint, maker, filters, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelDto[]>();
    for (const m of visible) map.set(m.endpointName, [...(map.get(m.endpointName) ?? []), m]);
    return [...map.entries()];
  }, [visible]);

  function toggleEndpoint(id: string | null) {
    const next = new Set(activeEndpoints);
    if (id === null) next.clear();
    else if (next.has(id)) next.delete(id);
    else next.add(id);
    setEndpointIds(next);
    saveEndpointPref(kind, next);
  }

  function toggle(f: Filter) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  function moveFocus(e: KeyboardEvent, from: "input" | "list") {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-model]") ?? [])];
    if (!buttons.length) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from === "input") buttons[e.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus();
    else buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Pilih model" width="max-w-2xl">
      <div className="grid gap-3">
        <div className="grid gap-2">
          <label htmlFor="model-search" className="sr-only">
            Cari model
          </label>
          <input
            id="model-search"
            data-autofocus
            className="input"
            placeholder="Cari nama, ID model, atau endpoint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => moveFocus(e, "input")}
          />
          {endpointOptions.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter endpoint">
              <span className="mr-1 text-meta font-semibold text-fg-3">Endpoint</span>
              <button type="button" className="chip-toggle" aria-pressed={activeEndpoints.size === 0} onClick={() => toggleEndpoint(null)}>
                Semua
              </button>
              {endpointOptions.map((e) => (
                <button key={e.id} type="button" className="chip-toggle" aria-pressed={activeEndpoints.has(e.id)} onClick={() => toggleEndpoint(e.id)}>
                  {e.name} <span className="font-normal text-fg-3">{e.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter kemampuan">
            {makerOptions.length > 1 && (
              <>
                <label htmlFor="model-maker" className="sr-only">
                  Pembuat model
                </label>
                <select id="model-maker" className="select h-[30px] w-auto py-0 text-dense" value={maker} onChange={(e) => setMaker(e.target.value)}>
                  <option value="">Semua pembuat</option>
                  {makerOptions.map(([name, n]) => (
                    <option key={name} value={name}>
                      {name} ({n})
                    </option>
                  ))}
                </select>
              </>
            )}
            {FILTERS.filter((f) => kind === "text" || f.id === "favorite" || f.id === "image-in").map((f) => (
              <button key={f.id} type="button" className="chip-toggle" aria-pressed={filters.has(f.id)} onClick={() => toggle(f.id)}>
                {kind === "image" && f.id === "image-in" ? "Terima referensi" : f.label}
              </button>
            ))}
          </div>
        </div>

        {isPending && (
          <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Memuat daftar model
          </p>
        )}
        {isError && (
          <div className="grid gap-2 rounded-sm bg-danger-soft p-3 text-ui text-danger-text" role="alert">
            <p>{error.message}</p>
            <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void refetch()}>
              Coba lagi
            </button>
          </div>
        )}
        {data && all.length === 0 && (
          <div className="grid gap-3 py-4">
            <h3 className="text-title font-semibold">Belum ada model</h3>
            <p className="text-body text-fg-2">Tambahkan endpoint dengan API key OpenRouter, Venice, atau provider lain agar modelnya muncul di sini.</p>
            <Link to="/settings/endpoints" className="btn btn-primary justify-self-start no-underline" onClick={onClose}>
              Tambah endpoint
            </Link>
          </div>
        )}
        {data && all.length > 0 && visible.length < all.length && (
          <p className="text-meta text-fg-3" role="status">
            {visible.length} dari {all.length} model
          </p>
        )}
        {data && all.length > 0 && visible.length === 0 && <p className="py-4 text-ui text-fg-2">Tidak ada model yang cocok dengan pencarian dan filter ini.</p>}

        <ul ref={listRef} className="grid gap-4" onKeyDown={(e) => moveFocus(e, "list")}>
          {groups.map(([endpointName, items]) => (
            <li key={endpointName}>
              <h3 className="mb-1 px-2 text-meta font-semibold text-fg-3">{endpointName}</h3>
              <ul className="grid gap-px">
                {items.map((m) => {
                  const selected = m.id === selectedId;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        data-model
                        aria-current={selected ? "true" : undefined}
                        onClick={() => {
                          onSelect(m);
                          onClose();
                        }}
                        className={[
                          "grid w-full gap-1 rounded-sm px-2 py-2 text-left transition-colors duration-150",
                          selected ? "bg-brand-soft text-brand-soft-text" : "hover:bg-sunken",
                        ].join(" ")}
                      >
                        <span className="flex items-center gap-2 text-ui font-semibold">
                          {m.favorite && <StarIcon size={14} weight="fill" aria-label="Favorit" className="text-brand-strong" />}
                          {modelLabel(m)}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <code className="text-dense text-fg-2">{m.modelId}</code>
                          <CapTags m={m} />
                          {m.source === "suggested" && <span className="text-meta text-fg-3">disarankan, belum diverifikasi</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/** The model shown in the composer. Opens the picker. */
export function ModelChip({ model, onClick, disabled }: { model: ModelDto | null; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="model-chip" onClick={onClick} disabled={disabled} aria-haspopup="dialog">
      {model ? (
        <>
          <span className="ep-tag">{model.endpointName}</span>
          <code className="min-w-0 truncate">{model.alias ?? model.modelId}</code>
        </>
      ) : (
        <span className="px-1 text-fg-2">Pilih model</span>
      )}
      <CaretDownIcon size={14} aria-hidden className="shrink-0 text-fg-3" />
    </button>
  );
}
