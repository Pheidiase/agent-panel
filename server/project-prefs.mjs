import fs from "node:fs";
import path from "node:path";
import { PanelError } from "./session-store.mjs";

// Panel-owned presentation state: project ids the owner does not want in the
// pickers. Hiding never touches the project folder or its sessions.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const MAX = 500;

export class ProjectPrefs {
  constructor(stateDir) {
    this.file = path.join(stateDir, "project-prefs.json");
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    this.hidden = new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((k) => typeof k === "string" && ID.test(k) && k !== "general"));
  }

  snapshot() {
    return { hidden: [...this.hidden] };
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Replaces the whole hidden list ("general" can never be hidden).
  setHidden(body = {}) {
    const list = body.hidden;
    if (!Array.isArray(list) || list.length > MAX || !list.every((k) => typeof k === "string" && ID.test(k))) {
      throw new PanelError(400, "Geçersiz istek.");
    }
    this.hidden = new Set(list.filter((k) => k !== "general"));
    this.save();
    return this.snapshot();
  }
}
