import crypto from "node:crypto";
import { AuthError } from "./json-store.mjs";
import { OwnerStore } from "./owner-store.mjs";
import { CURRENT_SCRYPT, passwordProfile, derivePassword, passwordRecord } from "./passwords.mjs";

const RETRY = Symbol("retry-login");
const random = () => crypto.randomBytes(32).toString("base64url");
const denied = () => new AuthError(401, "Kullanıcı adı veya parola hatalı.", "LOGIN_FAILED");
export const ownerNameMatches = (owner, username) => !!owner &&
  owner.username.toLocaleLowerCase("en-US") === username.trim().toLocaleLowerCase("en-US");
export function cookieValue(req, name) {
  const values = (req.headers.cookie || "").split(";").map(x => x.trim())
    .filter(x => x.startsWith(name + "=")).map(x => x.slice(name.length + 1));
  return values.length === 1 && /^[\w-]{43}$/.test(values[0]) ? values[0] : null;
}
export function validateLogin(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.username !== "string" || !data.username.length || data.username.length > 100 ||
      typeof data.password !== "string" || data.password.length > 200 ||
      Object.keys(data).some(k => !["username", "password"].includes(k)))
    throw new AuthError(400, "Giriş bilgilerini kontrol et.", "LOGIN_INVALID");
}
export class LocalIdentity {
  constructor(state, grants = new Map(), { now = Date.now, derive = derivePassword, record = passwordRecord } = {}) {
    this.store = new OwnerStore(state); this.grants = grants; this.now = now;
    this.derive = derive; this.record = record;
    this.lifetime = 8 * 3600000; this.dummySalt = crypto.randomBytes(16).toString("hex");
  }
  check(token) {
    if (typeof token !== "string" || !/^[\w-]{43}$/.test(token)) return null;
    const g = this.grants.get(token);
    if (!g) return null;
    if (g.expires <= this.now()) { this.grants.delete(token); return null; }
    let u;
    try { u = this.store.read(); } catch (error) { this.grants.delete(token); throw error; }
    if (!u || u.id !== g.userId || u.authVersion !== g.authVersion || !u.owner || !u.enabled) {
      this.grants.delete(token); return null;
    }
    return g;
  }
  async login(username, password, retried = false) {
    validateLogin({ username, password });
    const owner = this.store.read();
    if (!owner) throw new AuthError(503, "Önce sunucuda npm run set-password çalıştırın.", "AUTH_NOT_CONFIGURED");
    const u = ownerNameMatches(owner, username) ? owner : null;
    const profile = passwordProfile(owner);
    const hash = await this.derive(password, u?.salt || this.dummySalt, profile);
    const expected = u ? Buffer.from(u.hash, "hex") : Buffer.alloc(64);
    if (!u || hash.length !== expected.length || !crypto.timingSafeEqual(hash, expected)) throw denied();
    const upgraded = profile.version !== CURRENT_SCRYPT.version ? await this.record(password) : null;
    const result = this.store.transaction(() => {
      const current = this.store.read();
      if (!current || current.id !== u.id || current.authVersion !== u.authVersion) throw denied();
      if (current.salt !== u.salt || current.hash !== u.hash || JSON.stringify(current.scrypt) !== JSON.stringify(u.scrypt)) {
        if (retried) throw denied();
        return RETRY;
      }
      if (upgraded) { Object.assign(current, upgraded); this.store.write(current); }
      for (const [token, g] of this.grants) if (g.expires <= this.now()) this.grants.delete(token);
      const own = [...this.grants].filter(([, g]) => g.userId === u.id);
      for (const [token] of own.slice(0, Math.max(0, own.length - 7))) this.grants.delete(token);
      const token = random();
      const g = { token, csrf: random(), expires: this.now() + this.lifetime, username: current.username,
        userId: current.id, owner: true, app: "panel", authVersion: current.authVersion };
      this.grants.set(token, g); return g;
    });
    return result === RETRY ? this.login(username, password, true) : result;
  }
}
