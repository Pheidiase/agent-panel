// Newline-delimited JSON-RPC 2.0 stdio client for the panel's structured
// sessions: the Hermes ACP adapter (`hermes acp`, verified against
// agent-client-protocol 0.9.0) and the Codex app-server (`codex app-server`).
// Both frame one JSON message per line on the child's stdin/stdout and route
// their logging to stderr. Framing, request routing and lifecycle live here —
// no new dependency; `label` only names the child in error messages.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { LineReader } from "./line-reader.mjs";
import { codedError } from "./error-codes.mjs";
import fs from "node:fs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_ERRORS = 25;
const STDERR_LIMIT = 1024 * 1024;
const STDERR_KEEP = 256 * 1024;

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

export class AcpConnection extends EventEmitter {
  constructor({ command, args = [], cwd, env, stderrPath = null, label = "ACP" }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.stderrPath = stderrPath;
    this.label = label;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lineReader = new LineReader(MAX_LINE_BYTES);
    this.protocolErrors = 0;
    this._terminated = false;
    this.onNotification = null;
    this.onRequest = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this._terminated;
  }

  start() {
    if (this.child) throw codedError(`${this.label} bağlantısı zaten başlatıldı.`, "ACP_ALREADY_STARTED");
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
      this._fail(codedError(`${this.label} süreci başlatılamadı: ${error.message}`, "AGENT_START_FAILED"));
    });
    this.child.on("exit", (code, signal) => {
      this._fail(
        new Error(
          `${this.label} süreci kapandı (kod ${code ?? "?"}${signal ? ", " + signal : ""})`,
        ),
      );
      this.emit("exit", { code, signal });
    });
    return this;
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    if (!this.alive) return Promise.reject(codedError(`${this.label} bağlantısı kapalı.`, "AGENT_CONNECTION_CLOSED"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(codedError(`${method} zaman aşımına uğradı.`, "ACP_REQUEST_TIMEOUT"));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.alive) throw codedError(`${this.label} bağlantısı kapalı.`, "AGENT_CONNECTION_CLOSED");
    this._write({ jsonrpc: "2.0", method, params });
  }

  _write(message) {
    if (!this.alive) throw codedError(`${this.label} bağlantısı kapalı.`, "AGENT_CONNECTION_CLOSED");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  _tryWrite(message) {
    try {
      this._write(message);
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
      this._fail(codedError(`${this.label} akışı sınırı aştı (satır çok uzun).`, "AGENT_STREAM_TOO_LONG"));
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
        this._fail(codedError(`${this.label} akışı bozuldu (geçersiz JSON).`, "AGENT_STREAM_INVALID_JSON"));
        this._kill();
      }
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) {
        const detail = message.error.message || "bilinmeyen hata";
        entry.reject(new Error(`${entry.method}: ${detail}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      // A request FROM the agent (e.g. session/request_permission).
      const handler = this.onRequest;
      new Promise((resolve, reject) => {
        if (!handler) return reject(new Error(`Desteklenmeyen istek: ${message.method}`));
        resolve(handler(message.method, message.params));
      })
        .then((result) => this._tryWrite({ jsonrpc: "2.0", id: message.id, result }))
        .catch((error) =>
          this._tryWrite({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: String(error?.message || error) },
          }),
        );
      return;
    }
    try {
      this.onNotification?.(message.method, message.params);
    } catch {
      // A handler error must not break the read loop.
    }
  }

  _onStderr(chunk) {
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
        fs.writeFileSync(
          this.stderrPath,
          cut >= 0 ? buffer.subarray(cut + 1) : buffer,
          { mode: 0o600 },
        );
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

  async close({ graceMs = 1500 } = {}) {
    const child = this.child;
    this._fail(codedError(`${this.label} bağlantısı kapatıldı.`, "AGENT_CONNECTION_CLOSED"));
    if (!child) {
      return;
    }
    const alreadyGone = child.exitCode !== null || child.signalCode !== null;
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
