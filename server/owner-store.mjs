import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AuthError, privateJson, readJson } from "./json-store.mjs";
import { passwordProfile } from "./passwords.mjs";
import { validateOwnerName, withUserLock } from "./user-lock.mjs";

const fail = () => { throw new AuthError(503, "Sahip kaydı okunamadı.", "AUTH_INVALID"); };
export function validateCredential(c) {
  try { validateOwnerName(c?.username); passwordProfile(c); } catch { fail(); }
  if (typeof c.salt !== "string" || !/^[a-f0-9]{32}$/.test(c.salt) ||
      typeof c.hash !== "string" || !/^[a-f0-9]{128}$/.test(c.hash)) fail();
  return c;
}
export function validateOwnerRecord(u) {
  validateCredential(u);
  const fields = new Set(["version", "id", "username", "owner", "enabled", "salt", "hash", "scrypt", "authVersion", "createdAt"]);
  if (Object.keys(u).some(k => !fields.has(k)) || u.version !== 1 || u.owner !== true || u.enabled !== true ||
      typeof u.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(u.id) ||
      !Number.isSafeInteger(u.authVersion) || u.authVersion < 1 || typeof u.createdAt !== "string" ||
      !Number.isFinite(Date.parse(u.createdAt)) || new Date(u.createdAt).toISOString() !== u.createdAt) fail();
  return u;
}
export function privateState(state) {
  const stat = fs.lstatSync(state);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail();
}
export class OwnerStore {
  constructor(state) { this.state = state; this.file = path.join(state, "owner.json"); }
  read() {
    try {
      privateState(this.state);
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail();
    } catch (e) {
      if (e.code === "ENOENT") return null;
      if (e instanceof AuthError) throw e;
      fail();
    }
    return validateOwnerRecord(readJson(this.file, "Sahip kaydı"));
  }
  write(record) { privateState(this.state); privateJson(this.file, validateOwnerRecord(record)); }
  transaction(commit) {
    fs.mkdirSync(this.state, { recursive: true, mode: 0o700 });
    privateState(this.state);
    return withUserLock(this.state, commit);
  }
  setOwnerCredential(c, { preserveName = false } = {}) {
    validateCredential(preserveName ? { ...c, username: "owner" } : c);
    return this.transaction(() => {
      const old = this.read();
      if (preserveName && !old) fail();
      if (old?.authVersion === Number.MAX_SAFE_INTEGER) fail();
      const owner = old || { version: 1, id: crypto.randomUUID(), owner: true, enabled: true,
        authVersion: 0, createdAt: new Date().toISOString() };
      Object.assign(owner, c, { username: preserveName ? old.username : c.username, authVersion: owner.authVersion + 1 });
      if (!c.scrypt) delete owner.scrypt;
      this.write(owner);
      return owner;
    });
  }
}
