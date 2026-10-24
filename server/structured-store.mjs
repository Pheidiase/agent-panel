// Structured (ACP chat) session records and their append-only event log.
// The terminal sessions live in session-store.mjs; this store mirrors its
// validation and atomic-save conventions but carries a JSONL event log per
// session instead of a tmux pane. Everything is bounded: records, the log
// file (oldest half dropped line-aligned), and reads (bounded tail or pages).
import fs from "node:fs";
import path from "node:path";
import { PanelError } from "./session-store.mjs";
import { noteSignal } from "./attention.mjs";

export const STRUCTURED_RECORD_LIMIT = 50;
export const EVENT_LOG_LIMIT = 8 * 1024 * 1024;
export const EVENT_LOG_KEEP = 4 * 1024 * 1024;
export const EVENT_READ_TAIL = 1024 * 1024;
export const EVENT_READ_MAX = 3000;
export const EVENT_MAX_BYTES = 256 * 1024;

export class StructuredStore {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, "structured.json");
    this.records = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : [];
    this.serial = Promise.resolve();
    this.pendingCreates = new Map();
    this.sequences = new Map();
    this.logWriters = new Map();
    this.deletedIds = new Set();
    // Latest attention markers are rebuilt from retained events on startup.
    this.signals = new Map();
    this.runtimeMaps = new Set();
    for (const record of this.records) {
      let after = 0;
      for (;;) {
        const page = this.readEvents(record.id, { after, page: true });
        for (const event of page.events) noteSignal(this.signals, record.id, event);
        if (!page.hasMore) break;
        after = page.lastSeq;
      }
    }
  }

  assertRunningCapacity(id) {
    const active = new Set();
    for (const map of this.runtimeMaps) for (const [key, runtime] of map)
      if (key !== id && (runtime.conn?.alive || runtime.status === "starting")) active.add(key);
    if (active.size >= 4) throw new PanelError(409, "Aynı anda en fazla 4 sohbet bağlı olabilir.");
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  enqueue(operation) {
    const work = this.serial.then(operation);
    this.serial = work.catch(() => {});
    return work;
  }

  enqueueCreate(key, operation) {
    if (this.pendingCreates.has(key)) return this.pendingCreates.get(key);
    const work = Promise.resolve().then(operation).finally(() => {
      this.pendingCreates.delete(key);
    });
    this.pendingCreates.set(key, work);
    return work;
  }

  logPath(id) {
    return path.join(this.stateDir, `structured-${id}.jsonl`);
  }

  stderrPath(id) {
    return path.join(this.stateDir, `structured-${id}.stderr.log`);
  }

  list() {
    return this.records.map((r) => ({ ...r, kind: "structured" }));
  }

  has(id) {
    return this.records.some((r) => r.id === id);
  }

  get(id) {
    const s = this.records.find((r) => r.id === id);
    if (!s) throw new PanelError(404, "Oturum bulunamadı.");
    return s;
  }

  findByIdempotencyKey(requestId) {
    return this.records.find((r) => r.requestId === requestId) || null;
  }

  add(record) {
    this.records.unshift(record);
    try {
      this.save();
    } catch (error) {
      this.records = this.records.filter((r) => r !== record);
      throw error;
    }
    return record;
  }

  update(id, changes) {
    return this.enqueue(() => {
      const s = this.get(id);
      if (
        !changes ||
        typeof changes !== "object" ||
        Array.isArray(changes) ||
        Object.keys(changes).some(
          (k) => !["title", "archived", "pinned", "opened"].includes(k),
        )
      )
        throw new PanelError(400, "Geçersiz oturum işlemi.");
      if (
        "title" in changes &&
        (typeof changes.title !== "string" ||
          !changes.title.trim() ||
          changes.title.length > 80 ||
          /[\x00-\x1f\x7f]/.test(changes.title))
      )
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

  remove(id) {
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
    this.deletedIds.add(id);
  }

  removeFiles(id) {
    this.closeLog(id);
    this.sequences.delete(id);
    this.signals.delete(id);
    fs.rmSync(this.logPath(id), { force: true });
    fs.rmSync(this.stderrPath(id), { force: true });
  }

  closeLog(id) {
    const writer = this.logWriters.get(id);
    if (!writer) return;
    this.logWriters.delete(id);
    fs.closeSync(writer.fd);
  }

  closeLogs() {
    for (const id of this.logWriters.keys()) this.closeLog(id);
  }

  logWriter(id) {
    let writer = this.logWriters.get(id);
    if (writer) {
      this.logWriters.delete(id);
    } else {
      // Bound descriptors even when callers append without a session record.
      if (this.logWriters.size >= STRUCTURED_RECORD_LIMIT)
        this.closeLog(this.logWriters.keys().next().value);
      const fd = fs.openSync(this.logPath(id), "a+", 0o600);
      try { writer = { fd, size: fs.fstatSync(fd).size }; }
      catch (error) { fs.closeSync(fd); throw error; }
    }
    this.logWriters.set(id, writer);
    return writer;
  }

  nextSeq(id) {
    if (this.sequences.has(id)) return this.sequences.get(id);
    let last = 0;
    try {
      const size = fs.statSync(this.logPath(id)).size;
      if (size > 0) {
        // The window must exceed the largest single event (capped in
        // shrinkEvent below 256 KiB) or the last line cannot be parsed.
        const read = Math.min(size, 1024 * 1024);
        const handle = fs.openSync(this.logPath(id), "r");
        const buffer = Buffer.alloc(read);
        try { fs.readSync(handle, buffer, 0, read, size - read); }
        finally { fs.closeSync(handle); }
        // Preserve a torn record for diagnosis, but isolate it from the next
        // event. A complete JSON record without its final newline is kept too.
        if (buffer[read - 1] !== 0x0a)
          fs.appendFileSync(this.logPath(id), "\n");
        const lines = buffer.toString("utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const value = JSON.parse(lines[i]);
            if (Number.isInteger(value.seq)) {
              last = value.seq;
              break;
            }
          } catch {
            /* keep scanning upward */
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.sequences.set(id, last);
    return last;
  }

  // Appends one normalized event; assigns seq and t; broadcasts the stored
  // value so viewers and the log can never disagree. Oversized single events
  // are shrunk before they reach the file.
  appendEvent(id, event) {
    if (this.deletedIds.has(id)) throw new PanelError(404, "Oturum silinmiş.");
    const seq = this.nextSeq(id) + 1;
    const stored = { ...shrinkEvent(event), seq, t: new Date().toISOString() };
    const line = JSON.stringify(stored) + "\n";
    try {
      const writer = this.logWriter(id);
      // Keep the descriptor open, but finish the write before returning or
      // broadcasting. Errors still reach the caller; no unbounded queue.
      fs.appendFileSync(writer.fd, line);
      writer.size += Buffer.byteLength(line);
      this.sequences.set(id, seq);
      if (writer.size > EVENT_LOG_LIMIT) this.trimLog(id);
    } catch (error) {
      // A failed write can itself leave a partial line; recheck on retry.
      this.closeLog(id);
      this.sequences.delete(id);
      throw error;
    }
    noteSignal(this.signals, id, stored);
    return stored;
  }

  trimLog(id) {
    const file = this.logPath(id);
    const writer = this.logWriters.get(id);
    const size = writer ? writer.size : fs.statSync(file).size;
    if (size <= EVENT_LOG_LIMIT) return;
    const handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(EVENT_LOG_KEEP);
    try { fs.readSync(handle, buffer, 0, EVENT_LOG_KEEP, size - EVENT_LOG_KEEP); }
    finally { fs.closeSync(handle); }
    const cut = buffer.indexOf(0x0a);
    const kept = cut >= 0 ? buffer.subarray(cut + 1) : buffer;
    fs.writeFileSync(file, kept, { mode: 0o600 });
    if (writer) writer.size = kept.length;
  }

  trimAll() {
    for (const record of this.records) {
      try {
        this.trimLog(record.id);
      } catch {
        this.closeLog(record.id);
        this.sequences.delete(record.id);
        /* A missing log is fine. */
      }
    }
  }

  // The legacy tail read remains available; page=true replays the retained
  // log forwards from `after`. Only actual gaps/damage mark a page truncated.
  readEvents(id, { after = 0, max = EVENT_READ_MAX, page = false } = {}) {
    const file = this.logPath(id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { events: [], lastSeq: after, truncated: false };
    }
    if (size === 0) return { events: [], lastSeq: after, truncated: false };
    const read = Math.min(size, page ? EVENT_LOG_LIMIT : EVENT_READ_TAIL);
    const handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(read);
    try { fs.readSync(handle, buffer, 0, read, size - read); }
    finally { fs.closeSync(handle); }
    let text = buffer.toString("utf8");
    if (read < size) {
      const cut = text.indexOf("\n");
      text = cut >= 0 ? text.slice(cut + 1) : "";
    }
    const events = [];
    let damaged = false;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        if (Number.isInteger(value.seq) && value.seq > after) events.push(value);
      } catch {
        damaged = true;
      }
    }
    const truncated = read < size && events.length > 0 && events[0].seq > after + 1;
    if (page) {
      // Replay forward through the entire retained log. Raw chunk count and
      // transport page size must never decide which part of a reply survives.
      let bytes = 0;
      const selected = [];
      for (const event of events) {
        const length = Buffer.byteLength(JSON.stringify(event));
        if (selected.length && (selected.length >= max || bytes + length > EVENT_READ_TAIL / 2)) break;
        selected.push(event);
        bytes += length;
      }
      return {
        events: selected,
        lastSeq: selected.at(-1)?.seq ?? after,
        hasMore: selected.length < events.length,
        truncated: damaged || (selected.length > 0 && selected[0].seq > after + 1),
      };
    }
    const lastSeq = events.length ? events[events.length - 1].seq : after;
    return {
      events: events.length > max ? events.slice(-max) : events,
      lastSeq,
      truncated: damaged || truncated || events.length > max,
    };
  }
}

// Keeps a single event within a sane size: tool results are already trimmed
// upstream, but a hostile or oversized frame must not enter the log whole.
function shrinkEvent(event) {
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line) <= EVENT_MAX_BYTES - 512) return event;
  if (event.kind === "approval") {
    const copy = {
      kind: event.kind, requestId: event.requestId, status: event.status,
      options: event.options, questions: event.questions,
      expiresAt: event.expiresAt, optionId: event.optionId, truncated: true,
      toolCall: event.toolCall ? {
        toolCallId: event.toolCall.toolCallId,
        title: String(event.toolCall.title ?? "").slice(0, 2000),
        rawInput: { command: String(event.toolCall.rawInput?.command ?? "").slice(0, 8000) },
      } : null,
    };
    if (Buffer.byteLength(JSON.stringify(copy)) > EVENT_MAX_BYTES - 512)
      throw new PanelError(503, "Onay isteği güvenli biçimde gösterilemeyecek kadar büyük; istek reddedildi.");
    return copy;
  }
  const copy = { ...event };
  copy.truncated = true;
  for (const key of ["text", "title", "detail"]) {
    if (typeof copy[key] === "string")
      copy[key] = copy[key].slice(0, 120 * 1024) + "…";
  }
  if (copy.data) {
    copy.data = {
      truncated: true,
      title: copy.data.title,
      kind: copy.data.kind,
      status: copy.data.status,
    };
  }
  if (copy.patch) {
    copy.patch = {
      truncated: true,
      status: copy.patch.status,
      title: copy.patch.title,
      kind: copy.patch.kind,
    };
  }
  if (Array.isArray(copy.entries)) {
    copy.entries = copy.entries.slice(0, 100).map((entry) => ({
      content: String(entry?.content || "").slice(0, 500),
      status: entry?.status,
      priority: entry?.priority,
    }));
  }
  if (Array.isArray(copy.commands)) copy.commands = copy.commands.slice(0, 100);
  const check = JSON.stringify(copy);
  if (Buffer.byteLength(check) > EVENT_MAX_BYTES - 512) {
    return { kind: String(event.kind || "unknown").slice(0, 100), truncated: true };
  }
  return copy;
}
