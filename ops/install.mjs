// Linux/WSL bootstrap. No network, credentials, tunnels or service activation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadAgentBinaries, readPanelSettings, runtimeTools, toolBinary, utf8Env } from "../server/config.mjs";

export function supportedNode(version, range) {
  const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  return !!current && range.split("||").some(part => {
    const minimum = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part)?.slice(1).map(Number);
    return minimum && current[0] === minimum[0] &&
      (current[1] > minimum[1] || current[1] === minimum[1] && current[2] >= minimum[2]);
  });
}

// Exclusive creation preserves existing portal and agent configuration.
function createJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

export function initializeState(state, binaries) {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("State must be a private directory, not a symlink.");
  fs.chmodSync(state, 0o700);
  createJson(path.join(state, "agents.json"), binaries);
  createJson(path.join(state, "auth.json"), { mode: "local", trustProxyHeader: false });
}

// systemd uses its own quoting, including % specifiers and $ expansion.
export function unitQuote(value, executable = false) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Unsupported control character in service configuration.");
  const quoted = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return '"' + (executable ? quoted.replaceAll("$", () => "$$") : quoted) + '"';
}

export function serviceUnits({ root, state, socket, tools, env = process.env, node = process.execPath }) {
  const environment = {
    PATH: env.PATH || path.dirname(node),
    PANEL_STATE_DIR: state,
    PANEL_TMUX_SOCKET: socket,
    PANEL_TMUX_BINARY: tools.tmux,
    PANEL_PYTHON_BINARY: tools.python3,
  };
  // Services start without a login locale; give tmux and the panes UTF-8 only when none is set.
  const locale = utf8Env(env);
  for (const key of ["LC_ALL", "LC_CTYPE"]) if (locale[key] !== env[key]) environment[key] = locale[key];
  for (const key of ["PANEL_WORKSPACE", "PANEL_HOST", "PANEL_PORT", "PANEL_SYSTEMD_RUN_BINARY"])
    if (env[key] !== undefined) environment[key] = env[key];
  const common = `WorkingDirectory=${unitQuote(root)}\n${Object.entries(environment).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`).join("\n")}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nStandardOutput=journal\nStandardError=journal`;
  return {
    "agent-panel-tmux.service": `[Unit]\nDescription=Agent Panel persistent terminals\n[Service]\nType=simple\nExecStart=${unitQuote(tools.tmux, true)} -D -S ${unitQuote(socket, true)} -f ${unitQuote(path.join(root, "config/tmux.conf"), true)}\n${common}\n[Install]\nWantedBy=default.target\n`,
    "agent-panel-web.service": `[Unit]\nDescription=Agent Panel web interface\nWants=agent-panel-tmux.service\nAfter=agent-panel-tmux.service\n[Service]\nExecStart=${unitQuote(node, true)} ${unitQuote(path.join(root, "server/index.mjs"), true)}\n${common}\n[Install]\nWantedBy=default.target\n`,
  };
}

export async function setup({ root = path.resolve(import.meta.dirname, ".."), env = process.env,
  args = process.argv.slice(2), loadPty = () => import("node-pty"), log = console.log } = {}) {
  if (args.includes("--help")) {
    log("Usage / Kullanım: npm run setup [-- --systemd]\n--systemd: write new user units only; never overwrite, enable or start services.");
    return;
  }
  if (args.some(arg => arg !== "--systemd")) throw new Error("Unknown option. Use npm run setup -- --help.");
  if (process.platform !== "linux") throw new Error("Linux or WSL required / Linux veya WSL gerekli.");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!supportedNode(process.version, pkg.engines.node)) throw new Error(`Node ${pkg.engines.node} required; found ${process.version}.`);
  const tools = runtimeTools(env);
  try {
    const pty = await loadPty();
    if (typeof pty.spawn !== "function") throw new Error();
  } catch { throw new Error("node-pty yüklenemedi / cannot load node-pty. Install Python and C/C++ build tools, then run npm ci with a supported Node version."); }
  const state = path.resolve(env.PANEL_STATE_DIR || path.join(root, "var"));
  readPanelSettings({ root, state, env });
  const binaries = loadAgentBinaries({ stateDir: state, env });
  initializeState(state, binaries);
  if (!fs.existsSync(path.join(root, "dist/index.html"))) log("Web build missing / Web derlemesi eksik: npm run build");
  if (args.includes("--systemd")) {
    toolBinary("systemctl", "PANEL_SYSTEMCTL_BINARY", { env });
    const directory = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd/user");
    const units = serviceUnits({ root, state, socket: path.resolve(env.PANEL_TMUX_SOCKET || path.join(state, "tmux.sock")), tools, env });
    fs.mkdirSync(directory, { recursive: true });
    // Check every destination first, avoiding partial installation on conflicts.
    for (const name of Object.keys(units)) {
      try { fs.lstatSync(path.join(directory, name)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error(`Existing unit preserved / Mevcut servis korundu: ${name}. Review it manually before installing.`);
    }
    for (const [name, content] of Object.entries(units)) fs.writeFileSync(path.join(directory, name), content, { flag: "wx", mode: 0o600 });
    log("User units written; no service changed / Kullanıcı servis dosyaları yazıldı; servis çalıştırılmadı.");
    log("After setting the password / Paroladan sonra: systemctl --user daemon-reload && systemctl --user enable --now agent-panel-tmux.service agent-panel-web.service");
  }
  log("Setup complete / Kurulum tamamlandı. Next / Sonraki: npm run set-password, npm start");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  setup().catch(error => { console.error(error.message); process.exitCode = 1; });
}
