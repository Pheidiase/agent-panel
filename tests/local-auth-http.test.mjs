import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import express from "express";
import { AuditLog } from "../server/audit.mjs";
import { mountAuthRoutes, authFailure, publicGrant, anonymousAsset } from "../server/auth-http.mjs";
import { createAuth } from "../server/auth.mjs";
import { hostAllowed, originAllowed, readOrigins } from "../server/origins.mjs";
import { localFixture, tempState, request } from "./fixtures/local-auth-fixture.mjs";
import { requestApp } from "./fixtures/http-memory.mjs";

export function httpFixture(t, { configured = true } = {}) {
  const { state, password } = configured ? localFixture(t) : { state: tempState(t) };
  const provider = createAuth({ state, app: "panel", port: 4317, limits: { pause: async () => {} } }), app = express();
  const origins = readOrigins({ state, port: 4317 });
  const originOK = req => originAllowed(origins, req.headers.host, req.headers.origin);
  const tickets = new Map(), wss = { clients: new Set() };
  const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const revokeConnections = new Function("tickets", "wss", index.slice(index.indexOf("function revokeConnections("), index.indexOf("function originList(")) + "; return revokeConnections;")(tickets, wss);
  app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); if (!hostAllowed(origins, req.headers.host)) return res.sendStatus(403); next(); });
  // Use the server's route wiring and cleanup without starting agents or a listener.
  new Function("mountAuthRoutes", "app", "portalAuth", "originOK", "revokeConnections", index.match(/^mountAuthRoutes\(.*$/m)[0])(mountAuthRoutes, app, provider, originOK, revokeConnections);
  app.use(express.json({ limit: "64kb", inflate: false }));
  const auth = async (req, res, next) => { try { req.panelGrant = await provider.session(req); if (!req.panelGrant) return res.sendStatus(401); next(); } catch (e) { next(e); } };
  // The actual Panel mutation middleware, including constant-time CSRF comparison.
  const mutation = new Function("originOK", "crypto", index.slice(index.indexOf("function mutation("), index.indexOf("function send(")) + "; return mutation;")(originOK, crypto);
  app.get("/api/me", auth, (req, res) => res.json(publicGrant(req.panelGrant)));
  new Function("app", "auth", "mutation", "portalAuth", "revokeConnections", index.slice(index.indexOf('app.post("/api/logout"'), index.indexOf('app.get("/api/catalog"')))(app, auth, mutation, provider, revokeConnections);
  app.post("/api/action", auth, mutation, (_req, res) => res.json({ ok: true }));
  app.get("/api/private", auth, (_req, res) => res.json({ private: true }));
  app.use(authFailure);
  app.use((err, _req, res, _next) => res.status(503).json({ error: "unavailable" }));
  const call = (path, data = {}) => requestApp(app, { path, ...data });
  const login = (data = { username: "synthetic", password }, options = {}) => call("/api/login", {
    method: "POST", headers: { Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" }, body: JSON.stringify(data), ...options,
  });
  return { state, password, provider, app, call, login, tickets, clients: wss.clients };
}
test("HTTP login and /me expose only public grant fields with no-store", async t => {
  const { call, login, provider } = httpFixture(t);
  assert.equal((await call("/api/private")).status, 401);
  const config = await call("/api/auth/config"); assert.deepEqual(config.json(), { mode: "local", configured: true });
  const result = await login(); assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(result.json()).sort(), ["csrf", "owner", "userId", "username"]);
  const cookie = result.headers["set-cookie"].split(";")[0], me = await call("/api/me", { headers: { Cookie: cookie } });
  assert.deepEqual(me.json(), result.json()); assert.equal(me.headers["cache-control"], "no-store");
  assert.equal(provider.grants.size, 1);
  assert.equal((await login({ username: "unknown", password: "wrong" })).status, 401);
  assert.equal((await login({ username: "synthetic", password: "wrong" })).body, (await login({ username: "unknown", password: "wrong" })).body);
});
test("successful reauthentication immediately cleans all old sockets and tickets, just like logout", async t => {
  const { password, provider, call, login, tickets, clients } = httpFixture(t);
  const signed = await login(), cookie = signed.headers["set-cookie"].split(";")[0];
  const grant = [...provider.grants.values()][0];
  const other = await login(), otherGrant = [...provider.grants.values()].find(g => g.token !== grant.token);
  const open = g => ["terminal", "structured", "live"].map(route => {
    const ws = { route, panel: { grant: g }, codes: [], close(code) { this.codes.push(code); } };
    clients.add(ws); return ws;
  });
  const oldSockets = open(grant), otherSockets = open(otherGrant);
  tickets.set("old-unused", { grant }); tickets.set("other-unused", { grant: otherGrant });
  const options = { headers: { Cookie: cookie, Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" } };
  assert.equal((await login({ username: "synthetic", password: "wrong" }, options)).status, 401);
  assert.equal(provider.grants.get(grant.token), grant); assert.ok(tickets.has("old-unused"));
  assert.ok(oldSockets.every(ws => ws.codes.length === 0));
  const fresh = await login({ username: "synthetic", password }, options);
  // No periodic tick has run: the HTTP response already guarantees cleanup.
  assert.equal(fresh.status, 200); assert.notEqual(fresh.headers["set-cookie"], signed.headers["set-cookie"]);
  assert.equal(provider.grants.has(grant.token), false); assert.equal(tickets.has("old-unused"), false);
  assert.deepEqual(oldSockets.map(ws => ws.codes), [[4001], [4001], [4001]]);
  assert.ok(tickets.has("other-unused")); assert.ok(otherSockets.every(ws => ws.codes.length === 0));
  assert.equal((await call("/api/me", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await call("/api/me", { headers: { Cookie: fresh.headers["set-cookie"].split(";")[0] } })).status, 200);
  const logout = await call("/api/logout", { method: "POST", headers: {
    Cookie: other.headers["set-cookie"].split(";")[0], Origin: "http://127.0.0.1:4317", "X-Panel-CSRF": other.json().csrf,
  } });
  assert.equal(logout.status, 200); assert.equal(tickets.has("other-unused"), false);
  assert.deepEqual(otherSockets.map(ws => ws.codes), [[4001], [4001], [4001]]);
});
test("known and unknown failed logins have identical HTTP responses with safe audit attribution", async t => {
  const { state, login } = httpFixture(t);
  const known = await login({ username: "  SyNtHeTiC  ", password: "wrong" });
  const unknown = await login({ username: "UNKNOWN-RAW-INPUT", password: "wrong" });
  assert.equal(known.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(known.json(), { error: "Kullanıcı adı veya parola hatalı.", code: "LOGIN_FAILED" });
  assert.equal(unknown.body, known.body);
  const events = new AuditLog(state).read().filter(e => e.type === "login.fail");
  const owner = JSON.parse(fs.readFileSync(state + "/owner.json", "utf8"));
  assert.deepEqual(events.find(e => e.actor)?.actor, { id: owner.id, username: owner.username });
  assert.equal(events.filter(e => !e.actor).length, 1);
  assert.doesNotMatch(fs.readFileSync(state + "/audit.jsonl", "utf8"), /SyNtHeTiC|UNKNOWN-RAW-INPUT|wrong/);
});
test("login requires exact Host/Origin and JSON; compression, oversized and invalid bodies fail safely", async t => {
  const { login, provider } = httpFixture(t);
  for (const origin of [undefined, "null", "http://localhost:4317", "https://evil.example.test"]) {
    const headers = { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }) };
    assert.equal((await login(undefined, { headers })).status, 403);
  }
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) assert.equal((await login(undefined, { headers: { Origin: "http://127.0.0.1:4317", "Content-Type": contentType } })).status, 415);
  assert.equal((await login(undefined, { headers: { Host: "attacker.example.test", Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" } })).status, 403);
  for (const encoding of ["gzip", "br", "deflate"]) {
    const r = await login(undefined, { headers: { Origin: "http://127.0.0.1:4317", "Content-Type": "application/json", "Content-Encoding": encoding }, body: zlib.gzipSync("{}") });
    assert.equal(r.status, 415);
  }
  for (const chunked of [false, true]) assert.equal((await login(undefined, { body: JSON.stringify({ password: "x".repeat(17000) }), chunked })).status, 413);
  const malformed = await login(undefined, { body: '{"password":"synthetic secret' });
  assert.equal(malformed.status, 400); assert.doesNotMatch(malformed.body, /synthetic secret/);
  for (const data of [null, [], 5, {}, { username: {}, password: "x" }, { username: "x", password: {} }, { username: "x", password: "x".repeat(201) }]) assert.equal((await login(data)).status, 400);
  assert.equal(provider.grants.size, 0);
});
test("login does not need CSRF; all subsequent mutations require both CSRF and exact Origin", async t => {
  const { call, login } = httpFixture(t), signed = await login();
  const headers = { Cookie: signed.headers["set-cookie"].split(";")[0], Origin: "http://127.0.0.1:4317", "Content-Type": "application/json" };
  assert.equal(signed.status, 200);
  assert.equal((await call("/api/action", { method: "POST", headers, body: "{}" })).status, 403);
  const valid = { ...headers, "X-Panel-CSRF": signed.json().csrf };
  assert.equal((await call("/api/action", { method: "POST", headers: { ...valid, Origin: "http://localhost:4317" }, body: "{}" })).status, 403);
  assert.equal((await call("/api/action", { method: "POST", headers: valid, body: "{}" })).status, 200);
  const logout = await call("/api/logout", { method: "POST", headers: valid, body: "{}" });
  assert.equal(logout.status, 200); assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  assert.equal((await call("/api/me", { headers })).status, 401);
});
test("429 carries Retry-After and retryAfter; unconfigured login remains 503", async t => {
  const { login } = httpFixture(t);
  for (let i = 0; i < 6; i++) assert.equal((await login({ username: "synthetic", password: "bad" })).status, 401);
  const limited = await login({ username: "synthetic", password: "bad" });
  assert.equal(limited.status, 429); assert.equal(Number(limited.headers["retry-after"]), limited.json().retryAfter);
  assert.ok(limited.json().retryAfter > 0);
  const blank = httpFixture(t, { configured: false });
  assert.deepEqual((await blank.call("/api/auth/config")).json(), { mode: "local", configured: false });
  assert.equal((await blank.login({ username: "x", password: "x" })).status, 503);
});
test("anonymous build allowlist excludes maps, private state, hidden files and traversal", () => {
  for (const name of ["/", "/index.html", "/assets/index-hash.js", "/assets/font.woff2", "/favicon.svg"]) assert.equal(anonymousAsset(name), true);
  for (const name of ["/api/me", "/api/history", "/var/owner.json", "/uploads/image.png", "/assets/a.js.map", "/assets/.hidden.js", "/assets/../private.js", "/assets/%2e%2e/private.js"]) assert.equal(anonymousAsset(name), false);
});
test("a known HTTP session fails with 503 when its owner file becomes corrupt and loses its grant", async t => {
  const { state, login, call, provider } = httpFixture(t);
  const signed = await login(), cookie = signed.headers["set-cookie"].split(";")[0];
  fs.writeFileSync(state + "/owner.json", "broken");
  assert.equal((await call("/api/me", { headers: { Cookie: cookie } })).status, 503);
  assert.equal(provider.grants.size, 0);
  assert.equal((await call("/api/me", { headers: { Cookie: cookie } })).status, 401);
});
