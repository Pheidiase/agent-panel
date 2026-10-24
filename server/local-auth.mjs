import { LocalIdentity, cookieValue, validateLogin, ownerNameMatches } from "./local-identity.mjs";
import { AuthError } from "./json-store.mjs";
import { LoginLimits } from "./login-limits.mjs";
import { AuditLog } from "./audit.mjs";
import { clientIp } from "./client-ip.mjs";
import { loopbackHosts } from "./origins.mjs";

export function createLocalAuth({ state, app, port, grants = new Map(), limits = {}, trustProxyHeader = false }) {
  const identity = new LocalIdentity(state, grants), loginLimits = new LoginLimits(limits.now, limits.pause);
  const audit = new AuditLog(state), limited = new Map();
  const local = req => loopbackHosts(port).includes(req.headers.host);
  const name = (req, suffix = "auth") => (local(req) ? "" : "__Host-") + app + "_" + suffix;
  const cookie = (req, key, value, age) => `${key}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${local(req) ? "" : "; Secure"}`;
  const where = req => ({ ip: clientIp(req, { trustProxyHeader }), ua: req.headers["user-agent"] });
  const actor = g => g && { id: g.userId, username: g.username };
  async function login(req, data) {
    validateLogin(data);
    const ip = clientIp(req, { trustProxyHeader });
    let grant;
    try { grant = await loginLimits.run(ip, data.username, () => identity.login(data.username, data.password)); }
    catch (error) {
      let failedActor;
      if (error.status === 401) {
        try {
          const owner = identity.store.read();
          if (ownerNameMatches(owner, data.username)) failedActor = { id: owner.id, username: owner.username };
        } catch { /* Audit attribution must not change the login result. */ }
      }
      if (error.status !== 429) audit.record("login.fail", { ...where(req), actor: failedActor, reason: error.status === 401 ? "LOGIN_FAILED" : "AUTH_UNAVAILABLE" });
      else {
        const now = Date.now();
        for (const [key, until] of limited) if (until <= now) limited.delete(key);
        if (!limited.has(ip) && limited.size < 5000) {
          limited.set(ip, now + 60000); audit.record("login.limited", { ...where(req), reason: "LOGIN_LIMITED" });
        }
      }
      throw error;
    }
    // Failed reauthentication leaves the old session intact.
    const old = cookieValue(req, name(req));
    const revokedToken = old && old !== grant.token ? old : null;
    if (revokedToken) grants.delete(revokedToken);
    audit.record("login.ok", { ...where(req), actor: actor(grant) });
    return { grant, cookie: cookie(req, name(req), grant.token, identity.lifetime / 1000), revokedToken };
  }
  return {
    mode: "local", grants, login,
    metadata: () => ({ mode: "local", configured: !!identity.store.read() }),
    check: async token => identity.check(token),
    session: async req => identity.check(cookieValue(req, name(req))),
    start: req => ({ location: "/", cookie: cookie(req, name(req, "login"), "", 0) }),
    callback: async () => { throw new AuthError(400, "Yerel giriş ekranını kullanın.", "LOCAL_CALLBACK_DISABLED"); },
    logout: async (req, g) => {
      grants.delete(g.token); audit.record("logout", { ...where(req), actor: actor(g) });
      return cookie(req, name(req), "", 0);
    },
    portal: () => null,
  };
}
