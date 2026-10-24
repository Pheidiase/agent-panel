// Codex structured (app-server) session lifecycle for the panel.
//
// One `codex app-server` child process per structured session, mirroring the
// Hermes ACP tier: started lazily on open/first use, kept alive while the
// panel runs, killed on Stop/Delete. The protocol is newline-delimited
// JSON-RPC on stdio (verified against codex-cli 0.160.0): client requests
// (initialize, thread/start|resume, turn/start|interrupt, model/list,
// thread/read), server notifications (thread/*, turn/*, item/*) and
// server-to-client requests for approvals and user input. The conversation
// restores from the recorded thread id via `thread/resume`, so a closed or
// restarted panel resumes where it left off. tmux and ACP sessions are
// separate stores and are never touched by this manager.
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StructuredStore, STRUCTURED_RECORD_LIMIT } from "./structured-store.mjs";
import { AcpConnection } from "./acp-client.mjs";
import { PanelError } from "./session-store.mjs";
import { codedError } from "./error-codes.mjs";
import { loadAgentBinaries } from "./config.mjs";
import { PANEL_VERSION } from "./version.mjs";
import { attentionOf } from "./attention.mjs";

// Resolves the panel-owned `codex app-server` command: an explicit test
// override wins, otherwise the same agents.json entry the terminal sessions
// use. Mirroring the ACP resolver, the subcommand rides in argv so a bare
// `codex` (which opens the interactive TUI and dies on a pipe) can never be
// spawned by mistake.
export function resolveCodexCommand({ stateDir, env = process.env }) {
  const command = loadAgentBinaries({ stateDir, env }).codex;
  return command ? { command, args: ["app-server"] } : null;
}

export const CODEX_RUNNING_LIMIT = 4;
export const APPROVAL_TIMEOUT_MS = 300_000;
export const PROMPT_MAX_CHARS = 8000;
const INIT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 90_000;
const RESUME_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;
const OUTPUT_CAP = 12_000;
const DIFF_LINE_CAP = 2_000;
const DIFF_CHAR_CAP = 40_000;
const ITEM_KEEP = 300;
const FLUSH_MS = 120;
const CODEX_MODES = [
  { id: "read-only", name: "Salt okunur", description: "Dosyaları inceler; yazma ve komutlar için onay ister." },
  { id: "workspace-write", name: "Proje erişimi", description: "Proje içinde çalışır; sınır dışındaki işlemler için onay ister." },
  { id: "full-access", name: "Tam erişim", description: "Dosya ve ağ sınırı olmadan, komut onayı istemeden çalışır." },
];

function permissionParams(modeId, turn = false) {
  const full = modeId === "full-access";
  if (turn) return {
    approvalPolicy: full ? "never" : "on-request",
    sandboxPolicy: modeId === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : full ? { type: "dangerFullAccess" }
      : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
  return { approvalPolicy: full ? "never" : "on-request", sandbox: full ? "danger-full-access" : modeId };
}

function confirmedMode(response) {
  const type = response?.sandbox?.type;
  if (type === "dangerFullAccess" && response.approvalPolicy === "never") return "full-access";
  if (type === "workspaceWrite" && response.approvalPolicy === "on-request") return "workspace-write";
  if (type === "readOnly" && response.approvalPolicy === "on-request") return "read-only";
  return null;
}

function emptyQuestionAnswers(questions) {
  return { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])) };
}

function questionAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    throw new PanelError(400, "Soruların yanıtları eksik veya geçersiz.");
  if (Object.keys(answers).length !== questions.length || Object.keys(answers).some((id) => !questions.some((question) => question.id === id)))
    throw new PanelError(400, "Her soru tam bir kez yanıtlanmalı; bilinmeyen soru kimliği kullanılamaz.");
  let total = 0;
  const result = [];
  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id)) throw new PanelError(400, "Bir sorunun yanıtı eksik.");
    const value = answers[question.id];
    const values = typeof value === "string" ? [value] : value;
    if (!Array.isArray(values) || values.length === 0 || values.length > 8 || (!question.multiSelect && values.length !== 1) || new Set(values).size !== values.length)
      throw new PanelError(400, "Sorunun yanıt sayısı geçersiz.");
    for (const text of values) {
      if (typeof text !== "string" || !text.trim() || text.length > 4000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))
        throw new PanelError(400, "Yanıt 1–4000 karakter olmalı ve geçerli metin içermeli.");
      total += text.length;
      if (total > 12000) throw new PanelError(400, "Yanıtların toplamı 12000 karakteri aşamaz.");
      if (question.options.length && !question.isSecret && !question.isOther && !question.options.some((option) => option.label === text))
        throw new PanelError(400, "Bu soru için sunulan seçeneklerden birini seç.");
    }
    result.push([question.id, { answers: values }]);
  }
  return { answers: Object.fromEntries(result) };
}

const COMMAND_STATUS = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

// Approval bridge options: the panel's four decisions map 1:1 to the
// app-server's decision strings (accept / acceptForSession / decline /
// cancel). The richer execpolicy/network amendment decisions are not offered.
const APPROVAL_OPTIONS = [
  { optionId: "accept", kind: "allow_once", name: "Onayla (bir kez)" },
  { optionId: "acceptForSession", kind: "allow_always", name: "Oturum boyunca onayla" },
  { optionId: "decline", kind: "reject_once", name: "Reddet" },
  { optionId: "cancel", kind: "reject_always", name: "Reddet ve durdur" },
];

// Unified diff -> old/new text for the panel's diff blocks. Header lines
// (@@, ---, +++) are dropped; a line is context unless it starts with +/-.
export function parseUnifiedDiff(text) {
  const oldLines = [];
  const newLines = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) newLines.push(raw.slice(1));
    else if (raw.startsWith("-")) oldLines.push(raw.slice(1));
    else oldLines.push(raw.startsWith(" ") ? raw.slice(1) : raw),
      newLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }
  const cap = (lines) => {
    let out = lines.slice(0, DIFF_LINE_CAP).join("\n");
    if (out.length > DIFF_CHAR_CAP) out = out.slice(0, DIFF_CHAR_CAP) + "…";
    return out;
  };
  return { oldText: cap(oldLines), newText: cap(newLines) };
}

export class CodexManager extends EventEmitter {
  constructor({ root, stateDir, agentCommand, projects, env, store }) {
    super();
    this.root = root;
    this.stateDir = stateDir;
    this.agentCommand = agentCommand || null; // { command, args } | null
    this.projects = projects;
    this.env = env;
    this.store = store || new StructuredStore({ stateDir });
    this.runtimes = new Map();
    this.stopping = new Map();
    this.store.runtimeMaps.add(this.runtimes);
    this.approvalSerial = 0;
  }

  get available() {
    return !!this.agentCommand;
  }

  project(id) {
    return this.projects.find((p) => p.id === id) || null;
  }

  // This manager owns only codex records; the shared store may hold ACP ones.
  _own(id) {
    const record = this.store.get(id); // throws 404 when unknown
    if (record.agentId !== "codex") throw new PanelError(404, "Oturum bulunamadı.");
    return record;
  }

  list() {
    return this.store
      .list()
      .filter((record) => record.agentId === "codex")
      .map((record) => this.withStatus(record));
  }

  get(id) {
    return this.withStatus(this._own(id));
  }

  withStatus(record) {
    let status = "running"; // panel semantics: alive or resumable on demand
    if (record.endedAt) status = "ended";
    return {
      ...record,
      status,
      attention: attentionOf(this.runtimes.get(record.id)?.pendingApprovals, this.store.signals.get(record.id)),
      connection: this.connectionState(record),
    };
  }

  connectionState(record) {
    if (record.endedAt) return "ended";
    const runtime = this.runtimes.get(record.id);
    return runtime ? runtime.status : "offline";
  }

  stateOf(id) {
    let record = null;
    try {
      record = this._own(id);
    } catch {
      return null;
    }
    const runtime = this.runtimes.get(id);
    let status;
    if (record.endedAt) status = "ended";
    else if (runtime) status = runtime.status;
    else status = "offline";
    return {
      id,
      status,
      title: record.title,
      model: runtime?.models?.currentModelId ?? record.codexModelId ?? null,
      reasoningEffort: runtime?.models?.currentReasoningEffort ?? record.codexReasoningEffort ?? null,
      modes: {
        currentModeId: runtime?.modeId ?? record.codexModeId ?? "workspace-write",
        availableModes: CODEX_MODES.map((mode) => ({ ...mode })),
      },
      settingsChanging: runtime?.settingsChanging ?? false,
      usage: runtime?.usage ?? null,
      pendingApprovalCount: runtime ? runtime.pendingApprovals.size : 0,
      lastError: runtime?.lastError ?? record.lastError ?? null,
    };
  }

  async sessionInfo(id) {
    const record = this._own(id);
    const runtime = this.runtimes.get(id);
    return {
      session: this.withStatus(record),
      state: this.stateOf(id),
      models: runtime?.models ?? null,
    };
  }

  _broadcastState(id) {
    const state = this.stateOf(id);
    if (state) this.emit("state", id, state);
  }

  // ---- Creation -----------------------------------------------------------

  create({ projectId, agentId, title, requestId }) {
    return this.store.enqueueCreate(`${agentId}:${requestId}`, async () => {
      if (!this.available)
        throw new PanelError(503, "Codex yapılandırılmış mod şu an kullanılamıyor.");
      if (agentId !== "codex")
        throw new PanelError(400, "Bu oturum türü yalnız Codex ile açılır.");
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))
        throw new PanelError(400, "Geçersiz işlem kimliği.");
      const previous = this.store.findByIdempotencyKey(requestId);
      if (previous && previous.agentId === "codex") return this.withStatus(previous);
      const project = this.project(projectId);
      if (!project) throw new PanelError(400, "Geçersiz proje veya agent.");
      if (
        typeof title !== "string" ||
        title.length > 80 ||
        /[\x00-\x1f\x7f]/.test(title)
      )
        throw new PanelError(400, "Session adı en fazla 80 karakter olmalı.");
      if (this.store.records.length + this.store.pendingCreates.size - 1 >= STRUCTURED_RECORD_LIMIT)
        throw new PanelError(
          409,
          "Sohbet kaydı sınırına ulaşıldı. Eski bir sohbeti silebilirsin.",
        );
      const live = [...this.runtimes.values()].filter((r) => r.conn?.alive).length;
      if (live >= CODEX_RUNNING_LIMIT)
        throw new PanelError(
          409,
          `Aynı anda en fazla ${CODEX_RUNNING_LIMIT} Codex sohbeti bağlı olabilir.`,
        );
      const id = crypto.randomUUID();
      const runtime = this._startSession({ id, cwd: project.path, resumeThreadId: null });
      try {
        await runtime.starting;
      } catch (error) {
        throw new PanelError(503, `Oturum başlatılamadı: ${error.message}`);
      }
      if (!runtime.conn?.alive)
        throw new PanelError(503, "Oturum başlatılamadı: bağlantı kapandı.");
      const record = {
        id,
        kind: "structured",
        agentId: "codex",
        codexThreadId: runtime.threadId,
        projectId,
        title: title.trim() || `Codex · ${project.name}`,
        createdAt: new Date().toISOString(),
        requestId,
        endedAt: null,
        lastOpenedAt: null,
        archived: false,
        pinned: false,
        lastError: null,
        codexModeId: runtime.modeId,
        codexModelId: runtime.models.currentModelId,
        codexReasoningEffort: runtime.models.currentReasoningEffort,
      };
      try {
        this.store.add(record);
      } catch (error) {
        runtime.intentional = true;
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        this._resolveAllPending(runtime);
        await this._closeRuntime(runtime).catch(() => {});
        throw error;
      }
      this._broadcastState(id);
      return this.withStatus(record);
    });
  }

  // ---- Connection lifecycle ----------------------------------------------

  _startSession({ id, cwd, resumeThreadId, settings = {} }) {
    this.store.assertRunningCapacity(id);
    const runtime = {
      id,
      conn: null,
      status: "starting",
      starting: null,
      threadId: resumeThreadId,
      cwd,
      models: null,
      usage: null,
      inflight: 0,
      currentTurnId: null,
      pendingApprovals: new Map(),
      items: new Map(),
      modeId: CODEX_MODES.some((mode) => mode.id === settings.codexModeId) ? settings.codexModeId : "workspace-write",
      settingsChanging: false,
      intentional: false,
      closed: false,
      lastError: null,
    };
    const connection = new AcpConnection({
      command: this.agentCommand.command,
      args: this.agentCommand.args,
      cwd,
      env: this.env,
      stderrPath: this.store.stderrPath(id),
      label: "Codex",
    });
    runtime.conn = connection;
    connection.onNotification = (method, params) =>
      this._onNotification(id, runtime, method, params);
    connection.onRequest = (method, params) =>
      this._onRequest(id, runtime, method, params);
    connection.on("exit", () => this._onExit(id, runtime));
    runtime.starting = (async () => {
      connection.start();
      await connection.request(
        "initialize",
        { clientInfo: { name: "agent-panel", version: PANEL_VERSION }, capabilities: {} },
        { timeoutMs: INIT_TIMEOUT_MS },
      );
      connection.notify("initialized", {});
      let response;
      let reopened = false;
      const startParams = { cwd, ...permissionParams(runtime.modeId) };
      if (settings.codexModelId) startParams.model = settings.codexModelId;
      if (settings.codexReasoningEffort)
        startParams.config = { model_reasoning_effort: settings.codexReasoningEffort };
      if (runtime.threadId) {
        runtime.status = "resuming";
        this._broadcastState(id);
        try {
          response = await connection.request(
            "thread/resume",
            { threadId: runtime.threadId, excludeTurns: true, ...startParams },
            { timeoutMs: RESUME_TIMEOUT_MS },
          );
        } catch (error) {
          // Distinguish "thread is gone" (start fresh, visibly) from a
          // transient resume failure (fail the connect; the user retries).
          const exists = await this._threadExists(connection, runtime.threadId);
          if (exists !== false)
            throw codedError(`Codex oturumu yüklenemedi: ${error.message}`, "CODEX_RESUME_FAILED");
          response = await connection.request(
            "thread/start",
            startParams,
            { timeoutMs: START_TIMEOUT_MS },
          );
          runtime.threadId = response?.thread?.id ?? null;
          if (!runtime.threadId) throw codedError("Thread kimliği alınamadı.", "CODEX_THREAD_ID_MISSING");
          reopened = true;
          try {
            const record = this._own(id);
            record.codexThreadId = runtime.threadId;
            this.store.save();
          } catch {
            /* Creation path. */
          }
          this._append(id, {
            kind: "status",
            status: "reopened",
            detail:
              "Önceki Codex kaydı bulunamadı; sohbet yeni bir thread ile sürdürülüyor.",
          });
        }
      } else {
        response = await connection.request(
          "thread/start",
          startParams,
          { timeoutMs: START_TIMEOUT_MS },
        );
        runtime.threadId = response?.thread?.id ?? null;
        if (!runtime.threadId) throw codedError("Thread kimliği alınamadı.", "CODEX_THREAD_ID_MISSING");
      }
      if (confirmedMode(response) !== runtime.modeId) throw codedError("Codex istenen erişim ayarını doğrulamadı.", "CODEX_MODE_UNCONFIRMED");
      runtime.modeId = confirmedMode(response);
      const catalog = await this._modelCatalog(connection);
      runtime.models = {
        currentModelId: typeof response?.model === "string" ? response.model : null,
        currentReasoningEffort: response?.reasoningEffort ?? null,
        availableModels: catalog ?? [],
      };
      runtime.status = "idle";
      runtime.lastError = null;
      try {
        const record = this._own(id);
        record.codexModeId = runtime.modeId;
        record.codexModelId = runtime.models.currentModelId;
        record.codexReasoningEffort = runtime.models.currentReasoningEffort;
        this.store.save();
        if (record.lastError) {
          record.lastError = null;
          this.store.save();
        }
      } catch {
        /* Creation path: the record lands right after. */
      }
      if (resumeThreadId && !reopened)
        this._append(id, {
          kind: "status",
          status: "resumed",
          detail: "Oturum Codex kaydından geri yüklendi.",
        });
      this._broadcastState(id);
      return runtime;
    })();
    runtime.starting.then(
      () => {
        runtime.starting = null;
      },
      () => {
        runtime.starting = null;
        runtime.lastError = runtime.lastError || "bağlantı kurulamadı";
        runtime.intentional = true;
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        this._closeRuntime(runtime).catch(() => {});
        try {
          const record = this._own(id);
          record.lastError = runtime.lastError;
          this.store.save();
        } catch {
          /* Creation path. */
        }
        this._broadcastState(id);
      },
    );
    this.runtimes.set(id, runtime);
    this._broadcastState(id);
    return runtime;
  }

  // true/false from the app-server's own history; null when the check itself
  // failed (the caller then fails the resume instead of silently starting fresh).
  async _threadExists(connection, threadId) {
    try {
      const result = await connection.request(
        "thread/read",
        { threadId },
        { timeoutMs: READ_TIMEOUT_MS },
      );
      return !!result;
    } catch (error) {
      const message = String(error?.message || "");
      if (/not.?found|no such|unknown|missing|does not exist/i.test(message)) return false;
      return null;
    }
  }

  async _modelCatalog(connection) {
    try {
      const result = await connection.request("model/list", {}, { timeoutMs: LIST_TIMEOUT_MS });
      const data = Array.isArray(result?.data) ? result.data : [];
      return data
        .filter((model) => model && typeof model.id === "string")
        .map((model) => ({
          modelId: typeof model.model === "string" ? model.model : model.id,
          name: model.displayName || model.id,
          description: typeof model.description === "string" ? model.description : null,
          defaultReasoningEffort: model.defaultReasoningEffort ?? null,
          supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
            .filter((option) => typeof option?.reasoningEffort === "string" && option.reasoningEffort.length > 0 && option.reasoningEffort.length <= 80)
            .map((option) => ({ reasoningEffort: option.reasoningEffort, description: String(option.description ?? "") })),
        }));
    } catch {
      return null;
    }
  }

  async _ensureRuntime(id) {
    const record = this._own(id);
    if (record.endedAt)
      throw new PanelError(409, "Bu oturum sonlandırılmış. Yeni bir sohbet açabilirsin.");
    if (!this.available)
      throw new PanelError(503, "Codex yapılandırılmış mod şu an kullanılamıyor.");
    let runtime = this.runtimes.get(id);
    if (runtime?.starting) {
      try {
        await runtime.starting;
      } catch (error) {
        throw new PanelError(503, `Oturum başlatılamadı: ${error.message}`);
      }
      return this._readyRuntime(id, runtime);
    }
    if (runtime?.conn?.alive) return runtime;
    const live = [...this.runtimes.values()].filter((r) => r.conn?.alive).length;
    if (live >= CODEX_RUNNING_LIMIT)
      throw new PanelError(
        409,
        `Aynı anda en fazla ${CODEX_RUNNING_LIMIT} Codex sohbeti bağlı olabilir. Bir sohbeti sonlandırıp tekrar dene.`,
      );
    const project = this.project(record.projectId);
    if (!project) throw new PanelError(400, "Oturumun projesi bulunamadı.");
    runtime = this._startSession({
      id,
      cwd: project.path,
      resumeThreadId: record.codexThreadId,
      settings: record,
    });
    try {
      await runtime.starting;
    } catch (error) {
      throw new PanelError(503, `Oturum başlatılamadı: ${error.message}`);
    }
    return this._readyRuntime(id, runtime);
  }

  // Startup may finish after Stop/Delete or after its runtime was replaced.
  _readyRuntime(id, runtime) {
    const record = this._own(id);
    if (record.endedAt)
      throw new PanelError(409, "Bu oturum sonlandırılmış. Yeni bir sohbet açabilirsin.");
    if (this.runtimes.get(id) !== runtime || runtime.intentional || !runtime.conn?.alive)
      throw new PanelError(503, "Bağlantı kapandı; yeniden bağlanmayı dene.");
    return runtime;
  }

  // Viewer connect helper: never throws; failures land on the state as
  // lastError so the chat can explain itself instead of failing a socket.
  async ensureConnected(id) {
    try {
      await this._ensureRuntime(id);
      return true;
    } catch (error) {
      try {
        const record = this._own(id);
        record.lastError = error.message;
        this.store.save();
      } catch {
        /* Unknown session: nothing to annotate. */
      }
      this._broadcastState(id);
      return false;
    }
  }

  // ---- Commands -----------------------------------------------------------

  async prompt(id, text) {
    const record = this._own(id);
    if (record.endedAt)
      throw new PanelError(409, "Bu oturum sonlandırılmış. Yeni bir sohbet aç.");
    if (typeof text !== "string" || !text.trim() || text.length > PROMPT_MAX_CHARS || Buffer.byteLength(text) > 16000)
      throw new PanelError(400, `Mesaj 1–${PROMPT_MAX_CHARS} karakter ve en fazla 16000 UTF-8 bayt olmalı.`);
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text))
      throw new PanelError(400, "Mesajda desteklenmeyen kontrol karakteri var.");
    const runtime = await this._ensureRuntime(id);
    if (!runtime.conn?.alive)
      throw new PanelError(503, "Bağlantı hazır değil; birkaç saniye içinde tekrar dene.");
    this._assertIdle(runtime);
    // Codex has no user-message echo notification for panel-sent prompts, so
    // the transcript entry written here stays the only copy.
    this._append(id, { kind: "user", text }, true);
    runtime.inflight += 1;
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    const params = {
      threadId: runtime.threadId,
      input: [{ type: "text", text }],
      ...permissionParams(runtime.modeId, true),
    };
    if (runtime.models?.currentModelId) params.model = runtime.models.currentModelId;
    if (runtime.models?.currentReasoningEffort) params.effort = runtime.models.currentReasoningEffort;
    runtime.conn
      .request("turn/start", params)
      .then((response) => {
        const turnId = response?.turn?.id ?? null;
        if (turnId && !runtime.currentTurnId) runtime.currentTurnId = turnId;
      })
      .catch((error) => {
        runtime.inflight = Math.max(0, runtime.inflight - 1);
        this._append(id, { kind: "error", text: `Tur başlatılamadı: ${error.message}` });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
      });
    return { delivered: true };
  }

  async cancel(id) {
    this._own(id);
    const runtime = this.runtimes.get(id);
    if (!runtime?.conn?.alive) return { cancelled: false };
    // A cancel can arrive before the turn id lands (the turn/start response
    // and its notification are still in flight); wait briefly for it.
    let turnId = runtime.currentTurnId;
    if (!turnId && runtime.inflight > 0) {
      const start = Date.now();
      while (!turnId && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 25));
        if (!runtime.conn?.alive) break;
        turnId = runtime.currentTurnId;
      }
    }
    if (!turnId) return { cancelled: false };
    try {
      await runtime.conn.request("turn/interrupt", { threadId: runtime.threadId, turnId });
    } catch {
      return { cancelled: false };
    }
    this._resolveAllPending(runtime);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    return { cancelled: true };
  }

  async approve(id, requestId, optionId, answers) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new PanelError(409, "Onay isteği artık geçerli değil.");
    const pending = runtime.pendingApprovals.get(requestId);
    if (!pending) throw new PanelError(409, "Onay isteği bulunamadı veya süresi geçti.");
    let response;
    if (pending.kind === "userInput") {
      if (optionId === "__deny") response = emptyQuestionAnswers(pending.questions);
      else if (optionId === "__answer") response = questionAnswers(pending.questions, answers);
      else if (pending.questions.length === 1 && pending.options.some((option) => option.optionId === optionId))
        response = questionAnswers(pending.questions, { [pending.questions[0].id]: optionId });
      else throw new PanelError(400, "Geçersiz soru yanıtı işlemi.");
    } else {
      if (!pending.options.some((option) => option.optionId === optionId))
        throw new PanelError(400, "Geçersiz onay seçimi.");
      response = { decision: optionId };
    }
    clearTimeout(pending.timer);
    runtime.pendingApprovals.delete(requestId);
    this._append(id, { kind: "approval", requestId, status: "decided", optionId: pending.kind === "userInput" ? optionId === "__deny" ? "__deny" : "__answer" : optionId });
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    pending.resolve(response);
    return { ok: true };
  }

  _assertIdle(runtime) {
    if (runtime.settingsChanging || runtime.inflight > 0 || runtime.currentTurnId || runtime.pendingApprovals.size)
      throw new PanelError(409, "Tur veya ayar değişikliği sürüyor; bitmesini bekle.");
  }

  // Resume on the same thread applies session overrides without sending a
  // model prompt. Only the server's effective response becomes visible state.
  async _applySettings(id, runtime, { modeId = runtime.modeId, modelId = runtime.models.currentModelId, reasoningEffort = runtime.models.currentReasoningEffort }) {
    this._assertIdle(runtime);
    runtime.settingsChanging = true;
    this._broadcastState(id);
    try {
      const params = { threadId: runtime.threadId, excludeTurns: true, cwd: runtime.cwd, ...permissionParams(modeId) };
      if (modelId) params.model = modelId;
      if (reasoningEffort) params.config = { model_reasoning_effort: reasoningEffort };
      const response = await runtime.conn.request("thread/resume", params, { timeoutMs: RESUME_TIMEOUT_MS });
      const actualMode = confirmedMode(response);
      if (!actualMode || response?.thread?.id !== runtime.threadId || typeof response.model !== "string")
        throw codedError("Codex etkin ayarları doğrulamadı.", "CODEX_SETTINGS_UNCONFIRMED");
      if (actualMode !== modeId || (modelId && response.model !== modelId) || (reasoningEffort && response.reasoningEffort !== reasoningEffort))
        throw new PanelError(409, "Codex istenen ayarı uygulamadı; önceki ayarlar korunuyor.");
      // The session may have been stopped while the RPC was in flight.
      const record = this._own(id);
      if (record.endedAt || this.runtimes.get(id) !== runtime)
        throw codedError("Oturum ayar değişikliği sırasında kapandı.", "SESSION_CLOSED_DURING_SETTINGS");
      const previous = {
        models: runtime.models,
        record: { ...record },
      };
      try {
        record.codexModeId = actualMode;
        record.codexModelId = response.model;
        record.codexReasoningEffort = response.reasoningEffort ?? null;
        record.lastError = null;
        this.store.save();
      } catch (error) {
        // save() may fail after the object changed. Restore the complete
        // snapshot before the outer error handler attempts to save lastError.
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, previous.record);
        throw error;
      }
      runtime.modeId = actualMode;
      runtime.models = { ...previous.models, currentModelId: response.model, currentReasoningEffort: response.reasoningEffort ?? null };
      runtime.lastError = null;
      return { ok: true };
    } catch (error) {
      // A failed/ambiguous RPC cannot leave a potentially changed live thread
      // available for prompts. The next connection explicitly restores the
      // last confirmed preferences, including sandbox and approval policy.
      runtime.intentional = true;
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      await this._closeRuntime(runtime).catch(() => {});
      try {
        const record = this._own(id);
        record.lastError = `Ayar uygulanamadı: ${error.message}`;
        this.store.save();
      } catch { /* A deleted session has no state to annotate. */ }
      throw error instanceof PanelError ? error : new PanelError(503, `Ayar uygulanamadı: ${error.message}`);
    } finally {
      runtime.settingsChanging = false;
      this._broadcastState(id);
    }
  }

  async setModel(id, modelId, reasoningEffort) {
    if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 300)
      throw new PanelError(400, "Geçersiz model seçimi.");
    this._own(id);
    const runtime = await this._ensureRuntime(id);
    this._assertIdle(runtime);
    const model = runtime.models.availableModels.find((entry) => entry.modelId === modelId);
    if (!model) throw new PanelError(400, "Bu model oturumun model listesinde bulunamadı.");
    const supported = model.supportedReasoningEfforts;
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || !supported.some((entry) => entry.reasoningEffort === reasoningEffort)))
      throw new PanelError(400, "Bu model seçilen düşünme düzeyini desteklemiyor.");
    const effort = reasoningEffort ?? (modelId === runtime.models.currentModelId ? runtime.models.currentReasoningEffort : model.defaultReasoningEffort);
    return this._applySettings(id, runtime, { modelId, reasoningEffort: effort });
  }

  async setMode(id, modeId) {
    if (!CODEX_MODES.some((mode) => mode.id === modeId))
      throw new PanelError(400, "Geçersiz erişim seçimi.");
    this._own(id);
    const runtime = await this._ensureRuntime(id);
    return this._applySettings(id, runtime, { modeId });
  }

  // ---- Termination --------------------------------------------------------

  async stop(id) {
    if (this.stopping.has(id)) return this.stopping.get(id);
    const work = this._stop(id);
    this.stopping.set(id, work);
    try {
      return await work;
    } finally {
      this.stopping.delete(id);
    }
  }

  async _stop(id) {
    const record = this._own(id);
    if (record.endedAt && !this.runtimes.has(id)) return this.withStatus(record);
    if (!record.endedAt) {
      const previous = record.endedAt;
      record.endedAt = new Date().toISOString();
      try {
        this.store.save();
      } catch (error) {
        record.endedAt = previous;
        throw error;
      }
    }
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.intentional = true;
      this.runtimes.delete(id);
      this._resolveAllPending(runtime);
      await this._closeRuntime(runtime).catch(() => {});
    }
    this._append(id, {
      kind: "status",
      status: "ended",
      detail: "Oturum panelden sonlandırıldı.",
    });
    this._broadcastState(id);
    return this.withStatus(record);
  }

  async delete(id) {
    await this.stop(id);
    this.store.remove(id);
    try {
      this.store.removeFiles(id);
    } catch {
      /* Removing files is best effort. */
    }
    this.emit("state", id, { id, status: "deleted" });
    return { ok: true };
  }

  readEvents(id, options) {
    this._own(id);
    return this.store.readEvents(id, options);
  }

  async shutdown() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map(async runtime => {
      runtime.intentional = true;
      this._resolveAllPending(runtime);
      await this._closeRuntime(runtime).catch(() => {});
    }));
  }

  // ---- app-server event handling ------------------------------------------

  _onNotification(id, runtime, method, params) {
    if (runtime.closed) return;
    switch (method) {
      case "thread/started": {
        const threadId = params?.thread?.id;
        if (threadId && !runtime.threadId) runtime.threadId = threadId;
        return;
      }
      case "thread/status/changed": {
        const type = params?.status?.type;
        if (type === "systemError") {
          runtime.lastError = "Codex oturumunda sistem hatası bildirildi.";
          this._broadcastState(id);
        }
        return;
      }
      case "thread/name/updated": {
        const name = params?.name;
        if (typeof name !== "string" || !name.trim() || name.length > 80) return;
        try {
          const record = this._own(id);
          if (record.title !== name) {
            record.title = name.trim();
            this.store.save();
          }
        } catch {
          /* Unknown session: nothing to retitle. */
        }
        this._append(id, { kind: "title", title: name.trim() });
        this._broadcastState(id);
        return;
      }
      case "turn/started": {
        if (params?.threadId !== runtime.threadId) return;
        const turnId = params?.turn?.id;
        if (typeof turnId === "string") runtime.currentTurnId = turnId;
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        return;
      }
      case "turn/completed": {
        if (params?.threadId !== runtime.threadId) return;
        const turn = params?.turn ?? {};
        runtime.inflight = Math.max(0, runtime.inflight - 1);
        runtime.currentTurnId = null;
        this._append(id, {
          kind: "turn",
          stopReason: turn.status === "completed" ? "end_turn" : String(turn.status ?? "end_turn"),
          usage: null,
        });
        if (turn.error?.message)
          this._append(id, { kind: "error", text: `Tur hatası: ${turn.error.message}` });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        return;
      }
      case "item/started": {
        if (params?.threadId !== runtime.threadId) return;
        this._onItemStarted(id, runtime, params?.item);
        return;
      }
      case "item/completed": {
        if (params?.threadId !== runtime.threadId) return;
        this._onItemCompleted(id, runtime, params?.item);
        return;
      }
      case "item/agentMessage/delta": {
        if (params?.threadId !== runtime.threadId) return;
        this._markDelta(runtime, params?.itemId);
        if (typeof params?.delta === "string" && params.delta)
          this._append(id, { kind: "assistant", id: params.itemId ?? null, text: params.delta });
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (params?.threadId !== runtime.threadId) return;
        this._markDelta(runtime, params?.itemId);
        if (typeof params?.delta === "string" && params.delta)
          this._append(id, { kind: "thought", id: params.itemId ?? null, text: params.delta });
        return;
      }
      case "item/commandExecution/outputDelta": {
        if (params?.threadId !== runtime.threadId) return;
        const state = runtime.items.get(params?.itemId);
        if (!state || typeof params?.delta !== "string") return;
        state.output = ((state.output ?? "") + params.delta).slice(-OUTPUT_CAP);
        this._queueOutputFlush(id, runtime, params.itemId);
        return;
      }
      case "turn/plan/updated": {
        if (params?.threadId !== runtime.threadId) return;
        const entries = (Array.isArray(params?.plan) ? params.plan : []).map((entry) => ({
          content: String(entry?.step ?? ""),
          status: String(entry?.status ?? ""),
        }));
        this._append(id, { kind: "plan", entries });
        return;
      }
      case "thread/tokenUsage/updated": {
        if (params?.threadId !== runtime.threadId) return;
        const usage = params?.tokenUsage ?? {};
        const used = Number(
          usage?.last?.totalTokens ?? usage?.last?.inputTokens ?? 0,
        );
        const size =
          typeof usage?.modelContextWindow === "number" ? usage.modelContextWindow : null;
        runtime.usage = { used, size };
        this._append(id, { kind: "usage", used, size });
        this._broadcastState(id);
        return;
      }
      default:
        return;
    }
  }

  _markDelta(runtime, itemId) {
    if (typeof itemId !== "string") return;
    const state = runtime.items.get(itemId);
    if (state) state.sawDelta = true;
  }

  _rememberItem(runtime, item) {
    if (!item || typeof item.id !== "string") return;
    const previous = runtime.items.get(item.id);
    if (previous) this._flushItemOutput(runtime.id, item.id, previous);
    runtime.items.set(item.id, {
      type: item.type,
      sawDelta: false,
      output: "",
      changes: Array.isArray(item.changes) ? item.changes : null,
      flushTimer: null,
    });
    if (runtime.items.size > ITEM_KEEP) {
      const oldest = runtime.items.keys().next().value;
      if (oldest !== undefined) {
        this._flushItemOutput(runtime.id, oldest, runtime.items.get(oldest));
        runtime.items.delete(oldest);
      }
    }
  }

  _queueOutputFlush(id, runtime, itemId) {
    const state = runtime.items.get(itemId);
    if (runtime.closed || !state || state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      this._flushItemOutput(id, itemId, state);
    }, FLUSH_MS);
    if (typeof state.flushTimer.unref === "function") state.flushTimer.unref();
  }

  _flushItemOutput(id, itemId, state) {
    if (!state?.flushTimer) return;
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    this._append(id, {
      kind: "tool",
      id: itemId,
      app: "update",
      patch: { content: [{ type: "content", content: { type: "text", text: state.output ?? "" } }] },
    });
  }

  _finishOutput(runtime) {
    runtime.closed = true;
    for (const [itemId, state] of runtime.items)
      this._flushItemOutput(runtime.id, itemId, state);
  }

  async _closeRuntime(runtime) {
    try {
      await runtime.conn?.close();
    } finally {
      this._finishOutput(runtime);
    }
  }

  _diffBlocks(changes) {
    const list = Array.isArray(changes) ? changes.slice(0, 20) : [];
    return list.map((change) => {
      const { oldText, newText } = parseUnifiedDiff(change?.diff ?? "");
      return {
        type: "diff",
        path: typeof change?.path === "string" ? change.path : "",
        oldText,
        newText,
      };
    });
  }

  _fileChangeTitle(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const paths = list
      .map((change) => (typeof change?.path === "string" ? change.path : ""))
      .filter(Boolean)
      .slice(0, 3);
    const suffix = list.length > 3 ? ` +${list.length - 3}` : "";
    return paths.length
      ? `Dosya değişiklikleri: ${paths.join(", ")}${suffix}`
      : `Dosya değişiklikleri (${list.length})`;
  }

  _onItemStarted(id, runtime, item) {
    if (!item || typeof item.id !== "string") return;
    this._rememberItem(runtime, item);
    switch (item.type) {
      case "commandExecution": {
        const status = COMMAND_STATUS[item.status] ?? item.status ?? null;
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "start",
          data: {
            title: item.command ?? "Komut",
            kind: "execute",
            status,
            content: [
              {
                type: "content",
                content: { type: "text", text: item.aggregatedOutput || "(komut çalışıyor…)" },
              },
            ],
          },
        });
        return;
      }
      case "fileChange": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "start",
          data: {
            title: this._fileChangeTitle(item.changes),
            kind: "edit",
            status: COMMAND_STATUS[item.status] ?? item.status ?? null,
            content: this._diffBlocks(item.changes),
          },
        });
        return;
      }
      case "mcpToolCall": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "start",
          data: {
            title: `${item.server ?? "MCP"} · ${item.tool ?? "araç"}`,
            kind: "other",
            status: COMMAND_STATUS[item.status] ?? item.status ?? null,
            content: null,
          },
        });
        return;
      }
      case "dynamicToolCall": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "start",
          data: {
            title: String(item.tool ?? "Araç"),
            kind: "other",
            status: COMMAND_STATUS[item.status] ?? item.status ?? null,
            content: null,
          },
        });
        return;
      }
      case "webSearch": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "start",
          data: {
            title: `Web araması: ${String(item.query ?? "").slice(0, 120)}`,
            kind: "search",
            status: null,
            content: null,
          },
        });
        return;
      }
      case "plan": {
        this._append(id, {
          kind: "plan",
          entries: [{ content: String(item.text ?? ""), status: "in_progress" }],
        });
        return;
      }
      // userMessage / hookPrompt / functionCallOutput / reasoning / agentMessage
      // start events carry nothing the transcript does not already have.
      default:
        return;
    }
  }

  _onItemCompleted(id, runtime, item) {
    if (!item || typeof item.id !== "string") return;
    const state = runtime.items.get(item.id) ?? { sawDelta: false, output: "" };
    switch (item.type) {
      case "commandExecution": {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        state.flushTimer = null;
        const status = COMMAND_STATUS[item.status] ?? item.status ?? null;
        const output = item.aggregatedOutput || state.output || "";
        const note =
          typeof item.exitCode === "number" && item.exitCode !== 0
            ? `\n[çıkış kodu ${item.exitCode}]`
            : "";
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "update",
          patch: {
            status,
            content: [
              {
                type: "content",
                content: { type: "text", text: `${output}${note}`.slice(0, OUTPUT_CAP) || "(çıktı yok)" },
              },
            ],
          },
        });
        return;
      }
      case "fileChange": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "update",
          patch: {
            status: COMMAND_STATUS[item.status] ?? item.status ?? null,
            content: this._diffBlocks(item.changes),
          },
        });
        return;
      }
      case "agentMessage": {
        if (!state.sawDelta && typeof item.text === "string" && item.text)
          this._append(id, { kind: "assistant", id: item.id, text: item.text });
        return;
      }
      case "reasoning": {
        if (!state.sawDelta) {
          const text = [
            ...(Array.isArray(item.summary) ? item.summary : []),
            ...(Array.isArray(item.content) ? item.content : []),
          ]
            .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
            .join("");
          if (text) this._append(id, { kind: "thought", id: item.id, text });
        }
        return;
      }
      case "mcpToolCall":
      case "dynamicToolCall": {
        this._append(id, {
          kind: "tool",
          id: item.id,
          app: "update",
          patch: { status: COMMAND_STATUS[item.status] ?? item.status ?? null },
        });
        return;
      }
      default:
        return;
    }
  }

  // Server-to-client requests: the approval bridge and user-input cards; the
  // flows the panel does not implement fail closed with a visible note.
  async _onRequest(id, runtime, method, params) {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    )
      return this._approvalRequest(id, runtime, method, params);
    if (method === "item/tool/requestUserInput")
      return this._userInputRequest(id, runtime, params);
    if (method === "item/permissions/requestApproval") {
      this._append(id, {
        kind: "status",
        status: "notice",
        detail: "Codex ek sistem izni istedi; panel bu isteği güvenli tarafta kalarak reddetti.",
      });
      throw new Error("Panel ek izin isteklerini onaylamaz.");
    }
    if (method === "item/tool/call") {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Panel istemci araçlarını çalıştırmaz." }],
      };
    }
    throw new Error(`Desteklenmeyen istek: ${method}`);
  }

  _approvalRequest(id, runtime, method, params) {
    const requestId = `c${++this.approvalSerial}-${crypto.randomUUID().slice(0, 8)}`;
    const item = runtime.items.get(params?.itemId) ?? null;
    const toolCall = {
      ...(typeof params?.itemId === "string" && params.itemId ? { toolCallId: params.itemId } : {}),
      title:
        typeof params?.reason === "string" && params.reason
          ? params.reason
          : method === "item/fileChange/requestApproval"
            ? "Dosya değişikliği izni"
            : "Komut çalıştırma izni",
      rawInput:
        method === "item/commandExecution/requestApproval" && typeof params?.command === "string"
          ? { command: params.command, cwd: params.cwd ?? null }
          : null,
    };
    if (method === "item/fileChange/requestApproval" && item?.changes?.length)
      toolCall.title = this._fileChangeTitle(item.changes);
    const options = APPROVAL_OPTIONS;
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const pending = { requestId, options, resolve: null, timer: null, kind: "decision", title: toolCall?.title ?? "", expiresAt };
    const stored = this._append(id, {
      kind: "approval",
      requestId,
      status: "requested",
      toolCall,
      options: [...options],
      expiresAt,
    });
    if (!stored) return { decision: "decline" };
    runtime.pendingApprovals.set(requestId, pending);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    return new Promise((resolve) => {
      pending.resolve = (value) => resolve(value);
      pending.timer = setTimeout(() => {
        if (!runtime.pendingApprovals.has(requestId)) return;
        runtime.pendingApprovals.delete(requestId);
        this._append(id, { kind: "approval", requestId, status: "expired" });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        resolve({ decision: "decline" });
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  _userInputRequest(id, runtime, params) {
    const source = Array.isArray(params?.questions) ? params.questions : [];
    if (source.length < 1 || source.length > 3 || source.some((question) =>
      !question || typeof question.id !== "string" || !question.id.trim() || question.id.length > 200 ||
      typeof question.question !== "string" || !question.question.trim() || question.question.length > 4000 ||
      (question.options != null && (!Array.isArray(question.options) || question.options.length > 8 || question.options.some((option) => !option || typeof option.label !== "string" || !option.label.trim() || option.label.length > 4000 || ["__deny", "__answer"].includes(option.label)) || new Set(question.options.map((option) => option.label)).size !== question.options.length))
    ) || new Set(source.map((question) => question.id)).size !== source.length)
      throw new PanelError(400, "Codex 1–3 geçerli ve benzersiz soru göndermeli.");
    const questions = source.map((question) => ({
      id: question.id,
      header: typeof question.header === "string" ? question.header.slice(0, 200) : "",
      question: question.question,
      options: (question.options ?? []).map((option) => ({ label: option.label, ...(typeof option.description === "string" ? { description: option.description.slice(0, 4000) } : {}) })),
      multiSelect: question.multiSelect === true,
      isSecret: question.isSecret === true,
      isOther: question.isOther === true,
    }));
    const requestId = `u${++this.approvalSerial}-${crypto.randomUUID().slice(0, 8)}`;
    const options = (questions.length === 1 ? questions[0].options : [])
      .map((choice) => ({
        optionId: choice.label,
        kind: "allow_once",
        name: choice.label,
      }));
    const toolCall = {
      title: questions.length === 1 ? questions[0].question : "Codex yanıtını bekliyor",
      rawInput: null,
    };
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const pending = {
      requestId,
      options,
      resolve: null,
      timer: null,
      kind: "userInput",
      questions,
      isQuestion: true,
      title: toolCall.title,
      expiresAt,
    };
    const stored = this._append(id, {
      kind: "approval",
      requestId,
      status: "requested",
      toolCall,
      options: [...options],
      questions,
      expiresAt,
    });
    if (!stored) return emptyQuestionAnswers(questions);
    runtime.pendingApprovals.set(requestId, pending);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    return new Promise((resolve) => {
      pending.resolve = (value) => resolve(value);
      pending.timer = setTimeout(() => {
        if (!runtime.pendingApprovals.has(requestId)) return;
        runtime.pendingApprovals.delete(requestId);
        this._append(id, { kind: "approval", requestId, status: "expired" });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        resolve(emptyQuestionAnswers(questions));
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  _onExit(id, runtime) {
    if (runtime.intentional) return;
    this._finishOutput(runtime);
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    this._resolveAllPending(runtime);
    let record = null;
    try {
      record = this._own(id);
    } catch {
      /* Unknown session. */
    }
    if (record && !record.endedAt) {
      this._append(id, {
        kind: "status",
        status: "offline",
        detail:
          "Codex süreci kapandı; oturum yeniden bağlanınca kaydından geri yüklenecek.",
      });
    }
    this._broadcastState(id);
  }

  _resolveAllPending(runtime) {
    for (const [requestId, pending] of runtime.pendingApprovals) {
      clearTimeout(pending.timer);
      this._append(runtime.id, { kind: "approval", requestId, status: "expired" });
      pending.resolve(
        pending.kind === "userInput"
          ? emptyQuestionAnswers(pending.questions)
          : { decision: "decline" },
      );
    }
    runtime.pendingApprovals.clear();
  }

  _syncRuntimeStatus(runtime) {
    if (runtime.logFailed) runtime.status = "offline";
    else if (runtime.pendingApprovals.size) runtime.status = "attention";
    else if (runtime.inflight > 0) runtime.status = "running";
    else runtime.status = "idle";
  }

  _append(id, event, required = false) {
    let stored;
    try {
      stored = this.store.appendEvent(id, event);
    } catch (error) {
      console.error("codex event append failed:", error.message);
      // Stop accepting unrecorded output and expose the failure through the
      // existing offline state. Do not try to log a disk error to the same log.
      const message = error instanceof PanelError && error.status === 503
        ? error.message
        : "Sohbet günlüğü yazılamadı; bağlantı kapatıldı. Yeniden bağlanmayı dene.";
      const runtime = this.runtimes.get(id);
      if (runtime) {
        runtime.lastError = message;
        runtime.status = "offline";
        if (!runtime.logFailed) {
          runtime.logFailed = true;
          void runtime.conn?.close().catch(() => {});
        }
      }
      if (this.store.has(id)) this.store.get(id).lastError = message;
      this._broadcastState(id);
      if (required) throw new PanelError(503, message);
      return null;
    }
    this.emit("event", id, stored);
    return stored;
  }
}
