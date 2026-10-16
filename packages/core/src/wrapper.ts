import type { HarnessSegment, SegmentWrap } from "./agent.js";

export interface WrapperVars {
  date: string;
  os: string;
  shell: string;
  workspace: string;
  approval: string;
  model: string;
  /** IANA time zone, e.g. Asia/Jakarta. */
  timezone?: string;
  /** Lowercase shell name as Codex writes it: powershell or bash. */
  shellName?: string;
  /** Codex-style permissions text for the current mode. */
  codexPermissions?: string;
}

export function fillVars(template: string, v: WrapperVars): string {
  return template
    .replaceAll("{{date}}", v.date)
    .replaceAll("{{os}}", v.os)
    .replaceAll("{{shell}}", v.shell)
    .replaceAll("{{workspace}}", v.workspace)
    .replaceAll("{{approval}}", v.approval)
    .replaceAll("{{model}}", v.model)
    .replaceAll("{{timezone}}", v.timezone ?? "")
    .replaceAll("{{shell_name}}", v.shellName ?? v.shell.toLowerCase())
    .replaceAll("{{codex_permissions}}", v.codexPermissions ?? "");
}

/** A title as a tag name: "Communication style" becomes "communication_style". */
export function tagName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug && /^[a-z]/.test(slug) ? slug : `section_${slug || "x"}`;
}

function wrapOne(seg: HarnessSegment, wrap: SegmentWrap, vars: WrapperVars): string {
  const body = fillVars(seg.content, vars).trim();
  if (!body) return "";
  if (wrap === "tags") {
    const tag = tagName(seg.title);
    return `<${tag}>\n${body}\n</${tag}>`;
  }
  return body;
}

export interface RenderedWrapper {
  /** Segments that read the same on every request, in their order. Keep these first so a provider can cache them. */
  stable: string;
  /** Segments marked dynamic (date, folder, mode), sent last. */
  dynamic: string;
  /** Segments placed as developer messages, one message each, in order. Not wrapped: they carry their own markers. */
  developer: string[];
  /** Segments placed in the context message before the owner's message, in order. */
  context: string[];
}

/** Joins the enabled segments. Stable ones keep their order and come first; dynamic ones follow. */
export function renderSegments(segments: HarnessSegment[], wrap: SegmentWrap, vars: WrapperVars): RenderedWrapper {
  const enabled = segments.filter((s) => s.enabled);
  const placed = (p: "developer" | "context") =>
    enabled
      .filter((s) => (s.placement ?? "system") === p)
      .map((s) => fillVars(s.content, vars).trim())
      .filter(Boolean);
  const on = enabled.filter((s) => (s.placement ?? "system") === "system");
  const join = (list: HarnessSegment[]) =>
    list
      .map((s) => wrapOne(s, wrap, vars))
      .filter(Boolean)
      .join("\n\n");
  return { stable: join(on.filter((s) => !s.dynamic)), dynamic: join(on.filter((s) => s.dynamic)), developer: placed("developer"), context: placed("context") };
}

/** Wraps an extra block (memory, project files) the same way as the profile's own segments. */
export function wrapBlock(title: string, body: string, wrap: SegmentWrap): string {
  const text = body.trim();
  if (!text) return "";
  if (wrap === "tags") {
    const tag = tagName(title);
    return `<${tag}>\n${text}\n</${tag}>`;
  }
  return `# ${title}\n${text}`;
}

const PURPOSES: [RegExp, string][] = [
  [/working with the user|user interaction/i, "Cara berinteraksi dengan pengguna: update di tengah kerja dan jawaban akhir."],
  [/identity|identitas|personality|kepribadian|who you are|role/i, "Siapa model ini dan untuk siapa ia bekerja."],
  [/environment|lingkungan|context/i, "Fakta saat ini: tanggal, sistem, folder kerja."],
  [/skill/i, "Daftar skill dan kapan harus membacanya."],
  [/subagent|agent/i, "Cara memanggil dan berbicara dengan agent lain."],
  [/messag|notif/i, "Cara pesan dan notifikasi masuk ke model."],
  [/slash|command/i, "Perintah yang bisa disarankan ke pengguna."],
  [/tool/i, "Kapan dan bagaimana memakai tools."],
  [/destructive|safety|keamanan|risk|untrusted/i, "Batas keamanan: tindakan berisiko dan konten yang tidak tepercaya."],
  [/communicat|writing|style|format|answer|komunikasi|talking/i, "Cara menulis dan menyusun jawaban."],
  [/working|work|autonomy|persistence|editing|cara bekerja|how to work/i, "Cara mengerjakan tugas dari awal sampai selesai."],
  [/guideline|rule|aturan/i, "Aturan perilaku yang selalu berlaku."],
  [/memory|memori/i, "Hal yang diingat tentang pengguna dan proyek."],
];

export function guessPurpose(title: string): string {
  return PURPOSES.find(([re]) => re.test(title))?.[1] ?? "";
}

function slugId(title: string, used: Set<string>): string {
  const base = tagName(title).slice(0, 50);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  used.add(id);
  return id;
}

const DYNAMIC_TITLE = /^(environment|lingkungan)$/i;

/**
 * Splits any wrapper text into segments. Text built from tags (<identity>...</identity>, as in
 * Antigravity) splits per tag and keeps the tag style; Markdown splits per top-level heading and keeps
 * each heading inside its segment, so joining the segments again gives back the original text.
 */
export function splitWrapperText(text: string): { wrap: SegmentWrap; segments: HarnessSegment[] } {
  const clean = text.replace(/\r\n/g, "\n").trim();
  const used = new Set<string>();
  const make = (title: string, content: string): HarnessSegment => ({
    id: slugId(title, used),
    title: title.slice(0, 80),
    purpose: guessPurpose(title),
    enabled: true,
    content: content.trim(),
    dynamic: DYNAMIC_TITLE.test(title.trim()),
    placement: "system",
  });

  // Tags: a line that is only <name>, then a line that is only </name>.
  const tagRe = /^<([A-Za-z_][\w-]*)>[ \t]*\n([\s\S]*?)\n<\/\1>[ \t]*$/gm;
  const tagged: { start: number; end: number; name: string; body: string }[] = [];
  for (let m = tagRe.exec(clean); m; m = tagRe.exec(clean)) tagged.push({ start: m.index, end: m.index + m[0].length, name: m[1]!, body: m[2]! });
  if (tagged.length >= 2) {
    const segments: HarnessSegment[] = [];
    let cursor = 0;
    let loose = 0;
    for (const t of tagged) {
      const between = clean.slice(cursor, t.start).trim();
      if (between) segments.push(make(loose++ === 0 && segments.length === 0 ? "pembuka" : `teks_${loose}`, between));
      segments.push(make(t.name, t.body));
      cursor = t.end;
    }
    const after = clean.slice(cursor).trim();
    if (after) segments.push(make("penutup", after));
    return { wrap: "tags", segments };
  }

  // Markdown: split on the top heading level that occurs more than once.
  const lines = clean.split("\n");
  const level = [1, 2, 3].find((l) => lines.filter((x) => x.startsWith(`${"#".repeat(l)} `)).length >= 2);
  if (level) {
    const marker = `${"#".repeat(level)} `;
    const segments: HarnessSegment[] = [];
    let title = "Pembuka";
    let buf: string[] = [];
    let inFence = false;
    const flush = () => {
      const body = buf.join("\n").trim();
      if (body) segments.push(make(title, body));
    };
    for (const line of lines) {
      if (line.startsWith("```")) inFence = !inFence;
      if (!inFence && line.startsWith(marker)) {
        flush();
        title = line.slice(marker.length).trim() || "Bagian";
        buf = [line];
      } else buf.push(line);
    }
    flush();
    return { wrap: "plain", segments };
  }

  return { wrap: "plain", segments: [make("Instruksi", clean)] };
}

/** Rough token count for display: about four characters per token for English prompts. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
