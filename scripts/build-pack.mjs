// Packs the harness profiles, skills and MCP servers of a running EZClaw into one file:
// packs/EZClaw-Pack-Install.cmd. Double-click it on any computer with EZClaw and Node.js.
// The output holds the owner's own instructions, so packs/ stays out of git.
//
//   node scripts/build-pack.mjs [--url http://127.0.0.1:8787] [--data <folder>]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const PROFILE_PREFIX = "Penerjemah LN";
const SKILLS = ["win-shell", "ln-docx", "ln-qa", "ln-split", "comfy-generate", "booru-tagging", "comfyui-core", "troubleshooting"];
const MCP_SERVERS = ["comfy-gen", "booruer", "comfyui"];
const SKIP_FILE = /(^|[\\/])__pycache__([\\/]|$)|\.pyc$/;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = (flag("url") || "http://127.0.0.1:8787").replace(/\/$/, "");
const dataDir = flag("data") || process.env.EZCLAW_DATA_DIR || join(homedir(), ".ezclaw");

const html = await (await fetch(`${base}/`)).text();
const token = /name="ezclaw-session" content="([^"]+)"/.exec(html)?.[1];
if (!token) throw new Error(`EZClaw tidak menjawab di ${base}.`);
const api = async (route) => {
  const res = await fetch(`${base}/api${route}`, { headers: { "x-ezclaw-token": token } });
  if (!res.ok) throw new Error(`GET ${route}: ${res.status}`);
  return res.json();
};

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const file = join(d, name);
      if (SKIP_FILE.test(file)) continue;
      if (statSync(file).isDirectory()) walk(file);
      else out[relative(dir, file).split(sep).join("/")] = readFileSync(file).toString("base64");
    }
  };
  walk(dir);
  return out;
}

const profiles = (await api("/harness")).profiles
  .filter((p) => !p.builtin && p.name.startsWith(PROFILE_PREFIX))
  .map(({ id: _id, builtin: _builtin, mode: _mode, ...rest }) => rest);

const skillRows = (await api("/skills")).skills;
const skills = SKILLS.map((name) => {
  const row = skillRows.find((s) => s.name === name);
  if (!row) throw new Error(`Skill ${name} tidak ada.`);
  return { name, enabled: row.enabled, chat: row.chat, files: readTree(join(dataDir, "skills", name)) };
});

const serverRows = (await api("/mcp")).servers;
const mcp = MCP_SERVERS.map((name) => {
  const s = serverRows.find((x) => x.name === name);
  if (!s) throw new Error(`MCP server ${name} tidak ada.`);
  return { name, command: s.command, args: s.args, enabled: s.enabled, agent: s.agent, chat: s.chat, trust: s.trust, toolPolicies: s.toolPolicies };
});

const pack = { builtAt: new Date().toISOString(), ezclawDir: root, profiles, skills, mcp, comfyGen: readTree(join(dataDir, "mcp", "comfy-gen")) };
const payload = gzipSync(Buffer.from(JSON.stringify(pack)), { level: 9 }).toString("base64");

// Batch stops at `exit /b`, so it never reaches the script below; node compiles only that part.
const launcher = [
  "@echo off",
  "setlocal",
  "title EZClaw Pack",
  "where node >nul 2>nul",
  "if errorlevel 1 (",
  "  echo Node.js belum terpasang. Pasang dari https://nodejs.org lalu jalankan file ini lagi.",
  "  pause",
  "  exit /b 1",
  ")",
  `node -e "const f=process.argv[1],s=require('fs').readFileSync(f,'utf8'),M=require('module'),m=new M(f);m.filename=f;m.paths=M._nodeModulePaths(require('path').dirname(f));m._compile(s.slice(s.lastIndexOf('//JS-START')),f)" "%~f0" %*`,
  "set CODE=%errorlevel%",
  "echo.",
  "pause",
  "exit /b %CODE%",
  "",
].join("\r\n");

const installer = readFileSync(join(root, "scripts", "pack-installer.cjs"), "utf8");
const outDir = join(root, "packs");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "EZClaw-Pack-Install.cmd");
writeFileSync(out, `${launcher}//JS-START\nconst PAYLOAD = "${payload}";\n${installer}`);
console.log(`${out}\n${profiles.length} profil, ${skills.length} skill, ${mcp.length} server MCP, ${Math.round(statSync(out).size / 1024)} KB`);
