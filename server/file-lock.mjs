import fs from "node:fs";
import crypto from "node:crypto";
import { PanelError } from "./session-store.mjs";

const busy = () => new PanelError(409, "Uygulama kaydı yazılıyor. Biraz sonra tekrar dene.");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function deadOwner(file) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; }
    catch (e) { return e.code === "ESRCH"; }
  } catch { return false; }
}

// Hard-link acquisition publishes the complete owner record atomically.
// A per-inode recovery guard prevents two reclaimers from unlinking a new lock.
export function fileLock(file) {
  const candidate = `${file}.${crypto.randomUUID()}.owner`;
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  const identity = fs.statSync(candidate);
  try {
    try { fs.linkSync(candidate, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const old = fs.lstatSync(file);
      if (!old.isFile() || !deadOwner(file)) throw busy();
      const guard = `${file}.recover-${old.dev}-${old.ino}`;
      const releaseGuard = fileLock(guard);
      try {
        if (!same(old, fs.lstatSync(file)) || !deadOwner(file)) throw busy();
        fs.unlinkSync(file);
        try { fs.linkSync(candidate, file); }
        catch (e) { if (e.code === "EEXIST") throw busy(); throw e; }
      } finally { releaseGuard(); }
    }
  } finally { fs.unlinkSync(candidate); }
  return () => {
    try { if (same(identity, fs.lstatSync(file))) fs.unlinkSync(file); }
    catch { /* Never mask the protected operation's error. */ }
  };
}
