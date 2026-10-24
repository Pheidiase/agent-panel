// Claude Code structured (stream-json) session lifecycle for the panel.
//
// One `claude` child per structured session, mirroring the ACP and Codex
// tiers: started lazily on open/first use, kept alive while the panel runs,
// killed on Stop/Delete. The child runs headless with
// `--input-format stream-json --output-format stream-json --verbose
// --include-partial-messages --permission-prompt-tool stdio`: one JSON message
// per line in both directions. The panel writes user messages and control
// requests (initialize, interrupt, set_model, set_permission_mode); the child
// streams system/assistant/user/result messages and asks for tool permission
// with `can_use_tool` control requests, which become the panel's approval
// cards. The panel picks the Claude session id at creation (`--session-id`)
// and reopens it with `--resume`, so a closed or restarted panel continues
// from Claude's own transcript. Bypass is available only through an explicit
// per-chat mode selection; user settings, hooks and CLAUDE.md load as usual.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { LineReader } from "./line-reader.mjs";
import { codedError } from "./error-codes.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StructuredStore, STRUCTURED_RECORD_LIMIT } from "./structured-store.mjs";
import { PanelError } from "./session-store.mjs";
import { loadAgentBinaries } from "./config.mjs";
import { attentionOf } from "./attention.mjs";

// Resolves the panel-owned headless Claude command: an explicit test
// override wins, otherwise the same agents.json entry the terminal sessions
// use. The protocol flags always ride in argv so a bare `claude` (which opens
// the interactive TUI) can never be spawned on a pipe by mistake.
export const CLAUDE_STREAM_ARGS = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
];

export function resolveClaudeCommand({ stateDir, env = process.env }) {
  const command = loadAgentBinaries({ stateDir, env }).claude;
  return command ? { command, args: [...CLAUDE_STREAM_ARGS] } : null;
}

// Environment for a Claude child: service controls and a parent Claude Code
// session's identity must not leak in (a nested-session marker would make the
// child refuse to start or report the wrong entrypoint).
export function claudeChildEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out))
    if (
      key.startsWith("PANEL_") ||
      key.startsWith("HERMES_SUPERVISED") ||
      [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SSE_PORT",
        "TMUX",
        "TMUX_PANE",
        "NOTIFY_SOCKET",
        "INVOCATION_ID",
        "JOURNAL_STREAM",
      ].includes(key)
    )
      delete out[key];
  return out;
}

export const CLAUDE_RUNNING_LIMIT = 4;
export const APPROVAL_TIMEOUT_MS = 300_000;
export const PROMPT_MAX_CHARS = 8000;
const INIT_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 15_000;
const INTERRUPT_SETTLE_MS = 8_000;
const OUTPUT_CAP = 12_000;
const DIFF_CHAR_CAP = 40_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_ERRORS = 25;
const STDERR_LIMIT = 1024 * 1024;
const STDERR_KEEP = 256 * 1024;
const STDERR_TAIL = 4096;
const TOOL_KEEP = 300;
const QUESTION_LIMIT = 3;
const QUESTION_ANSWER_LIMIT = 4000;

function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > QUESTION_LIMIT) return null;
  const seen = new Set();
  const result = [];
  for (const [index, question] of input.entries()) {
    if (!question || typeof question.question !== "string" || !question.question.trim() ||
        question.question.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(question.question) || seen.has(question.question)) return null;
    seen.add(question.question);
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.length > 8) return null;
    const labels = new Set();
    const normalized = [];
    for (const choice of options) {
      if (!choice || typeof choice.label !== "string" || !choice.label.trim() || choice.label.length > 160 ||
          /[\x00-\x1f\x7f]/.test(choice.label) || ["__answer", "__deny"].includes(choice.label) || labels.has(choice.label)) return null;
      labels.add(choice.label);
      normalized.push({ label: choice.label, description: clip(choice.description, 800) });
    }
    result.push({ id: `q${index + 1}`, header: clip(question.header, 80), question: question.question,
      options: normalized, multiSelect: question.multiSelect === true, isSecret: question.isSecret === true, isOther: true });
  }
  return result;
}

function questionAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
      Object.keys(answers).length !== questions.length || Object.keys(answers).some((id) => !questions.some((q) => q.id === id)))
    throw new PanelError(400, "Tüm soruları yanıtla.");
  return Object.fromEntries(questions.map((question) => {
    const value = answers[question.id];
    const values = Array.isArray(value) ? value : [value];
    if ((!question.multiSelect && Array.isArray(value)) || values.length < 1 || values.length > 8 ||
        values.some((part) => typeof part !== "string" || !part.trim() || part.length > QUESTION_ANSWER_LIMIT || /[\x00-\x08\x0b-\x1f\x7f]/.test(part)) ||
        new Set(values).size !== values.length || values.join(", ").length > QUESTION_ANSWER_LIMIT)
      throw new PanelError(400, "Her soruya geçerli bir yanıt ver (en fazla 4000 karakter).");
    return [question.question, values.join(", ")];
  }));
}

// The panel starts in default mode regardless of the user's CLI settings.
// Full access is an explicit per-chat choice, persisted only after Claude
// acknowledges the mode change; it never edits the user's Claude settings.
export const CLAUDE_MODES = [
  { id: "default", name: "Varsayılan", description: "Her riskli araç için onay ister." },
  { id: "acceptEdits", name: "Düzenlemeleri kabul et", description: "Dosya düzenlemeleri onaysız uygulanır." },
  { id: "plan", name: "Plan", description: "Yalnız inceler ve plan önerir; değişiklik yapmaz." },
  { id: "bypassPermissions", name: "Tam erişim", description: "Bu sohbette araç izin kontrollerini atlar; komutlar ve dosya değişiklikleri onaysız çalışır." },
];

const APPROVAL_OPTIONS = [
  { optionId: "allow", kind: "allow_once", name: "Onayla (bir kez)" },
  { optionId: "allowSession", kind: "allow_always", name: "Oturum boyunca onayla" },
  { optionId: "deny", kind: "reject_once", name: "Reddet" },
  { optionId: "denyStop", kind: "reject_always", name: "Reddet ve durdur" },
];

const TOOL_KIND = {
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebSearch: "search",
  WebFetch: "fetch",
};

function clip(text, cap) {
  const value = typeof text === "string" ? text : "";
  return value.length > cap ? value.slice(0, cap) + "…" : value;
}

function short(value, cap = 160) {
  return clip(String(value ?? "").replace(/\s+/g, " ").trim(), cap);
}

// Tool card title for a Claude tool_use block, from its well-known inputs.
export function claudeToolTitle(name, input) {
  const value = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Bash":
      return short(value.description || value.command || "Komut");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `${name}: ${short(value.file_path || value.notebook_path || "")}`;
    case "Grep":
      return `Ara: ${short(value.pattern)}`;
    case "Glob":
      return `Dosya bul: ${short(value.pattern)}`;
    case "WebSearch":
      return `Web araması: ${short(value.query, 120)}`;
    case "WebFetch":
      return `Web: ${short(value.url, 160)}`;
    case "Task":
    case "Agent":
      return `Alt ajan: ${short(value.description || value.subagent_type || "")}`;
    case "TodoWrite":
      return "Görev listesi";
    default:
      return String(name || "Araç");
  }
}

// Diff blocks for the edit tools, in the panel's {path, oldText, newText}
// shape that the changes panel folds per file.
export function claudeToolDiffs(name, input) {
  const value = input && typeof input === "object" ? input : {};
  const file = typeof value.file_path === "string" ? value.file_path : "";
  if (name === "Edit")
    return [
      {
        type: "diff",
        path: file,
        oldText: clip(value.old_string, DIFF_CHAR_CAP),
        newText: clip(value.new_string, DIFF_CHAR_CAP),
      },
    ];
  if (name === "Write")
    return [{ type: "diff", path: file, oldText: "", newText: clip(value.content, DIFF_CHAR_CAP) }];
  if (name === "MultiEdit" && Array.isArray(value.edits))
    return value.edits.slice(0, 20).map((edit) => ({
      type: "diff",
      path: file,
      oldText: clip(edit?.old_string, DIFF_CHAR_CAP),
      newText: clip(edit?.new_string, DIFF_CHAR_CAP),
    }));
  return null;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : part?.type === "image"
          ? "[görsel]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

// Line-delimited stream-json transport with the stdio control protocol:
// outgoing control requests are matched to their control_response by
// request_id; incoming control requests go to `onControl`, whose result (or
// error) is written back as the control_response.
export class ClaudeConnection extends EventEmitter {
  constructor({ command, args = [], cwd, env, stderrPath = null }) {
    super();
    Object.assign(this, { command, args, cwd, env, stderrPath });
    this.child = null;
    this.pending = new Map();
    this.serial = 0;
    this.lineReader = new LineReader(MAX_LINE_BYTES);
    this.protocolErrors = 0;
    this.stderrTail = "";
    this._terminated = false;
    this.onMessage = null;
    this.onControl = null;
    this.onControlCancel = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this._terminated;
  }

  start() {
    if (this.child) throw codedError("Claude bağlantısı zaten başlatıldı.", "CLAUDE_ALREADY_STARTED");
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this._onStderr(chunk));
    this.child.stdin.on("error", () => {
      // EPIPE after an unexpected child exit is reported through `exit`.
    });
    this.child.on("error", (error) => {
      this._fail(codedError(`Claude süreci başlatılamadı: ${error.message}`, "AGENT_START_FAILED"));
    });
    // `close` (not `exit`) so the stderr tail that explains a startup failure
    // has been read when the error is reported.
    this.child.on("close", (code, signal) => {
      const tail = this.stderrTail.trim().split("\n").pop()?.slice(0, 300) || "";
      this._fail(
        new Error(
          `Claude süreci kapandı (kod ${code ?? "?"}${signal ? ", " + signal : ""})${
            tail ? `: ${tail}` : ""
          }`,
        ),
      );
      this.emit("exit", { code, signal });
    });
    return this;
  }

  control(request, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    if (!this.alive) return Promise.reject(codedError("Claude bağlantısı kapalı.", "CLAUDE_CONNECTION_CLOSED"));
    const requestId = `panel-${++this.serial}-${crypto.randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, subtype: request.subtype, timer: null };
      if (timeoutMs > 0)
        entry.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(codedError(`${request.subtype} zaman aşımına uğradı.`, "CLAUDE_CONTROL_TIMEOUT"));
        }, timeoutMs);
      this.pending.set(requestId, entry);
      try {
        this.write({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  write(message) {
    if (!this.alive) throw codedError("Claude bağlantısı kapalı.", "CLAUDE_CONNECTION_CLOSED");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  _tryWrite(message) {
    try {
      this.write(message);
    } catch {
      /* The connection is gone; the exit handler reports it. */
    }
  }

  _onStdout(chunk) {
    if (this._terminated) return;
    const withinLimit = this.lineReader.push(chunk, (line) => {
      this._handleLine(line);
      return !this._terminated;
    });
    if (!withinLimit) {
      this._fail(codedError("Claude akışı sınırı aştı (satır çok uzun).", "CLAUDE_STREAM_TOO_LONG"));
      this._kill();
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      this.protocolErrors += 1;
      if (this.protocolErrors >= MAX_PROTOCOL_ERRORS) {
        this._fail(codedError("Claude akışı bozuldu (geçersiz JSON).", "CLAUDE_STREAM_INVALID_JSON"));
        this._kill();
      }
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "control_response") {
      const response = message.response ?? {};
      const entry = this.pending.get(response.request_id);
      if (!entry) return;
      this.pending.delete(response.request_id);
      if (entry.timer) clearTimeout(entry.timer);
      if (response.subtype === "error")
        entry.reject(new Error(`${entry.subtype}: ${response.error || "bilinmeyen hata"}`));
      else entry.resolve(response.response ?? {});
      return;
    }
    if (message.type === "control_request") {
      const requestId = message.request_id;
      const handler = this.onControl;
      // The executor catches synchronous errors while registering permissions
      // before a following control_cancel_request in the same stdout chunk.
      new Promise((resolve, reject) => {
        if (!handler) return reject(codedError("Desteklenmeyen kontrol isteği.", "CLAUDE_CONTROL_UNSUPPORTED"));
        resolve(handler(message.request ?? {}, requestId));
      })
        .then((response) =>
          this._tryWrite({
            type: "control_response",
            response: { subtype: "success", request_id: requestId, response },
          }),
        )
        .catch((error) =>
          this._tryWrite({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: requestId,
              error: String(error?.message || error),
            },
          }),
        );
      return;
    }
    if (message.type === "control_cancel_request") {
      try {
        this.onControlCancel?.(message.request_id);
      } catch {}
      return;
    }
    try {
      this.onMessage?.(message);
    } catch {
      // A handler error must not break the read loop.
    }
  }

  _onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    if (!this.stderrPath) return;
    try {
      fs.appendFileSync(this.stderrPath, chunk, { mode: 0o600 });
      const size = fs.statSync(this.stderrPath).size;
      if (size > STDERR_LIMIT) {
        const handle = fs.openSync(this.stderrPath, "r");
        const buffer = Buffer.alloc(STDERR_KEEP);
        try {
          fs.readSync(handle, buffer, 0, STDERR_KEEP, size - STDERR_KEEP);
        } finally {
          fs.closeSync(handle);
        }
        const cut = buffer.indexOf(0x0a);
        fs.writeFileSync(this.stderrPath, cut >= 0 ? buffer.subarray(cut + 1) : buffer, {
          mode: 0o600,
        });
      }
    } catch {
      // Diagnostics are best effort.
    }
  }

  _fail(error) {
    if (this._terminated) return;
    this._terminated = true;
    this.lineReader.reset();
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  _kill() {
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }

  // Ends stdin and waits for the child, escalating to SIGTERM/SIGKILL.
  async close({ graceMs = 1500 } = {}) {
    const child = this.child;
    if (!child) {
      this._terminated = true;
      return;
    }
    const alreadyGone = child.exitCode !== null || child.signalCode !== null;
    this._fail(codedError("Claude bağlantısı kapatıldı.", "CLAUDE_CONNECTION_CLOSED"));
    if (!alreadyGone) {
      try {
        child.stdin.end();
      } catch {}
      if (!(await waitForExit(child, graceMs))) {
        try {
          child.kill("SIGTERM");
        } catch {}
        if (!(await waitForExit(child, 2000))) {
          try {
            child.kill("SIGKILL");
          } catch {}
          await waitForExit(child, 1000);
        }
      }
    }
  }
}

export class ClaudeManager extends EventEmitter {
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

  // This manager owns only claude records; the shared store holds the others.
  _own(id) {
    const record = this.store.get(id); // throws 404 when unknown
    if (record.agentId !== "claude") throw new PanelError(404, "Oturum bulunamadı.");
    return record;
  }

  list() {
    return this.store
      .list()
      .filter((record) => record.agentId === "claude")
      .map((record) => this.withStatus(record));
  }

  get(id) {
    return this.withStatus(this._own(id));
  }

  withStatus(record) {
    return {
      ...record,
      status: record.endedAt ? "ended" : "running",
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
      modes: runtime?.modes ?? this._modes(record.claudePermissionMode),
      usage: runtime?.usage ?? null,
      pendingApprovalCount: runtime ? runtime.pendingApprovals.size : 0,
      settingsChanging: runtime?.settingsChanging === true,
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

  _modes(currentModeId) {
    const current = typeof currentModeId === "string" && currentModeId ? currentModeId : "default";
    const availableModes = CLAUDE_MODES.map((mode) => ({ ...mode }));
    if (!availableModes.some((mode) => mode.id === current))
      availableModes.push({ id: current, name: current, description: "Claude ayarlarından gelen mod." });
    return { currentModeId: current, availableModes };
  }

  // ---- Creation -----------------------------------------------------------

  create({ projectId, agentId, title, requestId }) {
    return this.store.enqueueCreate(`${agentId}:${requestId}`, async () => {
      if (!this.available)
        throw new PanelError(503, "Claude Code sohbet modu şu an kullanılamıyor.");
      if (agentId !== "claude")
        throw new PanelError(400, "Bu oturum türü yalnız Claude Code ile açılır.");
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))
        throw new PanelError(400, "Geçersiz işlem kimliği.");
      const previous = this.store.findByIdempotencyKey(requestId);
      if (previous && previous.agentId === "claude") return this.withStatus(previous);
      const project = this.project(projectId);
      if (!project) throw new PanelError(400, "Geçersiz proje veya agent.");
      if (typeof title !== "string" || title.length > 80 || /[\x00-\x1f\x7f]/.test(title))
        throw new PanelError(400, "Session adı en fazla 80 karakter olmalı.");
      if (this.store.records.length + this.store.pendingCreates.size - 1 >= STRUCTURED_RECORD_LIMIT)
        throw new PanelError(409, "Sohbet kaydı sınırına ulaşıldı. Eski bir sohbeti silebilirsin.");
      const live = [...this.runtimes.values()].filter((r) => r.conn?.alive).length;
      if (live >= CLAUDE_RUNNING_LIMIT)
        throw new PanelError(
          409,
          `Aynı anda en fazla ${CLAUDE_RUNNING_LIMIT} Claude sohbeti bağlı olabilir.`,
        );
      const id = crypto.randomUUID();
      const claudeSessionId = crypto.randomUUID();
      const runtime = this._startSession({
        id,
        cwd: project.path,
        claudeSessionId,
        resume: false,
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
        agentId: "claude",
        claudeSessionId,
        // Claude persists a session only after its first real turn; until
        // then a reopen starts the same id fresh instead of `--resume`.
        claudeStarted: false,
        claudePermissionMode: "default",
        projectId,
        title: title.trim() || `Claude · ${project.name}`,
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
        clearTimeout(runtime.interruptTimer);
        this._resolveAllPending(runtime);
        await runtime.conn?.close().catch(() => {});
        throw error;
      }
      this._broadcastState(id);
      return this.withStatus(record);
    });
  }

  // ---- Connection lifecycle ----------------------------------------------

  _spawn(runtime, { claudeSessionId, resume }) {
    const args = [
      ...this.agentCommand.args,
      // Enables switching to bypass later, without activating it at startup.
      "--allow-dangerously-skip-permissions",
      ...(resume ? ["--resume", claudeSessionId] : ["--session-id", claudeSessionId]),
    ];
    const connection = new ClaudeConnection({
      command: this.agentCommand.command,
      args,
      cwd: runtime.cwd,
      env: claudeChildEnv(this.env),
      stderrPath: this.store.stderrPath(runtime.id),
    });
    runtime.conn = connection;
    connection.onMessage = (message) => this._onMessage(runtime.id, runtime, connection, message);
    connection.onControl = (request, requestId) =>
      this._onControl(runtime.id, runtime, request, requestId);
    connection.onControlCancel = (requestId) => this._onControlCancel(runtime.id, runtime, requestId);
    connection.on("exit", () => this._onExit(runtime.id, runtime, connection));
    connection.start();
    return connection;
  }

  async _initialize(connection, modeId) {
    const init = await connection.control({ subtype: "initialize", hooks: null }, { timeoutMs: INIT_TIMEOUT_MS });
    // Reapply the panel's confirmed selection before accepting a prompt. This
    // also prevents a settings defaultMode from silently granting full access.
    await connection.control({ subtype: "set_permission_mode", mode: modeId });
    return init;
  }

  _startSession({ id, cwd, claudeSessionId, resume, modeId = "default" }) {
    this.store.assertRunningCapacity(id);
    const selectedMode = CLAUDE_MODES.some((mode) => mode.id === modeId) ? modeId : "default";
    const runtime = {
      id,
      conn: null,
      status: resume ? "resuming" : "starting",
      starting: null,
      claudeSessionId,
      cwd,
      models: null,
      modes: this._modes(selectedMode),
      usage: null,
      inflight: 0,
      turnId: 0,
      interruptTimer: null,
      pendingApprovals: new Map(),
      tools: new Map(),
      streamed: new Set(),
      currentMessageId: null,
      lastUsage: null,
      cancelRequested: false,
      intentional: false,
      lastError: null,
    };
    runtime.starting = (async () => {
      let connection = this._spawn(runtime, { claudeSessionId, resume });
      let init;
      let reopened = false;
      try {
        init = await this._initialize(connection, selectedMode);
      } catch (error) {
        await connection.close().catch(() => {});
        // The id was persisted after all (the first turn landed but the panel
        // missed it): resume it instead of starting over.
        if (!resume && /already in use/i.test(error.message)) {
          connection = this._spawn(runtime, { claudeSessionId, resume: true });
          init = await this._initialize(connection, selectedMode);
          this._markStarted(id);
          return this._ready(id, runtime, init, { resumed: true });
        }
        // A resume of a transcript Claude no longer has starts fresh, visibly;
        // any other failure fails the connect so the user can retry.
        if (!resume || !/no conversation found|not found|does not exist/i.test(error.message))
          throw error;
        runtime.claudeSessionId = crypto.randomUUID();
        connection = this._spawn(runtime, { claudeSessionId: runtime.claudeSessionId, resume: false });
        init = await this._initialize(connection, selectedMode);
        reopened = true;
        try {
          const record = this._own(id);
          record.claudeSessionId = runtime.claudeSessionId;
          record.claudeStarted = false;
          this.store.save();
        } catch {
          /* Creation path. */
        }
        this._append(id, {
          kind: "status",
          status: "reopened",
          detail: "Önceki Claude kaydı bulunamadı; sohbet yeni bir Claude oturumuyla sürdürülüyor.",
        });
      }
      return this._ready(id, runtime, init, { resumed: resume && !reopened });
    })();
    runtime.starting.then(
      () => {
        runtime.starting = null;
      },
      (error) => {
        runtime.starting = null;
        runtime.lastError = runtime.lastError || error?.message || "bağlantı kurulamadı";
        runtime.intentional = true;
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        runtime.conn?.close().catch(() => {});
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

  _ready(id, runtime, init, { resumed }) {
    runtime.models = {
      currentModelId: runtime.models?.currentModelId ?? "default",
      availableModels: this._modelCatalog(init),
    };
    runtime.status = "idle";
    runtime.lastError = null;
    try {
      const record = this._own(id);
      if (record.lastError) {
        record.lastError = null;
        this.store.save();
      }
    } catch {
      /* Creation path: the record lands right after. */
    }
    if (resumed)
      this._append(id, {
        kind: "status",
        status: "resumed",
        detail: "Oturum Claude kaydından geri yüklendi.",
      });
    this._broadcastState(id);
    return runtime;
  }

  _modelCatalog(init) {
    const models = Array.isArray(init?.models) ? init.models : [];
    const list = models
      .filter((model) => model && typeof model.value === "string")
      .slice(0, 20)
      .map((model) => ({
        modelId: model.value,
        name: typeof model.displayName === "string" && model.displayName ? model.displayName : model.value,
        description: typeof model.description === "string" ? model.description : null,
      }));
    if (!list.some((model) => model.modelId === "default"))
      list.unshift({ modelId: "default", name: "Varsayılan", description: "Claude ayarlarındaki model." });
    return list;
  }

  async _ensureRuntime(id) {
    const record = this._own(id);
    if (record.endedAt)
      throw new PanelError(409, "Bu oturum sonlandırılmış. Yeni bir sohbet açabilirsin.");
    if (!this.available)
      throw new PanelError(503, "Claude Code sohbet modu şu an kullanılamıyor.");
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
    if (live >= CLAUDE_RUNNING_LIMIT)
      throw new PanelError(
        409,
        `Aynı anda en fazla ${CLAUDE_RUNNING_LIMIT} Claude sohbeti bağlı olabilir. Bir sohbeti sonlandırıp tekrar dene.`,
      );
    const project = this.project(record.projectId);
    if (!project) throw new PanelError(400, "Oturumun projesi bulunamadı.");
    runtime = this._startSession({
      id,
      cwd: project.path,
      claudeSessionId: record.claudeSessionId,
      resume: !!record.claudeStarted,
      modeId: record.claudePermissionMode,
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
    // One turn at a time: a second message would be merged into the running
    // turn by Claude, which the panel could not attribute to its own result.
    if (runtime.settingsChanging)
      throw new PanelError(409, "Sohbet ayarı değiştiriliyor; tamamlandığında yeniden dene.");
    if (runtime.inflight > 0)
      throw new PanelError(409, "Claude şu an yanıtlıyor; turun bitmesini bekle ya da durdur.");
    this._append(id, { kind: "user", text }, true);
    runtime.turnId = (runtime.turnId ?? 0) + 1;
    runtime.inflight = 1;
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    try {
      runtime.conn.write({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        session_id: runtime.claudeSessionId,
      });
    } catch (error) {
      runtime.inflight = 0;
      this._append(id, { kind: "error", text: `Mesaj iletilemedi: ${error.message}` });
      this._syncRuntimeStatus(runtime);
      this._broadcastState(id);
      throw new PanelError(503, "Mesaj iletilemedi; bağlantı kapandı.");
    }
    return { delivered: true };
  }

  async cancel(id) {
    this._own(id);
    const runtime = this.runtimes.get(id);
    if (!runtime?.conn?.alive || runtime.inflight === 0) return { cancelled: false };
    const turnId = runtime.turnId, connection = runtime.conn;
    const sameTurn = () => this.runtimes.get(id) === runtime && runtime.conn === connection &&
      runtime.turnId === turnId && runtime.inflight > 0 && connection.alive;
    runtime.cancelRequested = true;
    try {
      await connection.control({ subtype: "interrupt" });
    } catch {
      if (sameTurn()) runtime.cancelRequested = false;
      return { cancelled: false };
    }
    if (!sameTurn()) return { cancelled: true };
    // Claude closes an interrupted turn with a result message; if none
    // arrives, close the unconfirmed connection before allowing another turn.
    clearTimeout(runtime.interruptTimer);
    runtime.interruptTimer = setTimeout(() => {
      if (!sameTurn()) return;
      this._append(id, { kind: "error", text: "Claude iptali doğrulanamadı; bağlantı kapatılıyor. Yeniden bağlanabilirsin." });
      connection.close().catch(() => {});
    }, INTERRUPT_SETTLE_MS);
    runtime.interruptTimer.unref?.();
    return { cancelled: true };
  }

  async approve(id, requestId, optionId, answers) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new PanelError(409, "Onay isteği artık geçerli değil.");
    const pending = runtime.pendingApprovals.get(requestId);
    if (!pending) throw new PanelError(409, "Onay isteği bulunamadı veya süresi geçti.");
    if (!pending.options.some((option) => option.optionId === optionId))
      throw new PanelError(400, "Geçersiz onay seçimi.");
    // Validate a complete form before consuming its pending request. Invalid
    // answers leave the card available for correction; never log the payload.
    const decision = pending.answer(optionId, answers);
    clearTimeout(pending.timer);
    runtime.pendingApprovals.delete(requestId);
    this._append(id, { kind: "approval", requestId, status: "decided", optionId: pending.isQuestion && optionId !== "__deny" ? "__answer" : optionId });
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    if (optionId === "denyStop") runtime.cancelRequested = true;
    pending.resolve(decision);
    return { ok: true };
  }

  async setModel(id, modelId) {
    if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 300)
      throw new PanelError(400, "Geçersiz model seçimi.");
    this._own(id);
    const runtime = await this._ensureRuntime(id);
    this._beginSettingsChange(runtime);
    try {
      try {
        await runtime.conn.control({
          subtype: "set_model",
          ...(modelId === "default" ? {} : { model: modelId }),
        });
      } catch (error) {
        const message = `Model değiştirilemedi: ${error.message}`;
        await this._disconnectSettingsFailure(id, runtime, message);
        throw new PanelError(503, message);
      }
      this._assertSettingsSession(id, runtime);
      if (runtime.models) runtime.models = { ...runtime.models, currentModelId: modelId };
      return { ok: true };
    } finally {
      runtime.settingsChanging = false;
      this._broadcastState(id);
    }
  }

  _beginSettingsChange(runtime) {
    if (runtime.inflight > 0 || runtime.pendingApprovals.size > 0 || runtime.settingsChanging)
      throw new PanelError(409, "Ayarı değiştirmek için yanıtın veya diğer ayar değişikliğinin bitmesini bekle ya da durdur.");
    runtime.settingsChanging = true;
    this._broadcastState(runtime.id);
  }

  async _disconnectSettingsFailure(id, runtime, message) {
    // A failed/expired response may hide an applied setting. Reconnect from
    // known state instead of accepting prompts on an uncertain child process.
    runtime.intentional = true;
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    await runtime.conn.close().catch(() => {});
    try {
      const record = this._own(id);
      record.lastError = message;
      this.store.save();
    } catch {
      // Preserve the original control/storage failure if diagnostics fail too.
    }
    this._broadcastState(id);
  }

  _assertSettingsSession(id, runtime) {
    const record = this._own(id);
    if (record.endedAt || this.runtimes.get(id) !== runtime || !runtime.conn?.alive)
      throw new PanelError(409, "Oturum ayar değişikliği sırasında kapandı; seçim uygulanmadı.");
    return record;
  }

  async setMode(id, modeId) {
    if (!CLAUDE_MODES.some((mode) => mode.id === modeId))
      throw new PanelError(400, "Geçersiz mod seçimi.");
    const record = this._own(id);
    const runtime = await this._ensureRuntime(id);
    this._beginSettingsChange(runtime);
    const previousMode = runtime.modes.currentModeId;
    const previousSavedMode = record.claudePermissionMode;
    try {
      try {
        await runtime.conn.control({ subtype: "set_permission_mode", mode: modeId });
      } catch (error) {
        const message = `Mod değiştirilemedi: ${error.message}`;
        await this._disconnectSettingsFailure(id, runtime, message);
        throw new PanelError(503, message);
      }
      this._assertSettingsSession(id, runtime);
      record.claudePermissionMode = modeId;
      try {
        this.store.save();
      } catch (error) {
        if (previousSavedMode === undefined) delete record.claudePermissionMode;
        else record.claudePermissionMode = previousSavedMode;
        try {
          await runtime.conn.control({ subtype: "set_permission_mode", mode: previousMode });
        } catch {
          await this._disconnectSettingsFailure(id, runtime, "İzin modu kaydedilemedi; önceki seçime dönmek için bağlantı kapatıldı.");
        }
        throw new PanelError(503, `İzin modu kaydedilemedi; önceki seçim korundu: ${error.message}`);
      }
      runtime.modes = this._modes(modeId);
      this._append(id, { kind: "mode", currentModeId: modeId });
      this._broadcastState(id);
      return { ok: true };
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
      clearTimeout(runtime.interruptTimer);
      this._resolveAllPending(runtime);
      await runtime.conn?.close().catch(() => {});
    }
    this._append(id, { kind: "status", status: "ended", detail: "Oturum panelden sonlandırıldı." });
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
      clearTimeout(runtime.interruptTimer);
      this._resolveAllPending(runtime);
      await runtime.conn?.close().catch(() => {});
    }));
  }

  // ---- stream-json handling -----------------------------------------------

  _markStarted(id) {
    try {
      const record = this._own(id);
      if (!record.claudeStarted) {
        record.claudeStarted = true;
        this.store.save();
      }
    } catch {
      /* Creation path or deleted record. */
    }
  }

  _onMessage(id, runtime, connection, message) {
    if (runtime.conn !== connection) return;
    // Subagent traffic carries its parent tool id; only the main thread is
    // rendered (the subagent's own approvals still arrive as control requests).
    if (message.parent_tool_use_id) return;
    switch (message.type) {
      case "system":
        return this._onSystem(id, runtime, message);
      case "stream_event":
        return this._onStreamEvent(id, runtime, message.event);
      case "assistant":
        return this._onAssistant(id, runtime, message.message);
      case "user":
        return this._onUserEcho(id, runtime, message.message);
      case "result":
        return this._onResult(id, runtime, message);
      default:
        return;
    }
  }

  _onSystem(id, runtime, message) {
    if (message.subtype === "init") {
      if (typeof message.session_id === "string" && message.session_id)
        runtime.claudeSessionId = message.session_id;
      // This startup snapshot can have been queued before set_permission_mode
      // was acknowledged. The control response owns the panel's selected mode.
      this._markStarted(id);
      this._broadcastState(id);
      return;
    }
    if (message.subtype === "compact_boundary") {
      this._append(id, {
        kind: "status",
        status: "notice",
        detail: "Claude bağlamı sıkıştırdı; önceki konuşma özetlenerek sürdürülüyor.",
      });
    }
  }

  _onStreamEvent(id, runtime, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "message_start") {
      runtime.currentMessageId = event.message?.id ?? null;
      return;
    }
    if (event.type !== "content_block_delta") return;
    const messageId = runtime.currentMessageId;
    if (!messageId) return;
    const delta = event.delta ?? {};
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      runtime.streamed.add(`${messageId}:text`);
      this._append(id, { kind: "assistant", id: messageId, text: delta.text });
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      runtime.streamed.add(`${messageId}:thinking`);
      this._append(id, { kind: "thought", id: `${messageId}:thinking`, text: delta.thinking });
    }
    if (runtime.streamed.size > TOOL_KEEP) runtime.streamed.delete(runtime.streamed.values().next().value);
  }

  _onAssistant(id, runtime, message) {
    if (!message || !Array.isArray(message.content)) return;
    const messageId = typeof message.id === "string" ? message.id : null;
    if (message.usage) runtime.lastUsage = message.usage;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        if (!messageId || !runtime.streamed.has(`${messageId}:text`))
          this._append(id, { kind: "assistant", id: messageId, text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        if (!messageId || !runtime.streamed.has(`${messageId}:thinking`))
          this._append(id, {
            kind: "thought",
            id: messageId ? `${messageId}:thinking` : null,
            text: block.thinking,
          });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        this._onToolUse(id, runtime, block);
      }
    }
  }

  _onToolUse(id, runtime, block) {
    if (runtime.tools.has(block.id)) return;
    const name = String(block.name ?? "");
    const input = block.input && typeof block.input === "object" ? block.input : {};
    runtime.tools.set(block.id, { name });
    if (runtime.tools.size > TOOL_KEEP) runtime.tools.delete(runtime.tools.keys().next().value);
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this._append(id, {
        kind: "plan",
        entries: input.todos.slice(0, 50).map((todo) => ({
          content: String(todo?.content ?? ""),
          status: String(todo?.status ?? ""),
        })),
      });
      return;
    }
    const kind = TOOL_KIND[name] ?? "other";
    const diffs = claudeToolDiffs(name, input);
    this._append(id, {
      kind: "tool",
      id: block.id,
      app: "start",
      data: {
        title: claudeToolTitle(name, input),
        kind,
        status: "in_progress",
        rawInput:
          name === "Bash" && typeof input.command === "string"
            ? { command: clip(input.command, 4000), description: input.description ?? null }
            : null,
        content: diffs,
      },
    });
  }

  _onUserEcho(id, runtime, message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = runtime.tools.get(block.tool_use_id);
      if (!tool || tool.name === "TodoWrite") continue;
      const status = block.is_error ? "failed" : "completed";
      // Edits keep their diff blocks; the agent's short confirmation adds
      // nothing the diff does not already show.
      // Question tool results repeat the submitted form, possibly including a
      // secret. Its completion status is useful; recording its answers is not.
      if (tool.name === "AskUserQuestion" || (TOOL_KIND[tool.name] === "edit" && !block.is_error)) {
        this._append(id, { kind: "tool", id: block.tool_use_id, app: "update", patch: { status } });
        continue;
      }
      const text = clip(toolResultText(block.content), OUTPUT_CAP) || "(çıktı yok)";
      this._append(id, {
        kind: "tool",
        id: block.tool_use_id,
        app: "update",
        patch: { status, content: [{ type: "content", content: { type: "text", text } }] },
      });
    }
  }

  _onResult(id, runtime, message) {
    clearTimeout(runtime.interruptTimer);
    runtime.inflight = 0;
    runtime.streamed.clear();
    const usage = runtime.lastUsage;
    const used = usage
      ? Number(usage.input_tokens ?? 0) +
        Number(usage.cache_read_input_tokens ?? 0) +
        Number(usage.cache_creation_input_tokens ?? 0) +
        Number(usage.output_tokens ?? 0)
      : 0;
    const windows = Object.values(message.modelUsage ?? {})
      .map((entry) => Number(entry?.contextWindow))
      .filter((value) => Number.isFinite(value) && value > 0);
    const size = windows.length ? Math.max(...windows) : runtime.usage?.size ?? null;
    if (used > 0 && size) {
      runtime.usage = { used, size };
      this._append(id, { kind: "usage", used, size });
    }
    // A turn the user stopped ends as cancelled, not as an error.
    const cancelled = runtime.cancelRequested;
    runtime.cancelRequested = false;
    const stopReason = cancelled
      ? "cancelled"
      : message.subtype === "success"
        ? "end_turn"
        : String(message.subtype ?? "end_turn");
    this._append(id, { kind: "turn", stopReason, usage: null });
    if (cancelled) {
      /* No error note for an explicit stop. */
    } else if (message.is_error && message.subtype !== "success") {
      const detail = Array.isArray(message.errors) && message.errors.length
        ? message.errors.map(String).join("; ")
        : stopReason;
      this._append(id, { kind: "error", text: `Tur hatası: ${short(detail, 300)}` });
    } else if (message.is_error && typeof message.result === "string") {
      this._append(id, { kind: "error", text: `Tur hatası: ${short(message.result, 300)}` });
    }
    this._markStarted(id);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
  }

  // ---- Control requests from Claude ---------------------------------------

  _onControl(id, runtime, request, controlId) {
    if (request.subtype === "can_use_tool") return this._permissionRequest(id, runtime, request, controlId);
    // Hook callbacks and MCP messages are not registered by the panel.
    return Promise.reject(codedError(`Desteklenmeyen kontrol isteği: ${request.subtype}`, "CLAUDE_CONTROL_UNSUPPORTED"));
  }

  _onControlCancel(id, runtime, controlId) {
    for (const [requestId, pending] of runtime.pendingApprovals) {
      if (pending.controlId !== controlId) continue;
      clearTimeout(pending.timer);
      runtime.pendingApprovals.delete(requestId);
      this._append(id, { kind: "approval", requestId, status: "expired" });
      pending.resolve({ behavior: "deny", message: "İstek Claude tarafından iptal edildi." });
    }
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
  }

  _permissionRequest(id, runtime, request, controlId) {
    const name = String(request.tool_name ?? "");
    const input = request.input && typeof request.input === "object" ? request.input : {};
    const requestId = `a${++this.approvalSerial}-${crypto.randomUUID().slice(0, 8)}`;
    let options;
    let answer;
    let toolCall;
    let questions;
    const deny = (message, interrupt = false) => ({
      behavior: "deny",
      message,
      ...(interrupt ? { interrupt: true } : {}),
    });
    if (name === "AskUserQuestion") {
      questions = normalizeQuestions(input.questions);
      if (!questions) {
        this._append(id, {
          kind: "status",
          status: "notice",
          detail: "Claude geçersiz veya çok uzun bir soru formu gönderdi; istek reddedildi.",
        });
        return Promise.resolve(deny("Soru formu 1–3 geçerli soru içermeli; soruları bölerek yeniden sor."));
      }
      const question = questions[0];
      // Preserve the old single-choice API while new clients submit one form.
      options = (questions.length === 1 && !question.multiSelect ? question.options : [])
        .map((choice) => ({ optionId: choice.label, kind: "allow_once", name: choice.label }));
      options.push({ optionId: "__answer", kind: "allow_once", name: "Yanıtları gönder" });
      options.push({ optionId: "__deny", kind: "reject_once", name: "Yanıtlama" });
      toolCall = {
        title: question.header ? `${question.header} · ${question.question}` : String(question.question ?? "Soru"),
        rawInput: null,
      };
      answer = (optionId, answers) =>
        optionId === "__deny"
          ? deny("Kullanıcı soruyu yanıtlamadı.")
          : {
              behavior: "allow",
              updatedInput: { ...input, answers: questionAnswers(questions, optionId === "__answer" ? answers : { [question.id]: optionId }) },
            };
    } else {
      const suggestions = Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : [];
      options = APPROVAL_OPTIONS.filter(
        (option) => option.optionId !== "allowSession" || suggestions.length > 0,
      );
      toolCall = {
        ...(typeof request.tool_use_id === "string" && request.tool_use_id ? { toolCallId: request.tool_use_id } : {}),
        title:
          name === "ExitPlanMode"
            ? `Plan onayı: ${short(input.plan, 300)}`
            : request.decision_reason
              ? `${claudeToolTitle(name, input)} — ${short(request.decision_reason, 200)}`
              : claudeToolTitle(name, input),
        rawInput:
          name === "Bash" && typeof input.command === "string"
            ? { command: clip(input.command, 4000) }
            : null,
      };
      answer = (optionId) => {
        if (optionId === "allow") return { behavior: "allow", updatedInput: input };
        if (optionId === "allowSession")
          return {
            behavior: "allow",
            updatedInput: input,
            // "For this session" only: never persisted to the user's settings.
            updatedPermissions: suggestions.map((suggestion) => ({
              ...suggestion,
              destination: "session",
            })),
          };
        if (optionId === "denyStop") return deny("Kullanıcı reddetti ve turu durdurdu.", true);
        return deny("Kullanıcı panelden reddetti.");
      };
    }
    // Never grant an input whose executable suffix was hidden from the owner.
    if (name === "Bash" && typeof input.command === "string" && input.command.length > 4000) {
      this._append(id, {
        kind: "status",
        status: "notice",
        detail: "Komut tam olarak gösterilemeyecek kadar uzun; istek reddedildi.",
      });
      return deny("Komut tam olarak gösterilemeyecek kadar uzun; daha kısa komutlarla yeniden iste.");
    }
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const pending = { requestId, controlId, options, answer, isQuestion: !!questions, title: toolCall?.title ?? "", expiresAt, resolve: null, timer: null };
    const stored = this._append(id, {
      kind: "approval",
      requestId,
      status: "requested",
      toolCall,
      options: [...options],
      ...(questions ? { questions } : {}),
      expiresAt,
    });
    if (!stored) return deny("Onay isteği gösterilemedi; istek reddedildi.");
    runtime.pendingApprovals.set(requestId, pending);
    this._syncRuntimeStatus(runtime);
    this._broadcastState(id);
    return new Promise((resolve) => {
      pending.resolve = resolve;
      pending.timer = setTimeout(() => {
        if (!runtime.pendingApprovals.has(requestId)) return;
        runtime.pendingApprovals.delete(requestId);
        this._append(id, { kind: "approval", requestId, status: "expired" });
        this._syncRuntimeStatus(runtime);
        this._broadcastState(id);
        resolve(deny("Onay süresi doldu; panel isteği reddetti."));
      }, APPROVAL_TIMEOUT_MS);
      pending.timer.unref?.();
    });
  }

  _onExit(id, runtime, connection) {
    if (runtime.conn !== connection || runtime.intentional) return;
    // A failure during startup is reported by the starting promise.
    if (runtime.starting) return;
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    clearTimeout(runtime.interruptTimer);
    this._resolveAllPending(runtime);
    let record = null;
    try {
      record = this._own(id);
    } catch {
      /* Unknown session. */
    }
    if (record && !record.endedAt) {
      if (runtime.inflight > 0)
        this._append(id, { kind: "error", text: "Claude süreci tur sırasında kapandı." });
      this._append(id, {
        kind: "status",
        status: "offline",
        detail: "Claude süreci kapandı; oturum yeniden bağlanınca kaydından geri yüklenecek.",
      });
    }
    this._broadcastState(id);
  }

  _resolveAllPending(runtime) {
    for (const [requestId, pending] of runtime.pendingApprovals) {
      clearTimeout(pending.timer);
      this._append(runtime.id, { kind: "approval", requestId, status: "expired" });
      pending.resolve({ behavior: "deny", message: "Oturum kapandı." });
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
      console.error("claude event append failed:", error.message);
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
