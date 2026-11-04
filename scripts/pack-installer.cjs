// Installs a pack made by build-pack.mjs into a running EZClaw. Safe to run again: what is already
// the same stays untouched, what differs is backed up first, and comfy-gen's config.json is kept.
// build-pack.mjs prepends `const PAYLOAD = "..."` to this file inside a double-clickable .cmd.
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const pack = JSON.parse(zlib.gunzipSync(Buffer.from(PAYLOAD, "base64")).toString("utf8"));

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const dataDir = path.resolve(flag("data") || process.env.EZCLAW_DATA_DIR || path.join(os.homedir(), ".ezclaw"));
const baseUrl = (flag("url") || `http://127.0.0.1:${process.env.EZCLAW_PORT || 8787}`).replace(/\/$/, "");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const backupDir = path.join(dataDir, "backups", `pack-${stamp}`);

const done = [];
const warnings = [];
const say = (text) => console.log(`  ${text}`);
const warn = (text) => {
  warnings.push(text);
  console.log(`  ! ${text}`);
};

/* ------------------------------------------------------------------ EZClaw */

let token = null;

async function fetchToken() {
  try {
    const html = await (await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3000) })).text();
    return /name="ezclaw-session" content="([^"]+)"/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function api(method, route, body) {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: { "x-ezclaw-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

function findEzclawFolder() {
  const candidates = [flag("ezclaw"), process.cwd(), path.dirname(process.argv[1]), path.dirname(path.dirname(process.argv[1])), pack.ezclawDir];
  return candidates.find((d) => d && fs.existsSync(path.join(d, "run.bat"))) ?? null;
}

async function connect() {
  token = await fetchToken();
  if (token) return;
  const folder = findEzclawFolder();
  if (folder) {
    console.log(`EZClaw belum jalan. Menyalakan dari ${folder} ...`);
    // Detached gives it its own console window, the same one the owner gets from a double-click.
    spawn("cmd.exe", ["/c", path.join(folder, "run.bat")], { cwd: folder, detached: true, stdio: "ignore" }).unref();
  } else {
    console.log(`EZClaw belum jalan di ${baseUrl}. Nyalakan run.bat sekarang; installer menunggu sampai 5 menit.`);
  }
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    token = await fetchToken();
    if (token) return;
  }
  throw new Error(`EZClaw tidak menjawab di ${baseUrl}.`);
}

/* ------------------------------------------------------------------- files */

function sameFiles(dir, files) {
  if (!fs.existsSync(dir)) return false;
  return Object.entries(files).every(([rel, b64]) => {
    const file = path.join(dir, rel);
    return fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(b64, "base64"));
  });
}

function writeFiles(dir, files) {
  for (const [rel, b64] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
  }
}

function installSkills() {
  console.log("Skill");
  for (const skill of pack.skills) {
    const dir = path.join(dataDir, "skills", skill.name);
    if (sameFiles(dir, skill.files)) {
      say(`${skill.name}: sudah sama`);
      continue;
    }
    if (fs.existsSync(dir)) {
      fs.mkdirSync(path.join(backupDir, "skills"), { recursive: true });
      fs.cpSync(dir, path.join(backupDir, "skills", skill.name), { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    writeFiles(dir, skill.files);
    say(`${skill.name}: dipasang`);
  }
  done.push(`${pack.skills.length} skill`);
}

async function comfyProbe() {
  for (const port of [8000, 8188]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const argv = (await res.json()).system?.argv ?? [];
      const at = argv.indexOf("--base-directory");
      return { port, url: `http://127.0.0.1:${port}`, baseDir: at >= 0 ? argv[at + 1] : null };
    } catch {
      // Not on this port.
    }
  }
  return null;
}

function installComfyGen(comfy) {
  console.log("Server comfy-gen");
  const dir = path.join(dataDir, "mcp", "comfy-gen");
  const { "config.json": defaults, ...code } = pack.comfyGen;
  if (!sameFiles(dir, code)) {
    if (fs.existsSync(path.join(dir, "server.mjs"))) {
      fs.mkdirSync(path.join(backupDir, "comfy-gen"), { recursive: true });
      fs.copyFileSync(path.join(dir, "server.mjs"), path.join(backupDir, "comfy-gen", "server.mjs"));
    }
    writeFiles(dir, code);
    say("server.mjs: dipasang");
  } else {
    say("server.mjs: sudah sama");
  }
  const configFile = path.join(dir, "config.json");
  if (fs.existsSync(configFile)) {
    say("config.json: milikmu dipertahankan");
  } else {
    const config = JSON.parse(Buffer.from(defaults, "base64").toString("utf8"));
    if (comfy) config.url = comfy.url;
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    say("config.json: dibuat");
  }
  return path.join(dir, "server.mjs");
}

/* --------------------------------------------------------------------- MCP */

function npmGlobalRoot() {
  try {
    return execFileSync("cmd.exe", ["/c", "npm", "root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** Where each server runs on this computer. Null means it is not here. */
function resolveServer(server, serverJs, comfy) {
  if (server.name === "comfy-gen") return { command: "node", args: [serverJs] };
  if (server.name === "booruer") {
    const folder = flag("booruer") || path.dirname(server.args[0] ?? "");
    const python = path.join(folder, ".venv", "Scripts", "python.exe");
    return fs.existsSync(python) ? { command: python, args: [path.join(folder, "booruer-mcp.py")] } : null;
  }
  if (server.name === "comfyui") {
    const root = npmGlobalRoot();
    const entry = root && path.join(root, "comfyui-mcp", "dist", "index.js");
    const run = entry && fs.existsSync(entry) ? { command: "node", args: [entry] } : { command: "cmd", args: ["/c", "npx", "-y", "comfyui-mcp"] };
    const env = {};
    if (comfy) env.COMFYUI_PORT = String(comfy.port);
    if (comfy?.baseDir) env.COMFYUI_PATH = comfy.baseDir;
    return { ...run, ...(Object.keys(env).length ? { env } : {}) };
  }
  return { command: server.command, args: server.args };
}

async function installMcp(serverJs, comfy) {
  console.log("Server MCP");
  const have = new Map((await api("GET", "/mcp")).servers.map((s) => [s.name, s]));
  let count = 0;
  for (const server of pack.mcp) {
    const where = resolveServer(server, serverJs, comfy);
    if (!where) {
      warn(`${server.name}: tidak ditemukan di komputer ini, dilewati. Jalankan lagi dengan --${server.name} <folder>.`);
      continue;
    }
    const settings = { enabled: server.enabled, agent: server.agent, chat: server.chat, trust: server.trust };
    const row = have.get(server.name) ?? (await api("POST", "/mcp", { name: server.name, transport: "stdio", ...where, ...settings }));
    await api("PATCH", `/mcp/${row.id}`, { ...settings, ...where, toolPolicies: server.toolPolicies });
    say(`${server.name}: ${have.has(server.name) ? "diperbarui" : "ditambahkan"}`);
    count++;
  }
  done.push(`${count} server MCP`);
}

async function applySkillStates() {
  const listed = (await api("GET", "/skills")).skills;
  for (const skill of pack.skills) {
    const row = listed.find((s) => s.name === skill.name && s.source === "EZClaw") ?? listed.find((s) => s.name === skill.name);
    if (!row) throw new Error(`Skill ${skill.name} tidak terbaca oleh EZClaw. EZClaw memakai folder data lain? Jalankan lagi dengan --data <folder>.`);
    await api("PATCH", `/skills/${row.id}`, { enabled: skill.enabled, chat: skill.chat });
  }
}

/* ----------------------------------------------------------------- harness */

function pickFields(profile, sample) {
  return Object.fromEntries(Object.keys(sample).map((k) => [k, profile[k]]));
}

async function installHarness() {
  console.log("Harness");
  const list = (await api("GET", "/harness")).profiles;
  const base = list.find((p) => p.builtin && p.mode === "agent");
  if (!base) throw new Error("Tidak ada profil bawaan mode Agent untuk dijadikan dasar.");
  const replaced = [];
  for (const profile of pack.profiles) {
    const existing = list.find((p) => !p.builtin && p.name === profile.name);
    if (existing && JSON.stringify(pickFields(existing, profile)) === JSON.stringify(profile)) {
      say(`${profile.name}: sudah sama`);
      continue;
    }
    if (existing) replaced.push(existing);
    const row = existing ?? (await api("POST", `/harness/${base.id}/duplicate`));
    await api("PATCH", `/harness/${row.id}`, profile);
    say(`${profile.name}: ${existing ? "diperbarui" : "ditambahkan"}`);
  }
  if (replaced.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "harness.json"), JSON.stringify(replaced, null, 2));
  }
  done.push(`${pack.profiles.length} profil harness`);
}

/* ----------------------------------------------------------- what they need */

function checkPython() {
  console.log("Python");
  const tries = [["python"], ["py", "-3"]];
  const python = tries.find(([cmd, ...rest]) => spawnSync(cmd, [...rest, "--version"], { stdio: "ignore", windowsHide: true }).status === 0);
  if (!python) {
    warn("Python tidak ditemukan. Harness penerjemah butuh Python 3 untuk menulis docx.");
    return;
  }
  const [cmd, ...rest] = python;
  const hasLibs = () => spawnSync(cmd, [...rest, "-c", "import docx, PIL"], { stdio: "ignore", windowsHide: true }).status === 0;
  if (hasLibs()) {
    say("python-docx dan Pillow: sudah ada");
    return;
  }
  if (hasFlag("no-pip")) {
    warn("python-docx atau Pillow belum ada. Pasang dengan: python -m pip install python-docx pillow");
    return;
  }
  say("Memasang python-docx dan Pillow ...");
  spawnSync(cmd, [...rest, "-m", "pip", "install", "--user", "--quiet", "python-docx", "pillow"], { stdio: "inherit", windowsHide: true });
  if (hasLibs()) say("python-docx dan Pillow: terpasang");
  else warn("Gagal memasang python-docx dan Pillow. Coba manual: python -m pip install python-docx pillow");
}

async function checkComfy(comfy) {
  console.log("ComfyUI");
  if (!comfy) {
    say("Sedang tidak jalan, jadi node dan checkpoint belum bisa dicek. Skill tetap terpasang.");
    return;
  }
  say(`Jalan di ${comfy.url}`);
  const has = await fetch(`${comfy.url}/object_info/AttentionCouple`).then((r) => r.json()).catch(() => ({}));
  if (has.AttentionCouple) say("Node regional (Attention Couple): ada");
  else warn("Node Attention Couple tidak ada, jadi regional prompt gagal. Pasang A8R8_ComfyUI_nodes lewat ComfyUI Manager: https://github.com/ramyma/A8R8_ComfyUI_nodes");
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "mcp", "comfy-gen", "config.json"), "utf8"));
    const info = await (await fetch(`${comfy.url}/object_info/CheckpointLoaderSimple`)).json();
    const spec = info.CheckpointLoaderSimple.input.required.ckpt_name[0];
    const names = Array.isArray(spec) ? spec : (info.CheckpointLoaderSimple.input.required.ckpt_name[1]?.options ?? []);
    if (names.includes(config.checkpoint)) say(`Checkpoint default: ${config.checkpoint}`);
    else warn(`Checkpoint default "${config.checkpoint}" tidak ada. Sebutkan checkpoint di prompt, atau ganti di ${path.join(dataDir, "mcp", "comfy-gen", "config.json")}.`);
  } catch {
    warn("Checkpoint default belum bisa dicek.");
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`EZClaw Pack (dibuat ${pack.builtAt.slice(0, 10)})`);
  console.log(`Folder data: ${dataDir}\n`);
  await connect();
  const comfy = await comfyProbe();
  installSkills();
  const serverJs = installComfyGen(comfy);
  await installMcp(serverJs, comfy);
  await applySkillStates();
  await installHarness();
  checkPython();
  await checkComfy(comfy);
  console.log(`\nSelesai: ${done.join(", ")}.`);
  if (fs.existsSync(backupDir)) console.log(`Versi lama disimpan di ${backupDir}`);
  if (warnings.length) console.log(`${warnings.length} hal perlu dicek, lihat tanda ! di atas.`);
}

main().catch((err) => {
  console.error(`\nGagal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
