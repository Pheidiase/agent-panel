import { errorCode } from "./error-codes.mjs";
import { replayEvents } from "./event-replay.mjs";
import { SessionCreation } from "./session-creation.mjs";
import { ImageUploads } from "./uploads.mjs";
import { createAuth } from "./auth.mjs";
import { anonymousAsset, authFailure, mountAuthRoutes } from "./auth-http.mjs";
import { orderedMessages } from "./message-queue.mjs";
import { createUsageReader } from "./usage.mjs";
import express from "express";
import { readOrigins, hostAllowed, originAllowed } from "./origins.mjs";
import { WebSocketServer } from "ws";
import * as pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Sessions, PanelError, exec, GEOMETRY_PRESETS, DEFAULT_GEOMETRY } from "./session-store.mjs";
import { StructuredManager, resolveAcpCommand } from "./structured-manager.mjs";
import { CodexManager, resolveCodexCommand } from "./codex-manager.mjs";
import { ClaudeManager, resolveClaudeCommand } from "./claude-manager.mjs";
import { readClaudeConversation, readClaudeLogById } from "./claude-conversation.mjs";
import { readCodexConversation } from "./codex-conversation.mjs";
import { StructuredStore } from "./structured-store.mjs";
import { resolveCronDir } from "./cron-store.mjs";
import { createCronReader } from "./cron-reader.mjs";
import { setStaticCache } from "./static-cache.mjs";
import { PANEL_VERSION } from "./version.mjs";
import { LiveState } from "./live-state.mjs";
import { listProjectFiles, FILES_QUERY_MAX } from "./files-index.mjs";
import { HistoryPrefs } from "./history-prefs.mjs";
import { ProjectPrefs } from "./project-prefs.mjs";
import { HistoryDeleter } from "./history-delete.mjs";
import { loadProjects, refreshProjects } from "./projects.mjs";
import { loadAgentBinaries, readPanelSettings, projectConfigFile, runtimeTools, utf8Env } from "./config.mjs";

process.umask(0o077);
const root = path.resolve(import.meta.dirname, "..");
const state = process.env.PANEL_STATE_DIR || path.join(root, "var");
const { port, host, workspace, homeUrl } = readPanelSettings({ root, state });
const tools = runtimeTools();
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const socket = process.env.PANEL_TMUX_SOCKET || path.join(state, "tmux.sock");
const binaryConfig = loadAgentBinaries({ stateDir: state });
const projectOpts = {
  configFile: projectConfigFile(root, state),
  workspace,
};
const projects = loadProjects(projectOpts);
let projectsAt = Date.now();
// New workspace folders appear without a restart: re-scan (throttled) on API use.
const refreshProjectsSoon = (_req, _res, next) => {
  if (Date.now() - projectsAt > 2000) {
    projectsAt = Date.now();
    refreshProjects(projects, projectOpts);
  }
  next();
};
const agents = [
  {
    id: "hermes",
    name: "Hermes",
    description: "Genel amaçlı düşünme ortağı",
    color: "amber",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Kod ve proje geliştirme",
    color: "sage",
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "Kod ve araştırma",
    color: "purple",
  },
  // Plain terminal-only login shell (no chat tier); real TTY, so sudo can prompt.
  {
    id: "shell",
    name: "Kabuk",
    description: "Terminal (bash)",
    color: "ink",
  },
].map((a) => {
  const executable = binaryConfig[a.id];
  return { ...a, executable, available: !!executable && fs.existsSync(executable) };
});
const sessions = new Sessions({
  root,
  stateDir: state,
  socket,
  projects,
  agents,
  tools,
});
// Structured chat sessions: one panel-owned agent child per chat, separate
// from the tmux tier — `hermes acp` (ACP), `codex app-server` (Codex) and
// headless stream-json `claude` (Claude Code) share one record store;
// ownership is decided by each record's agentId.
// The managers reload their records from the same private state dir on boot.
const structuredStore = new StructuredStore({ stateDir: state });
const structured = new StructuredManager({
  root,
  stateDir: state,
  agentCommand: binaryConfig.hermes ? resolveAcpCommand({ stateDir: state }) : null,
  projects,
  env: process.env,
  store: structuredStore,
});
const codex = new CodexManager({
  root,
  stateDir: state,
  agentCommand: binaryConfig.codex ? resolveCodexCommand({ stateDir: state }) : null,
  projects,
  env: process.env,
  store: structuredStore,
});
const claude = new ClaudeManager({
  root,
  stateDir: state,
  agentCommand: binaryConfig.claude ? resolveClaudeCommand({ stateDir: state }) : null,
  projects,
  env: process.env,
  store: structuredStore,
});
const chatManagers = [structured, codex, claude];
const chatList = () => chatManagers.flatMap((manager) => manager.list());
const structuredViewers = new Map();
// Live session-list channel: every signed-in viewer receives one snapshot and
// then incremental patches, so the list stays current without per-client
// polling. The build reuses the same merge the REST list serves.
const live = new LiveState({
  build: async () => {
    const terminal = (await sessions.list()).map((record) => ({
      ...record,
      kind: "terminal",
    }));
    return [...terminal, ...chatList()];
  },
});
const liveClients = new Set();
live.on("patch", (payload) => {
  for (const ws of liveClients) send(ws, payload);
});
live.on("snapshot", (payload) => {
  for (const ws of liveClients) send(ws, payload);
});
function broadcastStructuredEvent(id, event) {
  for (const client of structuredViewers.get(id) || [])
    if (!client.replaying) send(client.ws, { type: "event", event });
}
function broadcastStructuredState(id, state, models) {
  for (const client of structuredViewers.get(id) || [])
    send(client.ws, { type: "state", state, models });
  live.kick();
}
for (const manager of chatManagers) {
  manager.on("event", broadcastStructuredEvent);
  // Capture the catalog in the same synchronous emission as its state. On a
  // cold resume hello has no runtime/catalog yet; the ready-state emission
  // supplies it without a second viewer connection or an async stale snapshot.
  manager.on("state", (id, state) =>
    broadcastStructuredState(id, state, manager.runtimes.get(id)?.models ?? null),
  );
}
function findSession(id) {
  try {
    return { kind: "terminal", record: sessions.get(id) };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return { kind: "structured", record: structuredManager(id).get(id) };
}

// Resolves which structured manager owns a chat id (ACP, Codex or Claude).
function structuredManager(id) {
  for (const manager of chatManagers) {
    try {
      manager.get(id);
      return manager;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  throw new PanelError(404, "Oturum bulunamadı.");
}
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
const grants = new Map();
const portalAuth = createAuth({ state, app: "panel", port, grants });
const tickets = new Map();
const viewers = new Map();
const writers = new Map();
function revokeConnections(token) {
  for (const [key, ticket] of tickets) if (ticket.grant.token === token) tickets.delete(key);
  for (const ws of wss.clients) if (ws.panel?.grant.token === token) ws.close(4001, "SIGNED_OUT|Çıkış yapıldı");
}
function originList() {
  return readOrigins({ state, port });
}
function hostOK(req) {
  return hostAllowed(originList(), req.headers.host);
}
function originOK(req) {
  return originAllowed(originList(), req.headers.host, req.headers.origin);
}
async function auth(req, res, next) {
  try {
    req.panelGrant = await portalAuth.session(req);
    if (!req.panelGrant) return res.status(401).json({ error: "Giriş yapmalısın.", code: "AUTH_REQUIRED" });
    refreshProjectsSoon(req, res, next);
  } catch (error) { next(error); }
}
function mutation(req, res, next) {
  const supplied = req.headers["x-panel-csrf"], expected = req.panelGrant.csrf;
  if (!originOK(req) || typeof supplied !== "string" || typeof expected !== "string"
    || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    return res.status(403).json({ error: "İstek doğrulanamadı.", code: "ORIGIN_INVALID" });
  next();
}
function send(ws, data) {
  if (ws.readyState === 1) {
    if (ws.bufferedAmount > 1024 * 1024) ws.close(1013, "SLOW_CONNECTION|Yavaş bağlantı");
    else ws.send(JSON.stringify(data));
  }
}
function roles(id) {
  for (const v of viewers.get(id) || [])
    send(v.ws, { type: "role", writer: writers.get(id) === v.ws });
}
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (!hostOK(req)) return res.status(403).json({ error: "Geçersiz host.", code: "HOST_INVALID" });
  if (originList().some(origin => origin.startsWith("https://") && new URL(origin).host === req.headers.host))
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});
mountAuthRoutes(app, portalAuth, { originOK, revokeConnections });
app.use(express.json({ limit: "64kb", inflate: false }));
app.get("/api/health", (_req, res) => res.json({ ok: true, version: PANEL_VERSION }));
app.get("/api/me", auth, (req, res) =>
  res.json({ username: req.panelGrant.username, userId: req.panelGrant.userId, owner: req.panelGrant.owner, csrf: req.panelGrant.csrf }),
);
app.post("/api/logout", auth, mutation, async (req, res, next) => {
  try {
    const cookie = await portalAuth.logout(req, req.panelGrant);
    revokeConnections(req.panelGrant.token);
    res.setHeader("Set-Cookie", cookie); res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get("/api/catalog", auth, (_req, res) =>
  res.json({
    version: PANEL_VERSION,
    projects,
    agents,
    structured: structured.available,
    structuredCodex: codex.available,
    structuredClaude: claude.available,
    geometry: GEOMETRY_PRESETS,
    defaultGeometry: DEFAULT_GEOMETRY,
    homeUrl,
    ...Object.assign({}, ...optionalCatalog.map(entry => entry())),
  }),
);
// Read-only Hermes cron view for the panel's "Koşular" page; the module only
// parses jobs.json and opens executions.db read-only.
const cronDir = resolveCronDir();
const readCron = createCronReader({ dir: cronDir });
app.get("/api/cron", auth, async (_req, res, next) => {
  try {
    res.json(await readCron());
  } catch (error) {
    next(error);
  }
});
// Pasted/dropped images: stored privately for the agent to read by path and
// deleted after a day. Only recognised image types, checked by magic bytes.
const imageUploads = new ImageUploads(path.join(state, "uploads"));
try { imageUploads.sweep(); } catch { /* Cleanup is best effort. */ }
setInterval(() => { try { imageUploads.sweep(); } catch {} }, 30 * 60 * 1000).unref();
app.post("/api/uploads", auth, mutation, express.raw({ type: "image/*", limit: "10mb", inflate: false }), (req, res, next) => {
  try { res.json({ path: imageUploads.save(req.body, req.headers["content-type"]) }); }
  catch (error) { next(error); }
});
const usage = createUsageReader({ stateDir: state });
app.get("/api/usage", auth, async (_req, res, next) => {
  try {
    res.json(await usage());
  } catch (error) {
    next(error);
  }
});
// İsteğe bağlı modüller (server/optional/*.mjs): klasör ya da dosya yoksa hiçbir şey kaydolmaz,
// /api/catalog ilgili alanı hiç döndürmez (arayüz bunu "yok" sayar).
const optionalDir = path.join(root, "server/optional"), optionalCatalog = [];
for (const file of fs.existsSync(optionalDir) ? fs.readdirSync(optionalDir).filter(name => name.endsWith(".mjs")).sort() : []) {
  const entry = await (await import(pathToFileURL(path.join(optionalDir, file)).href)).register?.(app, { auth, mutation, root, state });
  if (entry?.catalog) optionalCatalog.push(entry.catalog);
}
app.get("/api/sessions", auth, async (req, res, next) => {
  try {
    const snapshot = await live.current();
    // Keep the array response for existing API consumers. The panel opts in
    // to the same versioned snapshot that the live socket uses.
    res.json(req.query.versioned === "1" ? snapshot : snapshot.items);
  } catch (e) {
    next(e);
  }
});
async function listHistory() {
  const r = await exec(
    tools.python3,
    [path.join(root, "server/history.py"), JSON.stringify(projects)],
    { timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(r.stdout);
}
app.get("/api/history", auth, async (_req, res, next) => {
  try {
    res.json(await listHistory());
  } catch (e) {
    next(e);
  }
});
const historyPrefs = new HistoryPrefs(state);
const projectPrefs = new ProjectPrefs(state);
const historyDeleter = new HistoryDeleter({
  listHistory,
  agents: binaryConfig,
  codexCommand: resolveCodexCommand({ stateDir: state }),
});
// Permanent: removes the record from the agent's own store, then forgets the
// panel's hide flag and title for it. Failed items stay and are reported.
app.post("/api/history/delete", auth, mutation, async (req, res, next) => {
  try {
    const results = await historyDeleter.deleteMany(req.body?.items);
    historyPrefs.forget(results.filter((r) => r.ok).map((r) => r.key));
    res.json({ results, prefs: historyPrefs.snapshot() });
  } catch (e) {
    next(e);
  }
});
// Hide flags and titles of records that no longer exist in the agent's own store
// (deleted elsewhere) are dropped, so the "hidden" count never lists ghosts.
async function pruneHistoryPrefs() {
  const keys = [...new Set([...historyPrefs.hidden, ...historyPrefs.titles.keys()])];
  if (keys.length === 0) return;
  try {
    const exist = new Set();
    for (let offset = 0; offset < keys.length; offset += 100) {
      const r = await exec(tools.python3,
        [path.join(root, "server/history-exists.py"), JSON.stringify(keys.slice(offset, offset + 100))],
        { timeout: 5000, maxBuffer: 256 * 1024 });
      for (const key of JSON.parse(r.stdout)) exist.add(key);
    }
    historyPrefs.forget(keys.filter((k) => !exist.has(k)));
  } catch {
    /* Unreadable store: keep everything rather than forget by mistake. */
  }
}
app.get("/api/history-prefs", auth, async (_req, res, next) => {
  try {
    await pruneHistoryPrefs();
    res.json(historyPrefs.snapshot());
  } catch (e) {
    next(e);
  }
});
app.get("/api/project-prefs", auth, (_req, res) => res.json(projectPrefs.snapshot()));
app.post("/api/project-prefs", auth, mutation, (req, res, next) => {
  try {
    res.json(projectPrefs.setHidden(req.body));
  } catch (e) {
    next(e);
  }
});
app.post("/api/history-prefs/hidden", auth, mutation, (req, res, next) => {
  try {
    res.json(historyPrefs.setHidden(req.body));
  } catch (e) {
    next(e);
  }
});
app.post("/api/history-prefs/title", auth, mutation, (req, res, next) => {
  try {
    res.json(historyPrefs.setTitle(req.body));
  } catch (e) {
    next(e);
  }
});
const sessionCreation = new SessionCreation({
  list: async () => [...await sessions.list(), ...chatList()],
  findExisting: body => {
    const records = body.kind === "structured" ? chatList() : sessions.records;
    return records.find(record => record.agentId === body.agentId && record.requestId === body.requestId);
  },
  create: body => body.kind === "structured"
    ? (body.agentId === "codex" ? codex : body.agentId === "claude" ? claude : structured).create(body)
    : sessions.create(body),
});
app.post("/api/sessions", auth, mutation, async (req, res, next) => {
  try {
    const created = await sessionCreation.run(req.body || {});
    live.kick();
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});
app.patch("/api/sessions/:id", auth, mutation, async (req, res, next) => {
  try {
    const found = findSession(req.params.id);
    const updated =
      found.kind === "structured"
        ? await structuredStore.update(req.params.id, req.body)
        : await sessions.update(req.params.id, req.body);
    live.kick();
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
app.get("/api/sessions/:id/output", auth, async (req, res, next) => {
  try { res.json(await sessions.output(req.params.id)); }
  catch (e) { next(e); }
});
app.get("/api/sessions/:id/scrollback", auth, async (req, res, next) => {
  try { res.json(await sessions.scrollback(req.params.id)); }
  catch (e) { next(e); }
});
// Clean message view of a Claude Code or Codex terminal session (running or ended), read from the
// agent's own conversation log. Anything else answers `available: false` and
// the reader keeps using the terminal output.
app.get("/api/sessions/:id/conversation", auth, async (req, res, next) => {
  try {
    const record = sessions.get(req.params.id);
    if (record.agentId !== "claude" && record.agentId !== "codex") return res.json({ available: false });
    const all = await sessions.list();
    const live = all.find((s) => s.id === record.id);
    const running = live?.status === "running";
    if (record.agentId === "claude") {
      if (running) {
        const found = await readClaudeConversation(live.pid);
        if (found.available) {
          if (found.cwd && (record.log?.id !== found.sessionId || record.log?.cwd !== found.cwd))
            sessions.rememberLog(record.id, { id: found.sessionId, cwd: found.cwd }).catch(() => {});
          const { cwd: _cwd, ...rest } = found;
          return res.json(rest);
        }
      }
      // Ended (or not yet mapped): the log remembered while it ran, if any.
      const saved = record.log ? readClaudeLogById(record.log) : { available: false };
      const { cwd: _cwd, ...rest } = saved;
      return res.json(rest);
    }
    const project = projects.find((p) => p.id === record.projectId);
    if (!project) return res.json({ available: false });
    // Any other panel Codex in the same folder (running or not) started inside
    // the match window makes the thread unprovable; an ended pane is fine.
    const otherStarts = all
      .filter((s) => s.id !== record.id && s.agentId === "codex" && s.projectId === record.projectId && (running ? s.status === "running" : true))
      .map((s) => s.createdAt);
    res.json(await readCodexConversation({ cwd: project.path, startedAt: record.createdAt, otherStarts }));
  } catch (e) {
    next(e);
  }
});
// Bounded file listing for the chat composer's "@" mention picker: paths are
// relative to the session's project, read-only, and capped by the index.
app.get("/api/sessions/:id/files", auth, async (req, res, next) => {
  try {
    const found = findSession(req.params.id);
    const project = projects.find((p) => p.id === found.record.projectId);
    if (!project) throw new PanelError(404, "Oturumun projesi bulunamadı.");
    const query = req.query.q;
    if (query !== undefined && (typeof query !== "string" || query.length > FILES_QUERY_MAX))
      throw new PanelError(400, "Geçersiz dosya araması.");
    const result = await listProjectFiles(project.path, { query: query ?? "" });
    res.json({ files: result.files, truncated: result.truncated, total: result.total });
  } catch (e) { next(e); }
});
app.post("/api/sessions/:id/geometry", auth, mutation, async (req, res, next) => {
  try {
    const { cols, rows } = req.body || {};
    const record = await sessions.setGeometry(req.params.id, cols, rows);
    live.kick();
    for (const v of viewers.get(req.params.id) || []) {
      // Only this explicit user action resizes an attached client's PTY.
      v.terminal.resize(record.geometry.cols, record.geometry.rows);
      send(v.ws, { type: "geometry", cols: record.geometry.cols, rows: record.geometry.rows });
    }
    res.json(record);
  } catch (e) { next(e); }
});
app.post("/api/sessions/:id/stop", auth, mutation, async (req, res, next) => {
  try {
    const found = findSession(req.params.id);
    if (found.kind === "structured") {
      const stopped = await structuredManager(req.params.id).stop(req.params.id);
      live.kick();
      res.json(stopped);
    } else {
      await sessions.stop(req.params.id);
      for (const v of viewers.get(req.params.id) || []) v.ws.close(4004, "SESSION_STOPPED|Oturum sonlandırıldı");
      live.kick();
      res.json({ ok: true });
    }
  } catch (e) { next(e); }
});
app.delete("/api/sessions/:id", auth, mutation, async (req, res, next) => {
  try {
    const found = findSession(req.params.id);
    if (found.kind === "structured") {
      await structuredManager(req.params.id).delete(req.params.id);
      for (const client of structuredViewers.get(req.params.id) || [])
        client.ws.close(4004, "SESSION_CLOSED|Session kapatıldı");
      structuredViewers.delete(req.params.id);
    } else {
      for (const v of viewers.get(req.params.id) || [])
        v.ws.close(4004, "SESSION_CLOSED|Session kapatıldı");
      await sessions.end(req.params.id);
    }
    live.kick();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/ticket", auth, mutation, (req, res, next) => {
  try {
    const found = findSession(req.params.id);
    const token = crypto.randomBytes(24).toString("base64url");
    tickets.set(token, {
      id: req.params.id,
      route: found.kind === "structured" ? "/structured" : "/terminal",
      grant: req.panelGrant,
      expires: Date.now() + 30000,
    });
    res.json({ ticket: token });
  } catch (e) {
    next(e);
  }
});
// Live-list ticket: the same one-use 30s pattern; the resulting socket only
// carries the session list, never terminal input.
app.post("/api/live/ticket", auth, mutation, (req, res) => {
  const token = crypto.randomBytes(24).toString("base64url");
  tickets.set(token, { id: "live", route: "/live", grant: req.panelGrant, expires: Date.now() + 30000 });
  res.json({ ticket: token });
});
// Structured chat surface: events feed, prompts, cancel, the approval
// bridge, model/mode switches and an explicit reconnect.
app.get("/api/sessions/:id/events", auth, async (req, res, next) => {
  try {
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0)
      throw new PanelError(400, "Geçersiz sorgu.");
    res.json(structuredManager(req.params.id).readEvents(req.params.id, { after, page: req.query.page === "1" }));
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/prompt", auth, mutation, async (req, res, next) => {
  try {
    const { text } = req.body || {};
    res.json(await structuredManager(req.params.id).prompt(req.params.id, text));
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/cancel", auth, mutation, async (req, res, next) => {
  try {
    res.json(await structuredManager(req.params.id).cancel(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/approvals/:requestId", auth, mutation, async (req, res, next) => {
  try {
    const { optionId } = req.body || {};
    res.json(
      await structuredManager(req.params.id).approve(
        req.params.id,
        req.params.requestId,
        optionId,
        req.body?.answers,
      ),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/model", auth, mutation, async (req, res, next) => {
  try {
    res.json(await structuredManager(req.params.id).setModel(req.params.id, req.body?.modelId, req.body?.reasoningEffort));
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/mode", auth, mutation, async (req, res, next) => {
  try {
    res.json(await structuredManager(req.params.id).setMode(req.params.id, req.body?.modeId));
  } catch (e) {
    next(e);
  }
});
app.post("/api/sessions/:id/connect", auth, mutation, async (req, res, next) => {
  try {
    res.json({
      connected: await structuredManager(req.params.id).ensureConnected(req.params.id),
    });
  } catch (e) {
    next(e);
  }
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "İşlem bulunamadı.", code: "NOT_FOUND" }),
);
app.get("/auth/callback", async (req, res, next) => {
  try {
    const result = await portalAuth.callback(req, new URL(req.url, "http://localhost"));
    res.setHeader("Set-Cookie", result.cookies); res.redirect(302, result.location);
  } catch (error) { next(error); }
});
app.use("/auth", (_req, res) => res.status(404).json({ error: "İşlem bulunamadı.", code: "NOT_FOUND" }));
app.use(async (req, res, next) => {
  try {
    if (portalAuth.mode === "local" && ["GET", "HEAD"].includes(req.method) && anonymousAsset(req.path)) return next();
    if (await portalAuth.session(req)) return next();
    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html" || req.headers.accept?.includes("text/html"))) {
      if (portalAuth.mode === "local") return res.sendFile(path.join(root, "dist/index.html"));
      const result = portalAuth.start(req);
      res.setHeader("Set-Cookie", result.cookie); return res.redirect(302, result.location);
    }
    return res.status(401).json({ error: "Giriş yapmalısın.", code: "AUTH_REQUIRED" });
  } catch (error) { next(error); }
});
app.use(express.static(path.join(root, "dist"), { index: "index.html", setHeaders: setStaticCache }));
app.use(authFailure);
app.use((err, _req, res, _next) => {
  if (err instanceof PanelError) return res.status(err.status).json({ error: err.message, code: err.code || errorCode(err.message, err.status) });
  console.error("Panel operation failed:", err.code || err.name);
  res
    .status(503)
    .json({ error: "İşlem şu anda tamamlanamadı. Yeniden deneyebilirsin.", code: "OPERATION_UNAVAILABLE" });
});
server.on("upgrade", async (req, sock, head) => {
  // After an upgrade Node no longer guards the raw socket: a client reset
  // (ECONNRESET/EPIPE) would be an unhandled 'error' event and kill the process.
  sock.on("error", () => sock.destroy());
  const fail = (code = 403) => {
    if (!sock.destroyed) sock.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);
  };
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return fail();
  }
  if (
    !["/terminal", "/structured", "/live"].includes(url.pathname) ||
    !hostOK(req) ||
    !originOK(req)
  )
    return fail();
  const token = String(req.headers["sec-websocket-protocol"] || "").replace(
    /^panel-ticket\./,
    "",
  );
  const ticket = tickets.get(token);
  tickets.delete(token);
  if (!ticket || ticket.expires <= Date.now()) return fail(401);
  let g;
  try { g = await portalAuth.session(req); } catch (e) { return fail(e.status === 429 ? 429 : 503); }
  if (!ticket || ticket.expires <= Date.now() || !g || g.token !== ticket.grant.token)
    return fail(401);
  // A live-list ticket is only good for the live socket, and vice versa.
  const liveRoute = url.pathname === "/live";
  if (liveRoute !== (ticket.id === "live")) return fail();
  if (url.pathname !== ticket.route) return fail();
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.panel = ticket;
    ws.route = url.pathname;
    ws.structuredAfter = Number(url.searchParams.get("after") ?? 0);
    wss.emit("connection", ws);
  });
});
async function handleStructuredSocket(ws) {
  const { id, grant: g } = ws.panel;
  let client = null;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const set = structuredViewers.get(id);
    if (client) set?.delete(client);
    if (set?.size === 0) structuredViewers.delete(id);
  }
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  try {
    let record;
    let manager;
    try {
      manager = structuredManager(id);
      record = manager.get(id);
    } catch {
      ws.close(4004, "SESSION_NOT_OPEN|Session artık açık değil");
      return;
    }
    if (ws.readyState !== 1) return;
    if (g.expires < Date.now() || !grants.has(g.token)) {
      ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
      return;
    }
    const clients = structuredViewers.get(id) || new Set();
    if (clients.size >= 4) {
      ws.close(1013, "CONNECTION_LIMIT|En fazla dört bağlantı");
      return;
    }
    // Subscribe before reading so nothing falls between the snapshot and the
    // live stream; the client dedupes by event seq.
    client = { ws, grant: g, replaying: true };
    clients.add(client);
    structuredViewers.set(id, clients);
    const info = await manager.sessionInfo(id);
    send(ws, {
      type: "hello",
      session: info.session,
      state: info.state,
      models: info.models,
    });
    const after =
      Number.isInteger(ws.structuredAfter) && ws.structuredAfter > 0
        ? ws.structuredAfter
        : 0;
    await replayEvents(client, options => manager.readEvents(id, options), after);
    // Opening a chat resumes its agent process in the background (bounded by
    // the running-chat cap); state events report the outcome.
    if (!record.endedAt) manager.ensureConnected(id).catch(() => {});
  } catch {
    ws.close(1011, "SESSION_OPEN_FAILED|Oturum açılamadı");
    cleanup();
  }
}
const LIVE_CLIENT_LIMIT = 16;
// Live session-list socket: one snapshot on attach, then patches; the only
// inbound message is an explicit resync after a detected version gap.
function handleLiveSocket(ws) {
  const { grant: g } = ws.panel;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    liveClients.delete(ws);
  }
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  if (g.expires < Date.now() || !grants.has(g.token)) {
    ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
    return;
  }
  if (liveClients.size >= LIVE_CLIENT_LIMIT) {
    ws.close(1013, "LIVE_CONNECTION_LIMIT|En fazla on altı bağlantı");
    return;
  }
  liveClients.add(ws);
  ws.on("message", (raw) => {
    if (g.expires < Date.now() || !grants.has(g.token)) {
      ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.close(1008, "DATA_INVALID|Geçersiz veri");
    }
    // "null", sayı veya dizi gibi nesne olmayan JSON'da msg.type fırlatıp süreci çökertirdi.
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return ws.close(1008, "DATA_INVALID|Geçersiz veri");
    if (msg.type === "resync")
      live.current().then((snapshot) => send(ws, snapshot)).catch(() => {});
  });
  live.current().then((snapshot) => send(ws, snapshot)).catch(() => ws.close(1011, "STATE_UNAVAILABLE|Durum alınamadı"));
}
wss.on("connection", async (ws) => {
  if (ws.route === "/structured") {
    handleStructuredSocket(ws);
    return;
  }
  if (ws.route === "/live") {
    handleLiveSocket(ws);
    return;
  }
  const { id, grant: g } = ws.panel;
  let terminal;
  let client;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { terminal?.kill(); } catch { /* A detached PTY may already be dead. */ }
    const set = viewers.get(id);
    if (client) set?.delete(client);
    if (set?.size === 0) viewers.delete(id);
    if (writers.get(id) === ws) {
      writers.delete(id);
      const next = [...(set || [])].find((v) => v.ws.readyState === 1);
      if (next) writers.set(id, next.ws);
    }
    roles(id);
  }
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  try {
    const s = sessions.get(id);
    if (
      !(await sessions.tmux(["has-session", "-t", s.tmux]).then(
        () => true,
        () => false,
      ))
    ) {
      ws.close(4004, "SESSION_NOT_OPEN|Session artık açık değil");
      return;
    }
    if (ws.readyState !== 1) return;
    if (g.expires < Date.now() || !grants.has(g.token)) {
      ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
      return;
    }
    const clients = viewers.get(id) || new Set();
    if (clients.size >= 4) {
      ws.close(1013, "CONNECTION_LIMIT|En fazla dört bağlantı");
      return;
    }
    const env = { ...utf8Env(), TERM: "xterm-256color" };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const geometry = sessions.geometry(s);
    terminal = pty.spawn(
      tools.tmux,
      ["-u", "-S", socket, "attach-session", "-t", s.tmux, "-f", "ignore-size"],
      { name: "xterm-256color", cols: geometry.cols, rows: geometry.rows, cwd: root, env },
    );
    client = { ws, terminal, grant: g };
    clients.add(client);
    viewers.set(id, clients);
    if (!writers.has(id)) writers.set(id, ws);
    roles(id);
    terminal.onData((data) => send(ws, { type: "output", data }));
    terminal.onExit(() => {
      send(ws, { type: "detached" });
      ws.close(4004, "TERMINAL_CLOSED|Terminal bağlantısı kapandı");
    });
    // Authoritative pane geometry: the viewer renders this size and never asks
    // the server to resize, so attaching or resizing a browser cannot rewrap
    // the session the other viewers are reading.
    send(ws, { type: "geometry", cols: geometry.cols, rows: geometry.rows });
    ws.on("message", orderedMessages({
      open: () => !cleaned && ws.readyState === 1,
      fail: () => { ws.close(1011, "TERMINAL_INPUT_FAILED|Terminal girdisi işlenemedi"); cleanup(); },
      handle: async (raw, active) => {
      try { if (!await portalAuth.check(g.token)) return ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu"); }
      catch { return ws.close(4001, "AUTH_UNVERIFIED|Giriş doğrulanamadı"); }
      if (!active()) return;
      if (g.expires < Date.now() || !grants.has(g.token)) {
        ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(1008, "DATA_INVALID|Geçersiz veri");
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return ws.close(1008, "DATA_INVALID|Geçersiz veri");
      if (msg.type === "control") {
        writers.set(id, ws);
        roles(id);
        return;
      }
      if (writers.get(id) !== ws) {
        if (msg.type === "input" && typeof msg.requestId === "string")
          send(ws, { type: "input-rejected", requestId: msg.requestId });
        return;
      }
      if (
        msg.type === "input" &&
        typeof msg.data === "string" &&
        msg.data.length <= 16384 && Buffer.byteLength(msg.data, "utf8") <= 24000
      ) {
        terminal.write(msg.data);
        if (typeof msg.requestId === "string" && msg.requestId.length <= 80)
          send(ws, { type: "input-accepted", requestId: msg.requestId });
      } else if (msg.type === "input" && typeof msg.requestId === "string" && msg.requestId.length <= 80)
        send(ws, { type: "input-rejected", requestId: msg.requestId });
      // The viewer must not drive pane geometry. A stale cached client that
      // still asks for a resize is answered with the session's real size.
      if (msg.type === "resize") {
        const fixed = sessions.geometry(sessions.get(id));
        send(ws, { type: "geometry", cols: fixed.cols, rows: fixed.rows });
      }
      },
    }));
  } catch {
    ws.close(1011, "TERMINAL_OPEN_FAILED|Terminal açılmadı");
    cleanup();
  }
});
setInterval(() => {
  const now = Date.now();
  for (const [token, g] of grants) if (g.expires < now) grants.delete(token);
  for (const [token, t] of tickets) if (t.expires < now) tickets.delete(token);
  for (const set of viewers.values())
    for (const v of set) {
      if (v.grant.expires < now || !grants.has(v.grant.token))
        v.ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
      else if (v.ws.readyState === 1) v.ws.ping();
    }
  for (const set of structuredViewers.values())
    for (const client of set) {
      if (client.grant.expires < now || !grants.has(client.grant.token))
        client.ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
      else if (client.ws.readyState === 1) client.ws.ping();
    }
  for (const ws of liveClients) {
    if (ws.panel.grant.expires < now || !grants.has(ws.panel.grant.token))
      ws.close(4001, "AUTH_EXPIRED|Giriş süresi doldu");
    else if (ws.readyState === 1) ws.ping();
  }
}, 15000).unref();
let checkingAuth = false;
setInterval(async () => {
  if (checkingAuth) return;
  checkingAuth = true;
  try {
    const tokens = new Set([...wss.clients].map(ws => ws.panel?.grant.token).filter(Boolean));
    await Promise.all([...tokens].map(async token => {
      let valid = false;
      try { valid = !!await portalAuth.check(token); } catch { grants.delete(token); }
      if (!valid) for (const ws of wss.clients) if (ws.panel?.grant.token === token) ws.close(4001, "ACCESS_REVOKED|Erişim kapatıldı");
    }));
  } finally { checkingAuth = false; }
}, 5000).unref();
// Attach transcript capture to running sessions and keep its size bounded.
sessions.list().catch(() => {});
setInterval(() => sessions.trimTranscripts().catch(() => {}), 15 * 60 * 1000).unref();
setInterval(() => structured.store.trimAll(), 15 * 60 * 1000).unref();
// Push the session list to every live viewer: instant after mutations, plus a
// slow reconciliation tick for process liveness that writes no record.
live.start();
if (["0.0.0.0", "::"].includes(host))
  console.warn("Güvenlik uyarısı / Security warning: Panel tüm ağ arayüzlerinde dinliyor / listening on all network interfaces. Use HTTPS and restrict access.");
server.listen(port, host, () =>
  console.log(`Agent Panel listening on ${host}:${port}`),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("kapanış: başladı");
  for (const set of viewers.values())
    for (const v of set) v.ws.close(1012, "PANEL_RESTARTING|Panel yeniden başlıyor");
  for (const set of structuredViewers.values())
    for (const client of set) client.ws.close(1012, "PANEL_RESTARTING|Panel yeniden başlıyor");
  for (const ws of liveClients) ws.close(1012, "PANEL_RESTARTING|Panel yeniden başlıyor");
  console.error("kapanış: websocket kapandı");
  // Close handshakes finish after exit() would run; kill the attach PTYs now so
  // node-pty has no live native handles when the process exits.
  let killed = 0;
  for (const set of viewers.values())
    for (const v of set) { try { v.terminal?.kill(); killed++; } catch { /* already dead */ } }
  console.error(`kapanış: ${killed} pty sonlandırıldı`);
  const timeout = setTimeout(() => { console.error("kapanış: zaman aşımı"); process.exit(1); }, 10000);
  await Promise.allSettled([
    ...chatManagers.map(manager => manager.shutdown()),
    new Promise(resolve => server.close(resolve)),
  ]);
  structured.store.closeLogs();
  console.error("kapanış: yöneticiler ve http sunucusu kapandı");
  clearTimeout(timeout);
  live.stop?.();
  console.error("kapanış: çıkılıyor");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
