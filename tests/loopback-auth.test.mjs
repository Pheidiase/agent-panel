// Real auth routes/providers and HTTP parsing, without a listener or external calls.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { createAuth } from "../server/auth.mjs";
import { readPanelSettings } from "../server/config.mjs";
import { readOrigins, hostAllowed, originAllowed } from "../server/origins.mjs";
import { mountAuthRoutes, anonymousAsset, authFailure } from "../server/auth-http.mjs";
import { setStaticCache } from "../server/static-cache.mjs";
import { localFixture, request } from "./fixtures/local-auth-fixture.mjs";
import { requestApp } from "./fixtures/http-memory.mjs";

const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
function fixture(t, mode) {
  const f = localFixture(t), root = f.state, state = f.state, port = 7001;
  fs.mkdirSync(path.join(root, "dist")); fs.writeFileSync(path.join(root, "dist/index.html"), "<html>Fixture login shell</html>");
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode }), { mode: 0o600 });
  if (mode === "portal") fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43),
    portalInternal: "http://127.0.0.1:9", portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }), { mode: 0o600 });
  const settings = readPanelSettings({ root, state, env: { PANEL_HOST: "::1", PANEL_PORT: String(port) } });
  assert.equal(settings.host, "::1");
  const origins = readOrigins({ state, port: settings.port }), app = express();
  const provider = createAuth({ state, app: "panel", port: settings.port, limits: { pause: async () => {} } });
  const originOK = req => originAllowed(origins, req.headers.host, req.headers.origin);
  app.use((req, res, next) => hostAllowed(origins, req.headers.host) ? next() : res.sendStatus(403));
  mountAuthRoutes(app, provider, { originOK });
  const auth = async (req, res, next) => {
    try { req.panelGrant = await provider.session(req); if (!req.panelGrant) return res.sendStatus(401); next(); }
    catch (error) { next(error); }
  };
  const mutation = new Function("originOK", "crypto", index.slice(index.indexOf("function mutation("), index.indexOf("function send(")) + "; return mutation;")(originOK, crypto);
  new Function("app", "auth", "mutation", "portalAuth", "revokeConnections", index.slice(index.indexOf('app.get("/api/me",'), index.indexOf('app.get("/api/catalog",')))(app, auth, mutation, provider, () => {});
  // Production anonymous shell, SSO start and static-file middleware.
  new Function("app", "portalAuth", "anonymousAsset", "root", "path", "express", "setStaticCache",
    index.slice(index.indexOf('app.get("/auth/callback",'), index.indexOf("app.use(authFailure)")))(app, provider, anonymousAsset, root, path, express, setStaticCache);
  app.use(authFailure);
  return { ...f, app, provider, port };
}

for (const host of ["127.0.0.1:7001", "localhost:7001", "[::1]:7001"]) {
  test(`local: anonymous shell, login, /me and logout work on ${host}`, async t => {
    const f = fixture(t, "local"), headers = { Host: host, Origin: `http://${host}` };
    const call = (url, options = {}) => requestApp(f.app, { path: url, headers, ...options });
    const shell = await call("/"); assert.equal(shell.status, 200); assert.match(shell.body, /Fixture login shell/);
    assert.equal((await call("/api/me")).status, 401);
    const signed = await call("/api/login", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "synthetic", password: f.password }) });
    assert.equal(signed.status, 200);
    assert.match(signed.headers["set-cookie"], /^panel_auth=.*HttpOnly; SameSite=Strict$/);
    const session = { ...headers, Cookie: signed.headers["set-cookie"].split(";")[0] };
    assert.deepEqual((await call("/api/me", { headers: session })).json(), signed.json());
    assert.equal((await call("/api/logout", { method: "POST", headers: session })).status, 403);
    const valid = { ...session, "X-Panel-CSRF": signed.json().csrf };
    assert.equal((await call("/api/logout", { method: "POST", headers: { ...valid, Origin: "http://localhost:7002" } })).status, 403);
    const logout = await call("/api/logout", { method: "POST", headers: valid });
    assert.equal(logout.status, 200); assert.match(logout.headers["set-cookie"], /^panel_auth=; Max-Age=0/);
    assert.equal((await call("/api/me", { headers: session })).status, 401);
  });

  test(`portal: loopback cookies and owner-only /me work on ${host}`, async t => {
    const f = fixture(t, "portal"), headers = { Host: host, Origin: `http://${host}` };
    let owner = true;
    const grant = { token: "t".repeat(43), username: "synthetic", userId: "fixture-owner", owner: true, csrf: "fixture-csrf", expires: Date.now() + 60000 };
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ...grant, owner })));
    const start = await requestApp(f.app, { headers });
    assert.equal(start.status, 302); assert.match(start.headers["set-cookie"], /^panel_login=.*HttpOnly; SameSite=Strict$/);
    const nonce = new URL(start.headers.location).searchParams.get("state");
    const callback = await f.provider.callback(request(start.headers["set-cookie"].split(";")[0], host), new URL(`http://${host}/auth/callback?state=${nonce}&code=fixture`));
    assert.match(callback.cookies[0], /^panel_auth=.*HttpOnly; SameSite=Strict$/);
    assert.match(callback.cookies[1], /^panel_login=; Max-Age=0/);
    const session = { ...headers, Cookie: callback.cookies[0].split(";")[0] };
    const me = await requestApp(f.app, { path: "/api/me", headers: session });
    assert.equal(me.status, 200); assert.equal(me.json().owner, true);
    owner = false;
    assert.equal((await requestApp(f.app, { path: "/api/me", headers: session })).status, 401);
    const retry = f.provider.start(request(undefined, host));
    const state = new URL(retry.location).searchParams.get("state");
    await assert.rejects(f.provider.callback(request(retry.cookie.split(";")[0], host), new URL(`http://${host}/auth/callback?state=${state}&code=fixture`)), { status: 403 });
  });
}

test("loopback allowlists reject other addresses, ports, malformed IPv6 and mismatched origins", t => {
  const f = fixture(t, "local"), origins = readOrigins({ state: f.state, port: f.port });
  for (const host of ["[::1]:7002", "::1:7001", "[::]:7001", "[2001:db8::1]:7001", "192.0.2.1:7001", "localhost.evil.test:7001"]) {
    assert.equal(hostAllowed(origins, host), false, host);
    assert.equal(originAllowed(origins, host, `http://${host}`), false, host);
  }
  assert.equal(originAllowed(origins, "[::1]:7001", "http://localhost:7001"), false);
  for (const mode of ["local", "portal"]) {
    const provider = fixture(t, mode).provider;
    const cookie = provider.start(request(undefined, "panel.example.test")).cookie;
    assert.match(cookie, /^__Host-panel_login=/); assert.match(cookie, /; Secure$/);
  }
});
