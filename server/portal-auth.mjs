// Host-only application sessions, issued by the portal after a single-use code exchange.
// Each request checks the central account and current project permissions; no offline fallback.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { clientIp } from "./client-ip.mjs";
import { loopbackHosts } from "./origins.mjs";

// Fixed-window counter per client key; bounded so it cannot grow without limit.
export function createLimiter({ max, windowMs, now = Date.now, maxKeys = 5000 }) {
  const hits = new Map();
  return key => {
    const t = now();
    let h = hits.get(key);
    if (!h || h.until <= t) {
      if (!h && hits.size >= maxKeys) for (const [k, v] of hits) if (v.until <= t) hits.delete(k);
      if (!h && hits.size >= maxKeys) return false;
      h = { n: 0, until: t + windowMs }; hits.set(key, h);
    }
    return ++h.n <= max;
  };
}
export function createPortalAuth({ state, app, port, grants = new Map(), limits = {}, trustProxyHeader = false }) {
  const clientKey = req => clientIp(req, { trustProxyHeader });
  const tooMany = () => Object.assign(new Error("Çok fazla deneme. Biraz bekleyip tekrar dene."), { status: 429, code: "LOGIN_LIMITED", retryAfter: 60 });
  // Unknown tokens and new login handshakes are the only anonymous work that
  // costs the portal a call or a `pending` slot, so they are rate limited.
  const unknownTokenLimit = createLimiter({ max: limits.unknownTokens ?? 30, windowMs: 60000 });
  const startLimit = createLimiter({ max: limits.starts ?? 20, windowMs: 60000 });
  const readConfig = () => {
    const c = JSON.parse(fs.readFileSync(path.join(state, "auth-client.json"), "utf8"));
    const internal = new URL(c.portalInternal), portal = new URL(c.portalOrigin), origin = new URL(c.publicOrigin);
    if (c.app !== app || !/^[\w-]{43}$/.test(c.key) || internal.hostname !== "127.0.0.1" || internal.protocol !== "http:"
      || ![portal, origin].every(u => !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1"))))
      throw new Error("Invalid portal client configuration");
    return c;
  };
  const pending = new Map();
  setInterval(() => {
    for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
    for (const [key, value] of grants) if (value.expires <= Date.now()) grants.delete(key);
  }, 60000).unref();
  const local = req => loopbackHosts(port).includes(req.headers.host);
  const name = req => (local(req) ? "" : "__Host-") + app + "_auth";
  const cookieValue = (req, key) => {
    const values = (req.headers.cookie || "").split(";").map(s => s.trim()).filter(s => s.startsWith(key + "="));
    return values.length === 1 && /^[\w-]{43}$/.test(values[0].slice(key.length + 1)) ? values[0].slice(key.length + 1) : null;
  };
  const cookie = (req, key, value, age) => `${key}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${local(req) ? "" : "; Secure"}`;
  const stateName = req => (local(req) ? "" : "__Host-") + app + "_login";
  async function call(route, body) {
    try {
      const c = readConfig();
      const res = await fetch(new URL(route, c.portalInternal), { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "X-App-Key": c.key },
        body: JSON.stringify({ ...body, app }), signal: AbortSignal.timeout(2500) });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error("Portal unavailable");
      return await res.json();
    } catch { throw Object.assign(new Error("Giriş servisine ulaşılamıyor. Biraz sonra tekrar dene."), { status: 503, code: "AUTH_UNAVAILABLE" }); }
  }
  const checking = new Map();
  async function check(token) {
    if (!token) return null;
    if (checking.has(token)) return checking.get(token);
    // Unknown cookies may occupy only half the slots; known owner sessions
    // still revalidate with the portal even during anonymous request bursts.
    if (checking.size >= 16 || (!grants.has(token) && [...checking.keys()].filter(key => !grants.has(key)).length >= 8)) throw Object.assign(new Error("Giriş doğrulaması yoğun. Biraz sonra tekrar dene."), { status: 503, code: "AUTH_CHECK_BUSY" });
    const work = (async () => {
      const fresh = await call("/internal/session", { token });
      if (!fresh || (app === "panel" && !fresh.owner)) { grants.delete(token); return null; }
      const g = grants.get(token) || {};
      Object.assign(g, fresh); grants.set(token, g); return g;
    })();
    checking.set(token, work);
    try { return await work; } finally { checking.delete(token); }
  }
  const portal = () => readConfig().portalOrigin;
  function start(req) {
    const c = readConfig();
    const existing = cookieValue(req, stateName(req));
    const reusable = existing && pending.get(existing)?.expires > Date.now();
    const nonce = reusable ? existing : crypto.randomBytes(32).toString("base64url");
    for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
    if (!reusable && !startLimit(clientKey(req))) throw tooMany();
    if (!reusable && pending.size >= 2000)
      throw Object.assign(new Error("Giriş yoğun. Biraz sonra tekrar dene."), { status: 503, code: "AUTH_BUSY" });
    // A relative, same-origin path only; callback and API URLs never become destinations.
    const u = new URL(req.url, "http://localhost");
    const returnPath = !u.pathname.startsWith("/auth/") && !u.pathname.startsWith("/api/") ? u.pathname + u.search : "/";
    if (!reusable) pending.set(nonce, { returnPath: returnPath.startsWith("//") ? "/" : returnPath, expires: Date.now() + 120000 });
    const url = new URL("/authorize", c.portalOrigin);
    url.searchParams.set("app", app); url.searchParams.set("state", nonce);
    return { location: url.href, cookie: cookie(req, stateName(req), nonce, 120) };
  }
  async function callback(req, url) {
    const nonce = url.searchParams.get("state"), record = pending.get(nonce);
    if (!nonce || nonce !== cookieValue(req, stateName(req)) || !record || record.expires <= Date.now())
      throw Object.assign(new Error("Giriş isteği geçersiz veya süresi dolmuş. Ana sayfadan tekrar giriş yap."), { status: 400, code: "AUTH_CALLBACK_INVALID" });
    pending.delete(nonce);
    const g = await call("/internal/exchange", { code: url.searchParams.get("code"), state: nonce });
    if (!g || (app === "panel" && !g.owner)) throw Object.assign(new Error("Bu projeye erişim iznin yok."), { status: 403, code: "ACCESS_DENIED" });
    grants.set(g.token, g);
    return { location: record.returnPath, cookies: [cookie(req, name(req), g.token, Math.max(0, Math.floor((g.expires - Date.now()) / 1000))), cookie(req, stateName(req), "", 0)] };
  }
  async function logout(req, g) {
    await call("/internal/logout", { token: g.token });
    grants.delete(g.token); return cookie(req, name(req), "", 0);
  }
  return { check, session: req => {
    const token = cookieValue(req, name(req));
    if (token && !grants.has(token) && !unknownTokenLimit(clientKey(req))) throw tooMany();
    return check(token);
  }, start, callback, logout, portal, grants };
}
