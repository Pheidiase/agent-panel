import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export class AuthError extends Error {
  constructor(status, message, code = "AUTH_UNAVAILABLE") { super(message); this.status = status; this.code = code; }
}
export function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + crypto.randomBytes(32).toString("base64url") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx", flush: true });
    fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); syncDir(path.dirname(file));
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
// Persist the rename itself; platforms that cannot fsync a directory are ignored.
export function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
  catch (e) { if (!["EINVAL", "EISDIR", "EPERM", "ENOTSUP", "EBADF", "EACCES"].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw Object.assign(new AuthError(503, `${label}: ${e.code === "ENOENT" ? "dosya eksik" : e instanceof SyntaxError ? "JSON bozuk" : "okunamadı"}.`), { code: e.code === "ENOENT" ? "CONFIG_MISSING" : "CONFIG_INVALID" }); }
}
