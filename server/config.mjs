import fs from "node:fs";
import path from "node:path";
import net from "node:net";

// Never include JSON contents in errors: private settings can contain secrets.
export function optionalJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`${path.basename(file)}: ${error instanceof SyntaxError ? "JSON bozuk / invalid JSON" : "okunamadı / cannot read"}.`);
  }
}

export function resolveExecutable(command, env = process.env) {
  if (typeof command !== "string" || !command.trim()) return null;
  const candidates = command.includes("/")
    ? [path.resolve(command)]
    : (env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, command));
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  }) || null;
}

export function toolBinary(name, variable, { env = process.env, required = true } = {}) {
  const binary = resolveExecutable(env[variable] || name, env);
  if (!binary && required) throw new Error(`${name} bulunamadı / not found. PATH veya / or ${variable} ayarını kontrol edin.`);
  return binary;
}

export function runtimeTools(env = process.env) {
  return {
    tmux: toolBinary("tmux", "PANEL_TMUX_BINARY", { env }),
    python3: toolBinary("python3", "PANEL_PYTHON_BINARY", { env }),
    systemdRun: toolBinary("systemd-run", "PANEL_SYSTEMD_RUN_BINARY", { env, required: false }),
  };
}

// tmux (and the agents in its panes) need a UTF-8 locale. Returns `env` unchanged when one
// is active (LC_ALL > LC_CTYPE > LANG); otherwise a copy with C.UTF-8 on the variable that wins.
// C.UTF-8 is built into glibc 2.35+ and shipped by Debian/Ubuntu; if it is missing, setlocale
// falls back to "C", which is harmless because tmux is also started with -u.
export function utf8Env(env = process.env) {
  const active = ["LC_ALL", "LC_CTYPE", "LANG"].find(key => env[key]);
  if (active && /utf-?8/i.test(env[active])) return env;
  return { ...env, [active === "LC_ALL" ? "LC_ALL" : "LC_CTYPE"]: "C.UTF-8" };
}

const AGENT_ENV = { hermes: "PANEL_ACP_BINARY", codex: "PANEL_CODEX_BINARY", claude: "PANEL_CLAUDE_BINARY", shell: "PANEL_SHELL_BINARY" };
export function loadAgentBinaries({ stateDir, env = process.env }) {
  const config = optionalJson(path.join(stateDir, "agents.json"), {});
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.values(config).some(value => typeof value !== "string"))
    throw new Error("agents.json: ajan yolları bir JSON nesnesi olmalı / expected an object of executable paths.");
  const binaries = {};
  for (const [id, variable] of Object.entries(AGENT_ENV)) {
    const command = env[variable]?.trim() || config[id] || (id === "shell" ? "bash" : id);
    const binary = resolveExecutable(command, env);
    if (binary) binaries[id] = binary;
  }
  return binaries;
}

export function readPanelSettings({ root, state, env = process.env }) {
  const config = optionalJson(path.join(state, "settings.json"), {});
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("settings.json: JSON nesnesi gerekli / expected an object.");
  const workspace = env.PANEL_WORKSPACE ?? config.workspace ?? path.resolve(root, "..");
  const host = env.PANEL_HOST ?? config.host ?? "127.0.0.1";
  const port = Number(env.PANEL_PORT ?? config.port ?? 4317);
  if (typeof workspace !== "string" || typeof host !== "string" || !net.isIP(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("settings.json / PANEL_WORKSPACE / PANEL_HOST / PANEL_PORT: geçersiz ayar / invalid setting.");
  let homeUrl = null;
  if (config.homeUrl !== undefined) {
    try {
      const url = new URL(config.homeUrl);
      if (typeof config.homeUrl !== "string" || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
      homeUrl = url.href;
    } catch { throw new Error("settings.json: homeUrl geçerli bir HTTP(S) adresi olmalı / expected an HTTP(S) URL."); }
  }
  return { workspace: path.resolve(root, workspace), host, port, homeUrl };
}

export function projectConfigFile(root, state) {
  const file = path.join(state, "projects.json");
  try { fs.lstatSync(file); return file; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return path.join(root, "config/projects.json");
}
