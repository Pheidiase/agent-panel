import fs from "node:fs";
import path from "node:path";

// All owner.json writers share this lock. Callbacks are synchronous: hash first,
// then acquire, reread, validate and commit without yielding the event loop.
export function withUserLock(state, commit, name = "owner.json.lock") {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = path.join(state, name);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("Kullanıcı kaydı güncelleniyor. Tekrar dene."), { status: 503, code: "AUTH_BUSY" });
    throw error;
  }
  try { return commit(); } finally { fs.rmdirSync(lock); }
}

export function validateOwnerName(username) {
  if (typeof username !== "string" || !username || username !== username.trim() || username.length > 100 || /[\u0000-\u001f\u007f]/.test(username))
    throw new Error("Kullanıcı adı 1–100 karakter olmalı; çevresinde boşluk veya kontrol karakteri olmamalı.");
  return username;
}
