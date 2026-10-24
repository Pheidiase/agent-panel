import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { AcpConnection } from "./acp-client.mjs";
import { PanelError } from "./session-store.mjs";
import { PANEL_VERSION } from "./version.mjs";

// Permanent deletion of one history record, owned by the agent that wrote it:
// Codex through the app-server `thread/delete` request, Hermes through
// `hermes sessions delete`, Claude Code by removing that session's own files.
// Agent databases are never edited here directly. A record can only be deleted
// when it is in the current history listing, so ids are never trusted blindly.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HERMES_ID = /^(?!-)[A-Za-z0-9._-]{1,200}$/;
export const BATCH_MAX = 50;
// A record touched this recently may belong to a session that is still open.
export const ACTIVE_WINDOW_S = 300;
const STEP_TIMEOUT_MS = 20_000;

export const AGENT_LABELS = { claude: "Claude", codex: "Codex", hermes: "Hermes" };

function checkId(agentId, id) {
  const ok = agentId === "hermes" ? HERMES_ID.test(id) : UUID.test(id);
  if (typeof id !== "string" || !ok) throw new PanelError(400, "Geçersiz kayıt.");
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1e12 ? n / 1000 : n;
}

function within(root, target) {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function runFile(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).toString().trim().slice(0, 300)));
      else resolve(`${stdout}${stderr}`.toString());
    });
  });
}

export class HistoryDeleter {
  // listHistory: () => Promise<record[]> — the same listing the History view uses.
  // agents: the agents.json mapping of agent id to executable path.
  // codexCommand: { command, args } for `codex app-server`, or null when unavailable.
  constructor({ listHistory, agents = {}, codexCommand = null, home = os.homedir(), env = process.env, now = () => Date.now() / 1000, run = runFile, connect = null }) {
    this.listHistory = listHistory;
    this.agents = agents;
    this.codexCommand = codexCommand;
    this.home = home;
    this.env = env;
    this.now = now;
    this.run = run;
    this.connect = connect || ((options) => new AcpConnection(options));
  }

  async deleteMany(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > BATCH_MAX)
      throw new PanelError(400, "Geçersiz seçim.");
    const parsed = items.map((item) => {
      const agentId = item?.agentId;
      const id = item?.id;
      if (!Object.hasOwn(AGENT_LABELS, agentId)) throw new PanelError(400, "Geçersiz kayıt.");
      checkId(agentId, id);
      return { agentId, id, key: `${agentId}:${id}` };
    });
    const listing = new Map((await this.listHistory()).map((r) => [`${r.agentId}:${r.id}`, r]));
    const results = [];
    // One at a time: each agent store takes its own lock while deleting.
    for (const item of parsed) {
      const record = listing.get(item.key);
      try {
        if (!record) throw new PanelError(404, "Kayıt artık geçmiş listesinde yok.");
        if (this.now() - seconds(record.updatedAt) < ACTIVE_WINDOW_S)
          throw new PanelError(409, "Bu sohbet az önce kullanıldı; açık olabilir. Biraz sonra tekrar dene.");
        if (item.agentId === "claude") this.deleteClaude(item.id);
        else if (item.agentId === "codex") await this.deleteCodex(item.id);
        else await this.deleteHermes(item.id);
        results.push({ key: item.key, ok: true });
      } catch (error) {
        results.push({ key: item.key, ok: false, error: error.message || "Silinemedi." });
      }
    }
    return results;
  }

  deleteClaude(id) {
    const root = path.join(this.home, ".claude", "projects");
    const historyRoot = path.join(this.home, ".claude", "file-history");
    const history = path.join(historyRoot, id);
    if (fs.existsSync(history) && (fs.lstatSync(historyRoot).isSymbolicLink()
      || fs.lstatSync(history).isSymbolicLink() || !within(historyRoot, fs.realpathSync(history))))
      throw new PanelError(400, "Geçersiz kayıt yolu.");
    let removed = false;
    let folders = [];
    try { folders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); }
    catch { /* no Claude history */ }
    for (const folder of folders) {
      const base = path.join(root, folder.name);
      const file = path.join(base, `${id}.jsonl`);
      if (!fs.existsSync(file)) continue;
      // The file name is a validated UUID, but never follow a link out of the tree.
      if (!within(root, fs.realpathSync(file))) throw new PanelError(400, "Geçersiz kayıt yolu.");
      fs.rmSync(file, { force: true });
      // Side files that belong to this one session (sub-agents, tool results).
      const extra = path.join(base, id);
      if (fs.existsSync(extra) && fs.lstatSync(extra).isDirectory() && within(root, fs.realpathSync(extra)))
        fs.rmSync(extra, { recursive: true, force: true });
      removed = true;
    }
    if (removed && fs.existsSync(history) && fs.lstatSync(history).isDirectory()
      && within(path.join(this.home, ".claude", "file-history"), fs.realpathSync(history)))
      fs.rmSync(history, { recursive: true, force: true });
    if (!removed) throw new PanelError(404, "Claude kaydı bulunamadı.");
  }

  async deleteHermes(id) {
    const binary = this.agents.hermes;
    if (typeof binary !== "string" || !binary) throw new PanelError(503, "Hermes komutu tanımlı değil.");
    const output = await this.run(binary, ["sessions", "delete", "--yes", id], this.env);
    // The CLI exits 0 even when the id does not exist; never report that as deleted.
    if (/\bNo session\b/i.test(String(output))) throw new PanelError(404, "Hermes kaydı bulunamadı.");
  }

  async deleteCodex(id) {
    if (!this.codexCommand) throw new PanelError(503, "Codex komutu tanımlı değil.");
    const conn = this.connect({
      command: this.codexCommand.command,
      args: this.codexCommand.args,
      cwd: this.home,
      env: this.env,
      label: "Codex",
    });
    try {
      conn.start();
      await conn.request(
        "initialize",
        { clientInfo: { name: "agent-panel", version: PANEL_VERSION }, capabilities: {} },
        { timeoutMs: STEP_TIMEOUT_MS },
      );
      await conn.request("thread/delete", { threadId: id }, { timeoutMs: STEP_TIMEOUT_MS });
    } finally {
      await conn.close().catch(() => {});
    }
  }
}
