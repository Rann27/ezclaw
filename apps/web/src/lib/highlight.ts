import type { HighlighterCore } from "shiki/core";

type LangLoader = () => Promise<{ default: unknown }>;

/** Loaded on demand, so only the languages a conversation actually shows are downloaded. */
const LANGS: Record<string, LangLoader> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  cs: "csharp",
  rb: "ruby",
  jsonc: "json",
  htm: "html",
  "c++": "cpp",
};

const THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]);
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

export function resolveLang(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  const lang = ALIASES[key] ?? key;
  return lang in LANGS ? lang : null;
}

/** Returns highlighted HTML (colours as CSS variables for both themes), or null for unknown languages. */
export async function highlight(code: string, rawLang: string | undefined): Promise<string | null> {
  const lang = resolveLang(rawLang);
  if (!lang) return null;
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage((await LANGS[lang]!()).default as never);
  return hl.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
}
