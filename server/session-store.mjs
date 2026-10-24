import { errorCode } from "./error-codes.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { toolBinary, utf8Env } from "./config.mjs";
import { parseStyled } from "./ansi.mjs";
import { TranscriptWriter, TRANSCRIPT_LIMIT } from "./transcript-writer.mjs";
export { TRANSCRIPT_LIMIT, TRANSCRIPT_KEEP } from "./transcript-writer.mjs";
export const exec = promisify(execFile);

// Panel-owned terminal geometry. Viewers render whatever size the session was
// created with; they must never resize the tmux window, because a resize
// rewraps every retained line and moves text the user is reading.
export const GEOMETRY_PRESETS = [
  { id: "mobil", label: "Mobil", cols: 80, rows: 30 },
  { id: "standart", label: "Standart", cols: 120, rows: 34 },
  { id: "genis", label: "Geniş", cols: 160, rows: 42 },
  { id: "cok-genis", label: "Çok geniş", cols: 200, rows: 50 },
];
export const DEFAULT_GEOMETRY = { cols: 120, rows: 34 };
// Capture drops the oldest half before an append would exceed its budget.
export const TRANSCRIPT_READ_TAIL = 2 * 1024 * 1024;
// Reader responses are trimmed for display and bounded from the top at a line
// boundary; the oldest lines drop first and a line is never cut in half.
export const OUTPUT_READ_LIMIT = 2 * 1024 * 1024;

export function validGeometry(cols, rows) {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 40 &&
    cols <= 300 &&
    rows >= 10 &&
    rows <= 120
  );
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function transcriptCommand(file) {
  return [process.execPath, path.join(import.meta.dirname, "transcript-writer.mjs"), file]
    .map(shellQuote).join(" ");
}

function readerText(raw, limit = OUTPUT_READ_LIMIT) {
  let text = String(raw).replace(/[ \t]+$/gm, "");
  if (text.length > limit) {
    const cut = text.indexOf("\n", text.length - limit);
    text = cut < 0 ? text.slice(-limit) : text.slice(cut + 1);
  }
  return text.replace(/\s+$/, "");
}

export class PanelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = errorCode(message, status);
  }
}
export class Sessions {
  constructor({ root, stateDir, socket, projects, agents, tools = {} }) {
    Object.assign(this, { root, stateDir, socket, projects, agents, tools });
    this.file = path.join(stateDir, "sessions.json");
    this.records = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : [];
    this.serial = Promise.resolve();
    this.transcriptStarts = new Map();
    this.transcriptCaptures = new Set();
  }
  tmux(args, maxBuffer = 8 * 1024 * 1024) {
    return exec(this.tools.tmux || toolBinary("tmux", "PANEL_TMUX_BINARY"),
      // -u: without a UTF-8 locale tmux prints tabs as "_" and breaks list parsing.
      ["-u", "-f", path.join(this.root, "config/tmux.conf"), "-S", this.socket, ...args], {
      timeout: 5000,
      maxBuffer,
      env: utf8Env(),
    });
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }
  geometry(s) {
    return validGeometry(s.geometry?.cols, s.geometry?.rows)
      ? s.geometry
      : DEFAULT_GEOMETRY;
  }
  transcriptPath(id) {
    return path.join(this.stateDir, `transcript-${id}.log`);
  }
  async list() {
    let result;
    try {
      result = await this.tmux([
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{pane_dead}\t#{pane_pid}\t#{pane_dead_status}\t#{pane_width}\t#{pane_height}\t#{pane_pipe}",
      ]);
    } catch (e) {
      if (/no current target|no server running on|error connecting to .*\(No such file or directory\)/.test(e.stderr || "")) result = { stdout: "" };
      else throw e;
    }
    const live = new Map(
      result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, dead, pid, exit, width, height, pipe] = line.split("\t");
          return [
            name,
            {
              status: dead === "1" ? "ended" : "running",
              pid: Number(pid),
              exitCode: exit === "" ? null : Number(exit),
              width: Number(width),
              height: Number(height),
              pipe: pipe === "1",
            },
          ];
        }),
    );
    // Sessions created before geometry was pinned keep the size they already
    // have; adopting it avoids a surprise rewrap on the next visit.
    let adopted = false;
    for (const r of this.records) {
      const info = live.get(r.tmux);
      if (info?.status === "running" && !validGeometry(r.geometry?.cols, r.geometry?.rows) &&
          validGeometry(info.width, info.height)) {
        r.geometry = { cols: info.width, rows: info.height };
        adopted = true;
      }
    }
    if (adopted) this.save();
    // Self-healing: if a stray client resized a pane, put the recorded size
    // back so the session keeps reading the same way for every viewer.
    for (const r of this.records) {
      const info = live.get(r.tmux);
      if (!info || info.status !== "running") continue;
      // Only pinned sessions are re-asserted; a session that never had an
      // explicit size keeps whatever geometry it already has.
      if (!validGeometry(r.geometry?.cols, r.geometry?.rows)) continue;
      const fixed = this.geometry(r);
      if (info.width === fixed.cols && info.height === fixed.rows) continue;
      this.tmux([
        "resize-window",
        "-t",
        r.tmux,
        "-x",
        String(fixed.cols),
        "-y",
        String(fixed.rows),
      ]).catch(() => {});
    }
    await this.ensureTranscripts(live);
    return this.records.map((r) => {
      const info = live.get(r.tmux);
      const { width, height, pipe, ...status } = info || {};
      return {
        ...r,
        geometry: this.geometry(r),
        ...(info ? status : { status: r.endedAt ? "ended" : "unavailable", pid: null }),
      };
    });
  }
  // Transcript capture is best effort: it is the fallback history source for
  // panes tmux can no longer read; a session without one still works.
  async ensureTranscripts(live) {
    for (const r of this.records) {
      const info = live.get(r.tmux);
      if (!info || info.status !== "running" || (info.pipe && this.transcriptCaptures.has(r.id))) continue;
      try {
        await this.startTranscript(r, info.pipe);
      } catch { /* keep the session usable without a transcript */ }
    }
  }
  async startTranscript(s, pipeActive = false) {
    if (this.transcriptStarts.has(s.id)) return this.transcriptStarts.get(s.id);
    const operation = this.startTranscriptSerial(s, pipeActive);
    this.transcriptStarts.set(s.id, operation);
    try { return await operation; } finally { this.transcriptStarts.delete(s.id); }
  }
  async startTranscriptSerial(s, pipeActive = false) {
    const file = this.transcriptPath(s.id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch { /* Not created yet. */ }
    if (size === 0) {
      // Seed with the retained scrollback before the pipe opens, so output
      // produced before this point is not lost. Only a few milliseconds of
      // output between the capture and the pipe can fall outside both.
      const result = await this.tmux([
        "capture-pane",
        "-p",
        "-J",
        "-S",
        "-5000",
        "-t",
        s.tmux,
      ]);
      const writer = new TranscriptWriter(file);
      try { writer.append(Buffer.from(result.stdout)); }
      finally { writer.close(); }
      fs.chmodSync(file, 0o600);
    }
    // Replace legacy unbounded pipes on first reconciliation after a restart.
    // Only the output pipe changes; the tmux pane and agent remain alive.
    if (pipeActive) await this.tmux(["pipe-pane", "-t", s.tmux]);
    const writer = new TranscriptWriter(file);
    writer.close();
    await this.tmux(["pipe-pane", "-o", "-t", s.tmux, transcriptCommand(file)]);
    this.transcriptCaptures.add(s.id);
  }
  async trimTranscripts() {
    for (const s of await this.list()) {
      // Also repair legacy ended/unavailable captures, which the old cleanup
      // skipped forever. Normally active writers already enforce the budget.
      const file = this.transcriptPath(s.id);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch { continue; }
      if (size <= TRANSCRIPT_LIMIT) continue;
      if (s.status === "running") await this.tmux(["pipe-pane", "-t", s.tmux]);
      const writer = new TranscriptWriter(file);
      writer.close();
      if (s.status === "running")
        await this.tmux(["pipe-pane", "-o", "-t", s.tmux, transcriptCommand(file)]);
    }
  }
  create(input) {
    return this.enqueue(() => this.createSerial(input));
  }
  enqueue(operation) {
    const work = this.serial.then(operation);
    this.serial = work.catch(() => {});
    return work;
  }
  async createSerial({
    projectId,
    agentId,
    title,
    requestId,
    allowParallel = false,
    geometry,
  }) {
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)
    )
      throw new PanelError(400, "Geçersiz işlem kimliği.");
    const previous = this.records.find((r) => r.requestId === requestId);
    if (previous) return previous;
    const project = this.projects.find((p) => p.id === projectId);
    const agent = this.agents.find((a) => a.id === agentId);
    if (!project || !agent)
      throw new PanelError(400, "Geçersiz proje veya agent.");
    if (!agent.available)
      throw new PanelError(409, "Bu agent henüz kurulu değil.");
    if (
      typeof title !== "string" ||
      title.length > 80 ||
      /[\x00-\x1f\x7f]/.test(title)
    )
      throw new PanelError(400, "Session adı en fazla 80 karakter olmalı.");
    if (typeof allowParallel !== "boolean")
      throw new PanelError(400, "Geçersiz paralel çalışma seçimi.");
    const size = geometry === undefined ? DEFAULT_GEOMETRY : geometry;
    if (!validGeometry(size?.cols, size?.rows))
      throw new PanelError(400, "Geçersiz terminal ölçüsü.");
    const current = await this.list();
    if (this.records.length >= 100)
      throw new PanelError(
        409,
        "Session kaydı sınırına ulaşıldı. Eski bir session’ı kapatabilirsin.",
      );
    if (current.filter((s) => s.status === "running").length >= 8)
      throw new PanelError(409, "En fazla 8 açık session olabilir.");
    if (
      current.some(
        (s) => s.projectId === projectId && s.status === "running",
      ) &&
      !allowParallel
    )
      throw new PanelError(
        409,
        "Bu projede açık session var. Paralel çalışma seçimini onaylayabilirsin.",
      );
    const id = crypto.randomUUID();
    const target = `ap-${id}`;
    const record = {
      id,
      tmux: target,
      projectId,
      agentId,
      title: title.trim() || `${agent.name} · ${project.name}`,
      createdAt: new Date().toISOString(),
      requestId,
      geometry: { cols: size.cols, rows: size.rows },
    };
    // Multiple command arguments are executed directly by tmux, never shell-interpolated.
    await this.tmux([
      "new-session",
      "-d",
      "-s",
      target,
      "-c",
      project.path,
      "-x",
      String(size.cols),
      "-y",
      String(size.rows),
      process.execPath,
      path.join(this.root, "server", "run-agent.mjs"),
      agentId,
      project.path,
      agent.executable,
      project.kind === "general" ? "general" : "project",
    ]);
    this.records.unshift(record);
    try { this.save(); }
    catch (error) {
      this.records = this.records.filter(r => r !== record);
      await this.kill(record).catch(() => {});
      throw error;
    }
    try {
      await this.startTranscript(record);
    } catch { /* History falls back to the live screen. */ }
    return record;
  }
  get(id) {
    const s = this.records.find((r) => r.id === id);
    if (!s) throw new PanelError(404, "Session bulunamadı.");
    return s;
  }
  update(id, changes) {
    return this.enqueue(() => {
      const s = this.get(id);
      if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
          Object.keys(changes).some(k => !["title", "archived", "pinned", "opened"].includes(k)))
        throw new PanelError(400, "Geçersiz oturum işlemi.");
      if ("title" in changes && (typeof changes.title !== "string" || !changes.title.trim() ||
          changes.title.length > 80 || /[\x00-\x1f\x7f]/.test(changes.title)))
        throw new PanelError(400, "Oturum adı 1–80 karakter olmalı.");
      for (const k of ["archived", "pinned", "opened"])
        if (k in changes && typeof changes[k] !== "boolean")
          throw new PanelError(400, "Geçersiz oturum seçimi.");
      if ("title" in changes) s.title = changes.title.trim();
      for (const k of ["archived", "pinned"]) if (k in changes) s[k] = changes[k];
      if (changes.opened) s.lastOpenedAt = new Date().toISOString();
      this.save();
      return s;
    });
  }
  // The agent's own conversation log, mapped while the session ran, so the
  // reader can still show it after the process ends. Only id and folder.
  rememberLog(id, log) {
    return this.enqueue(() => {
      const s = this.get(id);
      if (s.log?.id === log.id && s.log?.cwd === log.cwd) return s;
      s.log = { id: String(log.id), cwd: String(log.cwd) };
      this.save();
      return s;
    });
  }
  setGeometry(id, cols, rows) {
    return this.enqueue(async () => {
      const s = this.get(id);
      if (!validGeometry(cols, rows))
        throw new PanelError(400, "Geçersiz terminal ölçüsü.");
      // The only resize the panel performs: an explicit, user-requested change.
      if (!s.endedAt) {
        try {
          await this.tmux([
            "resize-window",
            "-t",
            s.tmux,
            "-x",
            String(cols),
            "-y",
            String(rows),
          ]);
        } catch (e) {
          if (!/can't find|no current target|no server running on|error connecting to .*\(No such file or directory\)/.test(e.stderr || ""))
            throw e;
        }
      }
      s.geometry = { cols, rows };
      this.save();
      return s;
    });
  }
  snapshotPath(id) {
    this.get(id);
    return path.join(this.stateDir, `output-${id}.txt`);
  }
  // Optional colour sidecar of the final snapshot ({styles, runs} over the
  // .txt text). Older sessions have none and read as plain text.
  stylePath(id) {
    this.get(id);
    return path.join(this.stateDir, `output-${id}.style.json`);
  }
  savedStyles(id, text) {
    try {
      const { styles, runs, length } = JSON.parse(fs.readFileSync(this.stylePath(id), "utf8"));
      if (length === text.length && Array.isArray(styles) && Array.isArray(runs)) return { styles, runs };
    } catch { /* No colour for this snapshot. */ }
    return {};
  }
  // Lines that have scrolled off the top of a live pane, one terminal row per
  // line (no -J), so they sit directly above the live screen at the same width.
  // The visible screen itself is never included; the live terminal draws it.
  async scrollback(id) {
    const s = this.get(id);
    if (s.endedAt) throw new PanelError(409, "Oturum sonlanmış.");
    // A full-screen program on the alternate screen has no tmux history; the
    // view then keeps the reader as its way back.
    const info = await this.tmux(["display-message", "-p", "-t", s.tmux, "#{history_size} #{alternate_on}"]);
    const [size, alternate] = info.stdout.trim().split(" ").map((n) => Number.parseInt(n, 10));
    if (alternate === 1) return { text: "", lines: 0, alternate: true };
    if (!(size > 0)) return { text: "", lines: 0, alternate: false };
    const result = await this.tmux(["capture-pane", "-e", "-p", "-S", "-", "-E", "-1", "-t", s.tmux], 32 * 1024 * 1024);
    const { text, styles, runs } = parseStyled(result.stdout.replace(/\n$/, ""), { limit: OUTPUT_READ_LIMIT });
    return { text, styles, runs, lines: text ? text.split("\n").length : 0, alternate: false };
  }
  async output(id) {
    const s = this.get(id);
    if (s.endedAt && fs.existsSync(this.snapshotPath(id))) {
      const text = fs.readFileSync(this.snapshotPath(id), "utf8");
      return { text, saved: true, ...this.savedStyles(id, text) };
    }
    // A live pane is read through tmux's own terminal emulation: cursor
    // addressing and in-place redraws are collapsed by the emulator that
    // produced the screen, so a full-screen TUI reads exactly as it was
    // shown. Rendering the raw byte stream instead needs a second terminal
    // emulator; the former naive fallback garbled exactly such sessions.
    let captureError = null;
    try {
      // `-e` keeps the colours; the parsed plain text is identical to the
      // uncoloured capture, so anchors and search behave exactly as before.
      const result = await this.tmux([
        "capture-pane", "-e", "-p", "-J", "-S", "-", "-t", s.tmux,
      ], 32 * 1024 * 1024);
      const { text, styles, runs } = parseStyled(result.stdout, { limit: OUTPUT_READ_LIMIT });
      return { text, styles, runs, saved: false, source: "screen" };
    } catch (e) { captureError = e; }
    // Fallback for a pane tmux no longer has: the append-only transcript.
    const transcript = this.transcriptPath(id);
    let size = 0;
    try {
      size = fs.statSync(transcript).size;
    } catch { /* No transcript for this session. */ }
    if (size > 0) {
      try {
        const r = await exec(
          this.tools.python3 || toolBinary("python3", "PANEL_PYTHON_BINARY"),
          [
            path.join(this.root, "server/transcript.py"),
            transcript,
            String(TRANSCRIPT_READ_TAIL),
          ],
          { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        );
        return { text: readerText(r.stdout), saved: false, source: "transcript" };
      } catch { /* Fall through to the access error. */ }
    }
    if (captureError && !/can't find|no current target|no server running on|error connecting to .*\(No such file or directory\)/.test(captureError.stderr || ""))
      throw captureError;
    throw new PanelError(409, "Bu oturumun terminal çıktısına artık erişilemiyor.");
  }
  stop(id) {
    return this.enqueue(async () => {
      const s = this.get(id);
      if (s.endedAt) return s;
      let output;
      try { output = await this.output(id); }
      catch (error) {
        if (!(error instanceof PanelError) || error.status !== 409) throw error;
      }
      if (output) {
        fs.writeFileSync(this.snapshotPath(id), output.text, { mode: 0o600 });
        if (output.runs?.length)
          fs.writeFileSync(this.stylePath(id), JSON.stringify({ length: output.text.length, styles: output.styles, runs: output.runs }), { mode: 0o600 });
      }
      await this.kill(s);
      s.endedAt = new Date().toISOString();
      this.save();
      return s;
    });
  }
  async kill(s) {
    await this.tmux(["kill-session", "-t", s.tmux]).catch((e) => {
      if (!/can't find session|no current target|no server running on|error connecting to .*\(No such file or directory\)/.test(e.stderr || "")) throw e;
    });
  }
  end(id) {
    return this.enqueue(() => this.deleteSerial(id));
  }
  async deleteSerial(id) {
    const s = this.get(id);
    await this.kill(s);
    fs.rmSync(this.snapshotPath(id), { force: true });
    fs.rmSync(this.stylePath(id), { force: true });
    fs.rmSync(this.transcriptPath(id), { force: true });
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
  }
}
