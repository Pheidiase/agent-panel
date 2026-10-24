import fs from "node:fs";
import path from "node:path";
import { withUserLock } from "./user-lock.mjs";
import { privateState } from "./owner-store.mjs";

// Copied from the portal; CLI and web rotation share a separate writer lock.
const TYPES = new Set(["login.ok", "login.fail", "login.limited", "logout", "owner.password.change"]);
const REASONS = new Set(["LOGIN_FAILED", "LOGIN_LIMITED", "AUTH_UNAVAILABLE", "LOGIN_INVALID"]);
const text = (v, max) => typeof v === "string" ? v.slice(0, max) : undefined;
function clean(f) {
  return { actor: f.actor && typeof f.actor.id === "string" ? { id: text(f.actor.id, 64), username: text(f.actor.username, 100) } : undefined,
    ip: text(f.ip, 64), ua: text(f.ua, 200), reason: REASONS.has(f.reason) ? f.reason : undefined,
    changes: f.changes?.password === true ? { password: true } : undefined };
}
export class AuditLog {
  constructor(state, { maxBytes = 1 << 20, now = () => new Date() } = {}) {
    this.state = state; this.file = path.join(state, "audit.jsonl"); this.old = path.join(state, "audit.1.jsonl");
    this.maxBytes = maxBytes; this.now = now; this.warned = false;
  }
  warn() {
    if (!this.warned) { this.warned = true; console.error("Denetim günlüğüne erişilemiyor."); }
  }
  record(type, fields = {}) {
    if (!TYPES.has(type)) throw new Error("Unknown audit type");
    try {
      fs.mkdirSync(this.state, { recursive: true, mode: 0o700 }); privateState(this.state);
      withUserLock(this.state, () => {
        const line = JSON.stringify({ t: this.now().toISOString(), type, ...clean(fields) }) + "\n";
        if (Buffer.byteLength(line) > this.maxBytes) return;
        let size = 0;
        for (const file of [this.file, this.old]) {
          try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid audit file");
            if (file === this.file) size = stat.size;
          } catch (e) { if (e.code !== "ENOENT") throw e; }
        }
        if (size && size + Buffer.byteLength(line) > this.maxBytes) fs.renameSync(this.file, this.old);
        fs.appendFileSync(this.file, line, { mode: 0o600, flush: true });
      }, "audit.jsonl.lock");
    } catch { this.warn(); }
  }
  read(limit = 300) {
    const events = [];
    for (const file of [this.file, this.old]) {
      let lines;
      try { lines = fs.readFileSync(file, "utf8").split("\n"); }
      catch (e) { if (e.code !== "ENOENT") this.warn(); continue; }
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        if (!lines[i]) continue;
        try { const e = JSON.parse(lines[i]); if (TYPES.has(e?.type) && typeof e.t === "string") events.push(e); } catch {}
      }
      if (events.length >= limit) break;
    }
    return events;
  }
}
