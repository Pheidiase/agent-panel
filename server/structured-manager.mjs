// Structured (ACP) session lifecycle for the panel.
//
// One `hermes acp` child process per structured session: started lazily on
// open/first use, kept alive while the panel runs, killed on Stop/Delete.
// The web service restarting loses the child (the turn in flight with it) but
// the conversation restores from the agent's own state.db via `session/load`,
// so a closed or restarted panel resumes where it left off. tmux sessions are
// a separate store and are never touched by this manager.
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  StructuredStore,
  STRUCTURED_RECORD_LIMIT,
} from "./structured-store.mjs";
import { AcpConnection } from "./acp-client.mjs";
import { codedError } from "./error-codes.mjs";
import { PanelError } from "./session-store.mjs";
import { loadAgentBinaries } from "./config.mjs";
import { PANEL_VERSION } from "./version.mjs";
import { attentionOf } from "./attention.mjs";

// Resolves the panel-owned `hermes acp` command: an explicit test/override
// binary wins, otherwise the same agents.json entry the terminal sessions use.
export function resolveAcpCommand({ stateDir, env = process.env }) {
  const command = loadAgentBinaries({ stateDir, env }).hermes;
  return command ? { command, args: ["acp"] } : null;
}

export const STRUCTURED_RUNNING_LIMIT = 4;
export const APPROVAL_TIMEOUT_MS = 300_000; // = Hermes approvals.timeout default
export const PROMPT_MAX_CHARS = 8000;
const INIT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 90_000;
const LOAD_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 30_000;
const REPLAY_BUFFER_LIMIT = 20_000;
const ECHO_KEEP = 16;
const CONTENT_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

// Hermes answers `{}` (all fields excluded) when no persisted record exists
// for an ACP session id; a real record always carries at least `modes`.
function isRestorable(response) {
  return (
    !!response &&
    typeof response === "object" &&
    Object.keys(response).length > 0
  );
}

export class StructuredManager extends EventEmitter {
  constructor({ root, stateDir, agentCommand, projects, env, store }) {
    super();
    this.root = root;
    this.stateDir = stateDir;
    this.agentCommand = agentCommand || null; // { command, args } | null
    this.projects = projects;
    this.env = env;
    // The store may be shared with the Codex and Claude managers so every tier
    // keeps one record list; ownership is decided by each record's agentId.
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

  list() {
    return this.store
      .list()
      .filter((record) => (record.agentId ?? "hermes") === "hermes")
      .map((record) => this.withStatus(record));
  }

  get(id) {
    return this.withStatus(this._own(id));
  }

  // This manager owns every record whose agent is Hermes (legacy rows carry
  // no agentId); Codex and Claude rows belong to their own managers.
  _own(id) {
    const record = this.store.get(id);
    if ((record.agentId ?? "hermes") !== "hermes")
      throw new PanelError(404, "Oturum bulunamadı.");
    return record;
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
      model: runtime?.models?.currentModelId ?? null,
      modes: runtime?.modes ?? null,
      usage: runtime?.usage ?? null,
      settingsChanging: runtime?.settingsChanging === true,
      pendingApprovalCount: runtime ? runtime.pendingApprovals.size : 0,
      lastError: runtime?.lastError ?? record.lastError ?? null,
    };
  }

  // Full payload for viewers opening a session: compact state plus the model
  // catalogue (sent once on connect instead of on every state event).
  async sessionInfo(id) {
    const record = this.store.get(id);
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
        throw new PanelError(503, "Hermes yapılandırılmış mod şu an kullanılamıyor.");
      if (agentId !== "hermes")
        throw new PanelError(400, "Yapılandırılmış oturumlar yalnız Hermes ile açılır.");
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))
        throw new PanelError(400, "Geçersiz işlem kimliği.");
      const previous = this.store.findByIdempotencyKey(requestId);
      if (previous && (previous.agentId ?? "hermes") === "hermes")
        return this.withStatus(previous);
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
      if (live >= STRUCTURED_RUNNING_LIMIT)
        throw new PanelError(
          409,
          `Aynı anda en fazla ${STRUCTURED_RUNNING_LIMIT} sohbet bağlı olabilir.`,
        );
      const id = crypto.randomUUID();
      const runtime = this._startSession({
        id,
        cwd: project.path,
        resumeSessionId: null,
      });
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
        acpSessionId: runtime.acpSessionId,
        projectId,
        agentId: "hermes",
        title: title.trim() || `Hermes · ${project.name}`,
        createdAt: new Date().toISOString(),
        requestId,
        endedAt: null,
        lastOpenedAt: null,
        archived: false,
        pinned: false,
        lastError: null,
      };
      try {
        this.store.add(record);
      } catch (error) {
        runtime.intentional = true;
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        this._resolveAllPending(runtime);
        await runtime.conn?.close().catch(() => {});
        throw error;
      }
      this._broadcastState(id);
      return this.withStatus(record);
    });
  }

  // ---- Connection lifecycle ----------------------------------------------

  _startSession({ id, cwd, resumeSessionId }) {
    this.store.assertRunningCapacity(id);
    const runtime = {
      id,
      conn: null,
      status: "starting",
      starting: null,
      replaying: false,
      replayBuffer: [],
      models: null,
      modes: null,
      usage: null,
      inflight: 0,
      settingsChanging: false,
      acpSessionId: resumeSessionId,
      pendingApprovals: new Map(),
      userEchoes: [],
      intentional: false,
      lastError: null,
    };
    const connection = new AcpConnection({
      command: this.agentCommand.command,
      args: this.agentCommand.args,
      cwd,
      env: this.env,
      stderrPath: this.store.stderrPath(id),
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
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "agent-panel", version: PANEL_VERSION },
        },
        { timeoutMs: INIT_TIMEOUT_MS },
      );
      let response;
      let reopened = false;
      if (runtime.acpSessionId) {
        runtime.status = "resuming";
        this._broadcastState(id);
        runtime.replaying = true;
        response = await connection.request(
          "session/load",
          { cwd, sessionId: runtime.acpSessionId, mcpServers: [] },
          { timeoutMs: LOAD_TIMEOUT_MS },
        );
        runtime.replaying = false;
        if (!isRestorable(response)) {
          // No persisted row for this id (a chat without real history stays
          // ephemeral in Hermes). Before restarting it, ask the agent's own
          // session list whether the record exists at all — a list conflict
          // means a load failure, not an ephemeral session.
          const exists = await this._sessionExists(
            connection,
            runtime.acpSessionId,
            cwd,
          );
          if (exists !== false)
            throw new Error(
              "Hermes oturum kaydı yüklenemedi; yeniden bağlanmayı dene.",
            );
          const fresh = await connection.request(
            "session/new",
            { cwd, mcpServers: [] },
            { timeoutMs: START_TIMEOUT_MS },
          );
          runtime.acpSessionId = fresh?.sessionId ?? null;
          if (!runtime.acpSessionId) throw codedError("Oturum kimliği alınamadı.", "ACP_SESSION_ID_MISSING");
          response = fresh;
          reopened = true;
          try {
            const record = this.store.get(id);
            record.acpSessionId = runtime.acpSessionId;
            this.store.save();
          } catch {
            /* Creation path. */
          }
          this._append(id, {
            kind: "status",
            status: "reopened",
            detail:
              "Önceki Hermes kaydı bulunamadı; sohbet yeni bir oturumla sürdürülüyor.",
          });
        }
      } else {
        response = await connection.request(
          "session/new",
          { cwd, mcpServers: [] },
          { timeoutMs: START_TIMEOUT_MS },
        );
        runtime.acpSessionId = response?.sessionId ?? null;
        if (!runtime.acpSessionId) throw codedError("Oturum kimliği alınamadı.", "ACP_SESSION_ID_MISSING");
      }
      runtime.models = response?.models ?? null;
      runtime.modes = response?.modes ?? null;
      // History replay: it rebuilds the transcript only when the panel has no
      // stored events for this session; otherwise the stored log stays
      // canonical and only non-content updates (usage/commands/mode) apply.
      if (resumeSessionId && runtime.replayBuffer.length) {
        const { events } = this.store.readEvents(id, {});
        const rebuild = events.length === 0;
        for (const params of runtime.replayBuffer) {
          const update = params?.update;
          if (!update || typeof update !== "object") continue;
          if (rebuild || !CONTENT_UPDATES.has(update.sessionUpdate))
            this._applyUpdate(id, runtime, update, { replay: true });
        }
      }
      runtime.replayBuffer = [];
      if (resumeSessionId && !reopened) {
        // A previous set_mode may have applied despite a lost response.
        const modeId = this._own(id).hermesModeId || "default";
        await connection.request("session/set_mode", { sessionId: runtime.acpSessionId, modeId }, { timeoutMs: MODEL_TIMEOUT_MS });
        if (runtime.modes) runtime.modes = { ...runtime.modes, currentModeId: modeId };
      }
      runtime.status = "idle";
      runtime.lastError = null;
      try {
        const record = this.store.get(id);
        if (record.lastError) {
          record.lastError = null;
          this.store.save();
        }
      } catch {
        /* Creation path: the record lands right after. */
      }
      if (resumeSessionId && !reopened)
        this._append(id, {
          kind: "status",
          status: "resumed",
          detail: "Oturum Hermes kaydından geri yüklendi.",
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
        runtime.conn?.close().catch(() => {});
        try {
          const record = this.store.get(id);
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

  // true/false from the agent's own list; null when the check failed or is incomplete
  // (the caller then fails the resume instead of silently starting fresh).
  async _sessionExists(connection, sessionId, cwd) {
    try {
      let cursor = null;
      for (let page = 0; page < 3; page++) {
        const result = await connection.request(
          "session/list",
          cursor ? { cursor, cwd } : { cwd },
          { timeoutMs: 15000 },
        );
        const sessions = result?.sessions ?? [];
        if (sessions.some((session) => session.sessionId === sessionId))
          return true;
        cursor = result?.nextCursor ?? null;
        if (!cursor) return false;
      }
      return null; // More pages remain: absence has not been established.
    } catch {
      return null;
    }
  }

  async _ensureRuntime(id) {
    const record = this._own(id);
    if (record.endedAt)
      throw new PanelError(
        409,
        "Bu oturum sonlandırılmış. Yeni bir sohbet açabilirsin.",
      );
    if (!this.available)
      throw new PanelError(503, "Hermes yapılandırılmış mod şu an kullanılamıyor.");
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
    if (live >= STRUCTURED_RUNNING_LIMIT)
      throw new PanelError(
        409,
        `Aynı anda en fazla ${STRUCTURED_RUNNING_LIMIT} sohbet bağlı olabilir. Bir sohbeti sonlandırıp tekrar dene.`,
      );
    const project = this.project(record.projectId);
    if (!project) throw new PanelError(400, "Oturumun projesi bulunamadı.");
    runtime = this._startSession({
      id,
      cwd: project.path,
      resumeSessionId: record.acpSessionId,
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
        const record = this.store.get(id);
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
    const record = this.store.get(id);
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
    this._append(id, { kind: "user", text }, true);
    // The adapter echoes a queued prompt back as a user_message_chunk when it
    // eventually runs; remember what this panel already logged so the echo
    // does not duplicate the transcript.
    runtime.userEchoes.push(text);
    if (runtime.userEchoes.length > ECHO_KEEP) runtime.userEchoes.shift();
    runtime.inflight += 1;
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    runtime.conn
      .request("session/prompt", {
        sessionId: record.acpSessionId,
        prompt: [{ type: "text", text }],
      })
      .then((response) => {
        runtime.inflight = Math.max(0, runtime.inflight - 1);
        this._append(id, {
          kind: "turn",
          stopReason: response?.stopReason ?? "end_turn",
          usage: response?.usage ?? null,
        });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
      })
      .catch((error) => {
        runtime.inflight = Math.max(0, runtime.inflight - 1);
        this._append(id, {
          kind: "error",
          text: `Tur tamamlanamadı: ${error.message}`,
        });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
      });
    return { delivered: true };
  }

  async cancel(id) {
    const record = this.store.get(id);
    const runtime = this.runtimes.get(id);
    if (!runtime?.conn?.alive) return { cancelled: false };
    try {
      runtime.conn.notify("session/cancel", { sessionId: record.acpSessionId });
    } catch {
      return { cancelled: false };
    }
    return { cancelled: true };
  }

  async approve(id, requestId, optionId) {
    const runtime = this.runtimes.get(id);
    if (!runtime)
      throw new PanelError(409, "Onay isteği artık geçerli değil.");
    const pending = runtime.pendingApprovals.get(requestId);
    if (!pending)
      throw new PanelError(409, "Onay isteği bulunamadı veya süresi geçti.");
    if (!pending.options.some((option) => option.optionId === optionId))
      throw new PanelError(400, "Geçersiz onay seçimi.");
    clearTimeout(pending.timer);
    runtime.pendingApprovals.delete(requestId);
    this._append(id, { kind: "approval", requestId, status: "decided", optionId });
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    pending.resolve({ outcome: "selected", optionId });
    return { ok: true };
  }

  _assertIdle(runtime) {
    if (runtime.inflight > 0 || runtime.pendingApprovals.size > 0 || runtime.settingsChanging)
      throw new PanelError(409, "Yanıtın, onayın veya ayar değişikliğinin bitmesini bekle ya da durdur.");
  }

  async setModel(id, modelId) {
    if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 300)
      throw new PanelError(400, "Geçersiz model seçimi.");
    this._own(id);
    const runtime = await this._ensureRuntime(id);
    this._assertIdle(runtime);
    runtime.settingsChanging = true;
    this._broadcastState(id);
    try {
      await runtime.conn.request("session/set_model", { sessionId: runtime.acpSessionId, modelId }, { timeoutMs: MODEL_TIMEOUT_MS });
      if (runtime.models) runtime.models = { ...runtime.models, currentModelId: modelId };
      return { ok: true };
    } finally {
      runtime.settingsChanging = false;
      this._broadcastState(id);
    }
  }

  async setMode(id, modeId) {
    if (typeof modeId !== "string" || !modeId.trim() || modeId.length > 100)
      throw new PanelError(400, "Geçersiz mod seçimi.");
    this._own(id);
    const runtime = await this._ensureRuntime(id);
    this._assertIdle(runtime);
    runtime.settingsChanging = true;
    this._broadcastState(id);
    try {
      await runtime.conn.request("session/set_mode", { sessionId: runtime.acpSessionId, modeId }, { timeoutMs: MODEL_TIMEOUT_MS });
      this._readyRuntime(id, runtime);
      const record = this._own(id), previous = record.hermesModeId;
      record.hermesModeId = modeId;
      try { this.store.save(); } catch (error) { record.hermesModeId = previous; throw error; }
      if (runtime.modes) runtime.modes = { ...runtime.modes, currentModeId: modeId };
      return { ok: true };
    } catch (error) {
      runtime.intentional = true;
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      this._resolveAllPending(runtime);
      await runtime.conn?.close().catch(() => {});
      throw error;
    } finally {
      runtime.settingsChanging = false;
      this._broadcastState(id);
    }
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
    const record = this.store.get(id);
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
      await runtime.conn?.close().catch(() => {});
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
    this.store.get(id);
    return this.store.readEvents(id, options);
  }

  async shutdown() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map(async runtime => {
      runtime.intentional = true;
      this._resolveAllPending(runtime);
      await runtime.conn?.close().catch(() => {});
    }));
  }

  // ---- ACP event handling -------------------------------------------------

  _onNotification(id, runtime, method, params) {
    if (method !== "session/update") return;
    const update = params?.update;
    if (!update || typeof update !== "object") return;
    // An update for a different session must never touch this transcript.
    if (params?.sessionId && runtime.acpSessionId && params.sessionId !== runtime.acpSessionId)
      return;
    if (runtime.replaying) {
      if (runtime.replayBuffer.length < REPLAY_BUFFER_LIMIT)
        runtime.replayBuffer.push(params);
      return;
    }
    this._applyUpdate(id, runtime, update);
  }

  _applyUpdate(id, runtime, update, { replay = false } = {}) {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const text = update.content?.text ?? "";
        if (!text) return;
        if (!replay) {
          const echo = runtime.userEchoes.indexOf(text);
          if (echo >= 0) {
            runtime.userEchoes.splice(0, echo + 1);
            return; // Already logged when the panel sent it.
          }
        }
        this._append(id, { kind: "user", text });
        return;
      }
      case "agent_message_chunk":
        this._append(id, {
          kind: "assistant",
          id: update.messageId ?? null,
          text: update.content?.text ?? "",
        });
        return;
      case "agent_thought_chunk":
        this._append(id, {
          kind: "thought",
          id: update.messageId ?? null,
          text: update.content?.text ?? "",
        });
        return;
      case "tool_call":
        this._append(id, {
          kind: "tool",
          id: update.toolCallId,
          app: "start",
          data: {
            title: update.title ?? "",
            kind: update.kind ?? null,
            status: update.status ?? null,
            content: update.content ?? null,
            rawInput: update.rawInput ?? null,
            locations: update.locations ?? null,
          },
        });
        return;
      case "tool_call_update": {
        const patch = {};
        for (const key of [
          "title",
          "kind",
          "status",
          "content",
          "rawInput",
          "rawOutput",
          "locations",
        ])
          if (key in update) patch[key] = update[key];
        this._append(id, { kind: "tool", id: update.toolCallId, app: "update", patch });
        return;
      }
      case "plan":
        this._append(id, { kind: "plan", entries: update.entries ?? [] });
        return;
      case "usage_update":
        runtime.usage = { used: update.used, size: update.size };
        this._append(id, { kind: "usage", used: update.used, size: update.size });
        this._broadcastState(id);
        return;
      case "available_commands_update":
        this._append(id, {
          kind: "commands",
          commands: (update.availableCommands ?? []).map((command) => ({
            name: command.name,
            description: command.description,
            hint: command.input?.hint ?? null,
          })),
        });
        return;
      case "session_info_update": {
        const title = update.title;
        if (typeof title === "string" && title.trim()) {
          try {
            const record = this.store.get(id);
            if (record.title !== title) {
              record.title = title;
              this.store.save();
            }
          } catch {
            /* Unknown session: nothing to retitle. */
          }
          this._append(id, { kind: "title", title });
          this._broadcastState(id);
        }
        return;
      }
      case "current_mode_update":
        if (runtime.modes)
          runtime.modes = { ...runtime.modes, currentModeId: update.currentModeId };
        this._append(id, { kind: "mode", currentModeId: update.currentModeId });
        this._broadcastState(id);
        return;
      case "config_option_update":
        this._append(id, {
          kind: "config",
          configOptions: update.configOptions ?? [],
        });
        return;
      default:
        return;
    }
  }

  async _onRequest(id, runtime, method, params) {
    if (method !== "session/request_permission")
      throw new Error(`Desteklenmeyen istek: ${method}`);
    const requestId = `a${++this.approvalSerial}-${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const options = (params?.options ?? []).map((option) => ({
      optionId: option.optionId,
      kind: option.kind,
      name: option.name,
    }));
    const toolCall = params?.toolCall ?? null;
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const pending = { requestId, options, toolCall, title: toolCall?.title ?? "", expiresAt, resolve: null, timer: null };
    const stored = this._append(id, {
      kind: "approval",
      requestId,
      status: "requested",
      toolCall,
      options,
      expiresAt,
    });
    if (!stored) return { outcome: { outcome: "cancelled" } };
    runtime.pendingApprovals.set(requestId, pending);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    return new Promise((resolve) => {
      pending.resolve = (outcome) => resolve({ outcome });
      pending.timer = setTimeout(() => {
        if (!runtime.pendingApprovals.has(requestId)) return;
        runtime.pendingApprovals.delete(requestId);
        this._append(id, { kind: "approval", requestId, status: "expired" });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        resolve({ outcome: { outcome: "cancelled" } });
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  _onExit(id, runtime) {
    if (runtime.intentional) return;
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    this._resolveAllPending(runtime);
    let record = null;
    try {
      record = this.store.get(id);
    } catch {
      /* Unknown session. */
    }
    if (record && !record.endedAt) {
      this._append(id, {
        kind: "status",
        status: "offline",
        detail:
          "Agent süreci kapandı; oturum yeniden bağlanınca Hermes kaydından geri yüklenecek.",
      });
    }
    this._broadcastState(id);
  }

  _resolveAllPending(runtime) {
    for (const [requestId, pending] of runtime.pendingApprovals) {
      clearTimeout(pending.timer);
      this._append(runtime.id, { kind: "approval", requestId, status: "expired" });
      pending.resolve({ outcome: "cancelled" });
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
      console.error("structured event append failed:", error.message);
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
