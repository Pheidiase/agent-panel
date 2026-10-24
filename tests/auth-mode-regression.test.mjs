import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createAuth } from "../server/auth.mjs";
import { mountAuthRoutes, authFailure } from "../server/auth-http.mjs";
import { localFixture, request } from "./fixtures/local-auth-fixture.mjs";
import { requestApp } from "./fixtures/http-memory.mjs";

test("portal 410 login, state/callback and owner-only semantics survive the mode factory", async t => {
  const { state } = localFixture(t);
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43),
    portalInternal: "http://127.0.0.1:9", portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }), { mode: 0o600 });
  const auth = createAuth({ state, app: "panel", port: 4317 }), app = express();
  mountAuthRoutes(app, auth, { originOK: () => false }); app.use(authFailure);
  assert.deepEqual((await requestApp(app, { path: "/api/auth/config" })).json(), { mode: "portal" });
  assert.equal((await requestApp(app, { path: "/api/login", method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 410);
  const start = auth.start(request());
  assert.equal(new URL(start.location).origin, "https://portal.example.test");
  assert.match(start.cookie, /panel_login=.*Max-Age=120/);
  const stateToken = new URL(start.location).searchParams.get("state"), req = request(start.cookie.split(";")[0]);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ owner: false, token: "t".repeat(43) })));
  await assert.rejects(auth.callback(req, new URL(`http://localhost/auth/callback?code=x&state=${stateToken}`)), { status: 403 });
  assert.equal(auth.grants.size, 0);
  assert.equal(await auth.session(request("panel_auth=" + "x".repeat(43))), null);
});
test("tokens from one mode are never accepted by the other; restarts get empty grants", async t => {
  const { state, password } = localFixture(t);
  const local = createAuth({ state, app: "panel", port: 4317 });
  const { grant, cookie } = await local.login(request(), { username: "synthetic", password });
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43), portalInternal: "http://127.0.0.1:9",
    portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }), { mode: 0o600 });
  const portal = createAuth({ state, app: "panel", port: 4317 });
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
  assert.equal(await portal.session(request(cookie.split(";")[0])), null); assert.equal(portal.grants.size, 0);
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "local" }));
  const restarted = createAuth({ state, app: "panel", port: 4317 });
  assert.equal(await restarted.check(grant.token), null);
  assert.equal(await restarted.session(request("panel_auth=" + "p".repeat(43))), null);
  assert.equal(restarted.grants.size, 0);
  assert.equal(local.grants.size, 1, "mode is fixed in an already running backend");
});
