// Panel-owned SSO contract double: ephemeral accounts, no sibling repositories.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const random = () => crypto.randomBytes(32).toString("base64url");
export async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function waitServer(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}
export async function fixturePortal({ password, username = "tester", panelState, panelBase }) {
  const key = random(), owners = new Set(), codes = new Map(), sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/api/health") return json(200, { ok: true });
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 65536) return json(413, {}); }
    let data = {}; try { data = JSON.parse(body || "{}"); } catch { return json(400, {}); }
    if (url.pathname === "/api/login" && req.method === "POST") {
      if (data.username !== username || data.password !== password) return json(401, {});
      const token = random(); owners.add(token);
      res.setHeader("Set-Cookie", `fixture_owner=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return json(200, { username, owner: true });
    }
    if (url.pathname === "/authorize") {
      const token = /(?:^|;\s*)fixture_owner=([\w-]+)/.exec(req.headers.cookie || "")?.[1];
      if (!owners.has(token) || url.searchParams.get("app") !== "panel") return json(403, {});
      const code = random(), state = url.searchParams.get("state");
      codes.set(code, { state, expires: Date.now() + 120000 });
      const callback = new URL("/auth/callback", panelBase);
      callback.searchParams.set("state", state); callback.searchParams.set("code", code);
      res.writeHead(302, { Location: callback.href }); return res.end();
    }
    if (!url.pathname.startsWith("/internal/")) return json(404, {});
    if (req.headers["x-app-key"] !== key || data.app !== "panel") return json(403, {});
    if (url.pathname === "/internal/exchange") {
      const record = codes.get(data.code); codes.delete(data.code);
      if (!record || record.state !== data.state || record.expires <= Date.now()) return json(401, {});
      const grant = { token: random(), csrf: random(), owner: true, username, userId: "fixture-owner", expires: Date.now() + 3600000 };
      sessions.set(grant.token, grant); return json(200, grant);
    }
    if (url.pathname === "/internal/session") {
      const grant = sessions.get(data.token);
      return grant && grant.expires > Date.now() ? json(200, grant) : json(401, {});
    }
    if (url.pathname === "/internal/logout") { sessions.delete(data.token); return json(200, { ok: true }); }
    return json(404, {});
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(panelState, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(panelState, "auth-client.json"), JSON.stringify({ app: "panel", key, portalInternal: base, portalOrigin: base, publicOrigin: panelBase }), { mode: 0o600 });
  return { base, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
export async function portalLogin(portal, username, password) {
  const res = await fetch(portal + "/api/login", { method: "POST", headers: { Origin: portal, "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error(`Portal fixture login failed: ${res.status}`);
  return { cookie: res.headers.getSetCookie()[0].split(";")[0], ...await res.json() };
}
export async function appLogin(base, _portal, owner) {
  const start = await fetch(base + "/", { redirect: "manual" });
  const authorize = await fetch(start.headers.get("location"), { redirect: "manual", headers: { Cookie: owner.cookie } });
  const callback = await fetch(authorize.headers.get("location"), { redirect: "manual", headers: { Cookie: start.headers.getSetCookie()[0].split(";")[0] } });
  if (callback.status !== 302) throw new Error(`SSO callback failed: ${callback.status}`);
  const header = callback.headers.getSetCookie()[0], cookie = header.split(";")[0];
  const me = await (await fetch(base + "/api/me", { headers: { Cookie: cookie } })).json();
  return { cookie, header, ...me };
}
