import fs from "node:fs";
import path from "node:path";
import { PanelError } from "./session-store.mjs";

// Panel-owned presentation state for read-only history records: hidden flags
// and display titles, keyed by "agentId:sessionId". Source transcripts belong
// to Claude/Codex/Hermes and are never written here.
const KEY = /^[a-z]{2,20}:[A-Za-z0-9._-]{1,200}$/;
const TITLE_MAX = 80;
const HIDDEN_MAX = 5000;
const TITLES_MAX = 2000;
const CONTROL = /[\x00-\x1f\x7f]/;

function checkKey(key) {
  if (typeof key !== "string" || !KEY.test(key)) throw new PanelError(400, "Geçersiz kayıt.");
  return key;
}
function checkKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 200) throw new PanelError(400, "Geçersiz seçim.");
  return keys.map(checkKey);
}

export class HistoryPrefs {
  constructor(stateDir) {
    this.file = path.join(stateDir, "history-prefs.json");
    const raw = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
    this.hidden = new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter(k => KEY.test(k)));
    this.titles = new Map(
      Object.entries(raw.titles && typeof raw.titles === "object" ? raw.titles : {})
        .filter(([k, v]) => KEY.test(k) && typeof v === "string" && v.trim()),
    );
  }

  snapshot() {
    return { hidden: [...this.hidden], titles: Object.fromEntries(this.titles) };
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ hidden: [...this.hidden], titles: Object.fromEntries(this.titles) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  setHidden(body = {}) {
    const keys = checkKeys(body.keys);
    if (typeof body.hidden !== "boolean") throw new PanelError(400, "Geçersiz istek.");
    for (const key of keys) {
      if (body.hidden) {
        this.hidden.delete(key);
        this.hidden.add(key);
      } else this.hidden.delete(key);
    }
    // Bound growth: drop the oldest entries first.
    while (this.hidden.size > HIDDEN_MAX) this.hidden.delete(this.hidden.values().next().value);
    this.save();
    return this.snapshot();
  }

  // Drops presentation state for records that no longer exist.
  forget(keys) {
    let changed = false;
    for (const key of keys) {
      if (this.hidden.delete(key)) changed = true;
      if (this.titles.delete(key)) changed = true;
    }
    if (changed) this.save();
    return this.snapshot();
  }

  setTitle(body = {}) {
    const key = checkKey(body.key);
    const title = typeof body.title === "string" ? body.title.trim() : null;
    if (title === null || title.length > TITLE_MAX || CONTROL.test(title)) throw new PanelError(400, "Geçersiz ad.");
    if (title) {
      this.titles.delete(key);
      this.titles.set(key, title);
    } else this.titles.delete(key);
    while (this.titles.size > TITLES_MAX) this.titles.delete(this.titles.keys().next().value);
    this.save();
    return this.snapshot();
  }
}
