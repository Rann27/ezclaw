import { buildParamPanel, type CapabilityProfile, type ChatParams, type ExtraParamSpec, type SamplingControl } from "@ezclaw/core";
import { useEffect, useId, useState } from "react";

interface ParamPanelProps {
  profile: CapabilityProfile;
  params: ChatParams;
  onChange: (next: ChatParams) => void;
  disabled?: boolean;
}

type Mode = "default" | "off" | "on";

function withoutKey<T extends object>(obj: T, key: keyof T): T {
  const { [key]: _removed, ...rest } = obj;
  return rest as T;
}

export function ParamPanel({ profile, params, onChange, disabled }: ParamPanelProps) {
  const panel = buildParamPanel(profile, params);
  const mode: Mode = params.reasoning?.mode ?? "default";

  function setReasoning(next: Partial<NonNullable<ChatParams["reasoning"]>> & { mode: Mode }) {
    if (next.mode === "default") return onChange(withoutKey(params, "reasoning"));
    onChange({ ...params, reasoning: { ...params.reasoning, ...next } });
  }

  function setSampling(control: SamplingControl, value: number | undefined) {
    if (value === undefined) onChange(withoutKey(params, control.param));
    else onChange({ ...params, [control.param]: value });
  }

  function setExtra(spec: ExtraParamSpec, value: boolean | string | number | undefined) {
    const extras = { ...params.extras };
    if (value === undefined) delete extras[spec.key];
    else extras[spec.key] = value;
    if (Object.keys(extras).length) onChange({ ...params, extras });
    else onChange(withoutKey(params, "extras"));
  }

  const r = panel.reasoning;
  const defaultLabel = r.defaultOn ? "Bawaan (aktif)" : "Bawaan";

  return (
    <div className="grid gap-5">
      {panel.notes.length > 0 && (
        <details className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2">
          <summary className="cursor-pointer font-semibold">Catatan model ({panel.notes.length})</summary>
          <ul className="mt-2 grid list-disc gap-1.5 pl-4">
            {panel.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {r.available ? (
        <section aria-labelledby="p-reasoning" className="grid gap-2">
          <h3 id="p-reasoning" className="text-dense font-semibold">
            Reasoning
          </h3>
          <div className="seg" role="radiogroup" aria-label="Mode reasoning">
            <button type="button" role="radio" aria-checked={mode === "default"} disabled={disabled} onClick={() => setReasoning({ mode: "default" })}>
              {defaultLabel}
            </button>
            {r.canDisable && (
              <button type="button" role="radio" aria-checked={mode === "off"} disabled={disabled} onClick={() => setReasoning({ mode: "off" })}>
                Mati
              </button>
            )}
            <button type="button" role="radio" aria-checked={mode === "on"} disabled={disabled} onClick={() => setReasoning({ mode: "on" })}>
              Nyala
            </button>
          </div>
          {mode === "on" && r.efforts.length > 0 && (
            <div className="grid gap-1">
              <span className="text-meta text-fg-3" id="p-effort">
                Effort
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="p-effort">
                {r.efforts.map((e) => (
                  <button key={e} type="button" role="radio" aria-checked={r.effort === e} disabled={disabled} onClick={() => setReasoning({ mode: "on", effort: e })}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mode === "on" && r.budget && (
            <NumberField
              label="Budget token reasoning"
              hint={`${r.budget.min} sampai ${r.budget.max}. Kosong berarti bawaan model.`}
              value={params.reasoning?.budgetTokens}
              min={r.budget.min}
              max={r.budget.max}
              step={r.budget.step}
              disabled={disabled}
              onChange={(v) => setReasoning({ mode: "on", budgetTokens: v })}
            />
          )}
        </section>
      ) : (
        <p className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2">
          Model ini tidak punya kontrol reasoning{r.defaultOn ? ", tapi berpikir secara otomatis." : "."}
        </p>
      )}

      {panel.sampling.length > 0 && (
        <section aria-labelledby="p-sampling" className="grid gap-3">
          <h3 id="p-sampling" className="text-dense font-semibold">
            Sampling
          </h3>
          {panel.sampling.map((c) => (
            <SamplingRow key={c.param} control={c} value={params[c.param]} disabled={disabled} onChange={(v) => setSampling(c, v)} />
          ))}
        </section>
      )}

      <section aria-labelledby="p-output" className="grid gap-3">
        <h3 id="p-output" className="text-dense font-semibold">
          Keluaran
        </h3>
        <NumberField
          label="max_output_tokens"
          hint={panel.maxOutputTokens.max ? `Maksimal ${panel.maxOutputTokens.max}. Kosong berarti bawaan.` : "Kosong berarti bawaan."}
          value={params.max_output_tokens}
          min={1}
          max={panel.maxOutputTokens.max ?? undefined}
          step={1}
          disabled={disabled}
          onChange={(v) => (v === undefined ? onChange(withoutKey(params, "max_output_tokens")) : onChange({ ...params, max_output_tokens: v }))}
        />
        {panel.seed && (
          <NumberField
            label="seed"
            hint="Kosong berarti acak."
            value={params.seed}
            step={1}
            disabled={disabled}
            onChange={(v) => (v === undefined ? onChange(withoutKey(params, "seed")) : onChange({ ...params, seed: Math.trunc(v) }))}
          />
        )}
        {panel.stop && <StopField value={params.stop} disabled={disabled} onChange={(v) => (v ? onChange({ ...params, stop: v }) : onChange(withoutKey(params, "stop")))} />}
      </section>

      {panel.extras.length > 0 && (
        <section aria-labelledby="p-extras" className="grid gap-3">
          <h3 id="p-extras" className="text-dense font-semibold">
            Opsi provider
          </h3>
          {panel.extras.map((spec) => (
            <ExtraRow key={spec.key} spec={spec} value={params.extras?.[spec.key]} disabled={disabled} onChange={(v) => setExtra(spec, v)} />
          ))}
        </section>
      )}

      <ExtraBodyField value={params.extraBody} disabled={disabled} onChange={(v) => (v ? onChange({ ...params, extraBody: v }) : onChange(withoutKey(params, "extraBody")))} />
    </div>
  );
}

function SamplingRow({ control, value, disabled, onChange }: { control: SamplingControl; value: number | undefined; disabled?: boolean; onChange: (v: number | undefined) => void }) {
  const id = useId();
  const { spec, locked } = control;
  const enabled = value !== undefined;
  const start = spec.default ?? Math.round(((spec.min + spec.max) / 2) / spec.step) * spec.step;
  return (
    <div className={locked ? "grid gap-1 opacity-70" : "grid gap-1"}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-on`} className="flex items-center gap-2 text-dense font-semibold">
          <input id={`${id}-on`} type="checkbox" checked={enabled} disabled={disabled || locked} onChange={(e) => onChange(e.target.checked ? start : undefined)} />
          <code>{control.param}</code>
        </label>
        <output className="font-code text-dense text-fg-2" htmlFor={id}>
          {enabled ? value : spec.default !== undefined ? `bawaan ${spec.default}` : "bawaan"}
        </output>
      </div>
      {enabled && (
        <input
          id={id}
          type="range"
          aria-label={control.param}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={disabled || locked}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      {locked && <p className="text-meta text-fg-3">{control.lockReason}</p>}
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-dense font-semibold">
        <code>{label}</code>
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className="input"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === "") return onChange(undefined);
          const n = Number(text);
          if (!Number.isFinite(n)) return setText(value === undefined ? "" : String(value));
          const clamped = Math.min(max ?? n, Math.max(min ?? n, n));
          setText(String(clamped));
          onChange(clamped);
        }}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-meta text-fg-3">
          {hint}
        </p>
      )}
    </div>
  );
}

function StopField({ value, disabled, onChange }: { value: string[] | undefined; disabled?: boolean; onChange: (v: string[] | undefined) => void }) {
  const id = useId();
  const [text, setText] = useState((value ?? []).join("\n"));
  useEffect(() => setText((value ?? []).join("\n")), [value]);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-dense font-semibold">
        <code>stop</code>
      </label>
      <textarea
        id={id}
        className="textarea min-h-16 font-code text-dense"
        value={text}
        disabled={disabled}
        placeholder="Satu urutan per baris, maksimal 8"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const lines = text.split("\n").filter((l) => l.length > 0).slice(0, 8);
          onChange(lines.length ? lines : undefined);
        }}
      />
    </div>
  );
}

function ExtraRow({ spec, value, disabled, onChange }: { spec: ExtraParamSpec; value: boolean | string | number | undefined; disabled?: boolean; onChange: (v: boolean | string | number | undefined) => void }) {
  const id = useId();
  const shown = value ?? spec.default;
  return (
    <div className="grid gap-1">
      {spec.type === "boolean" && (
        <button type="button" role="switch" aria-checked={shown === true} disabled={disabled} className="switch" onClick={() => onChange(shown === true ? false : true)}>
          <span className="switch-track" aria-hidden />
          {spec.label}
        </button>
      )}
      {spec.type === "enum" && (
        <>
          <label htmlFor={id} className="text-dense font-semibold">
            {spec.label}
          </label>
          <select id={id} className="select" disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
            <option value="">{spec.default !== undefined ? `Bawaan (${spec.options?.find((o) => o.value === spec.default)?.label ?? String(spec.default)})` : "Bawaan"}</option>
            {spec.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}
      {spec.type === "number" && (
        <NumberField label={spec.label} value={typeof value === "number" ? value : undefined} min={spec.min} max={spec.max} step={spec.step} disabled={disabled} onChange={onChange} />
      )}
      {spec.description && <p className="text-meta text-fg-3">{spec.description}</p>}
    </div>
  );
}

function ExtraBodyField({ value, disabled, onChange }: { value: Record<string, unknown> | undefined; disabled?: boolean; onChange: (v: Record<string, unknown> | undefined) => void }) {
  const id = useId();
  const pretty = value ? JSON.stringify(value, null, 2) : "";
  const [text, setText] = useState(pretty);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(pretty);
    setError(null);
  }, [pretty]);

  function commit() {
    if (text.trim() === "") {
      setError(null);
      return onChange(undefined);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Harus berupa objek JSON, misalnya { \"kunci\": 1 }.");
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof SyntaxError ? `JSON tidak valid: ${err.message}` : err instanceof Error ? err.message : "JSON tidak valid.");
    }
  }

  return (
    <details open={!!value} className="grid gap-2">
      <summary className="cursor-pointer text-dense font-semibold">Extra body (JSON)</summary>
      <label htmlFor={id} className="sr-only">
        Extra body JSON
      </label>
      <textarea
        id={id}
        spellCheck={false}
        className="textarea min-h-24 font-code text-dense"
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        placeholder={'{ "provider": { "sort": "price" } }'}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      <p id={`${id}-help`} className={error ? "text-meta text-danger-text" : "text-meta text-fg-3"} role={error ? "alert" : undefined}>
        {error ?? "Digabung ke body request terakhir, untuk parameter yang belum dikenal EZClaw. Field yang dikelola EZClaw (model, messages, stream) tidak bisa ditimpa."}
      </p>
    </details>
  );
}
