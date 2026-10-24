import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createLocalAuth } from "../server/local-auth.mjs";
import { localFixture, tempState, request } from "./fixtures/local-auth-fixture.mjs";

test("local contract needs no portal and has one authoritative grants map", async t => {
  const { state, password } = localFixture(t), grants = new Map();
  fs.writeFileSync(path.join(state, "auth-client.json"), "broken portal config");
  t.mock.method(globalThis, "fetch", assert.fail);
  const auth = createLocalAuth({ state, app: "panel", port: 4317, grants });
  assert.equal(auth.grants, grants); assert.equal(auth.portal(), null);
  assert.deepEqual(auth.metadata(), { mode: "local", configured: true });
  const start = auth.start(request()); assert.equal(start.location, "/"); assert.match(start.cookie, /panel_login=; Max-Age=0/);
  await assert.rejects(auth.callback(request(), new URL("http://localhost/auth/callback?code=x")), { status: 400, code: "LOCAL_CALLBACK_DISABLED" });
  assert.equal(grants.size, 0);
  const { grant, cookie } = await auth.login(request(), { username: "synthetic", password });
  assert.equal(await auth.session(request(cookie.split(";")[0])), grant);
  assert.equal(await auth.check(grant.token), grant);
  assert.notEqual(grant.token, grant.csrf); assert.match(grant.token, /^[\w-]{43}$/); assert.match(grant.csrf, /^[\w-]{43}$/);
  assert.match(await auth.logout(request(), grant), /Max-Age=0/);
  assert.equal(await auth.check(grant.token), null);
});
test("unconfigured means CLI only; malformed owner is a service failure", async t => {
  const state = tempState(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  assert.deepEqual(auth.metadata(), { mode: "local", configured: false });
  await assert.rejects(auth.login(request(), { username: "x", password: "x" }), { status: 503, code: "AUTH_NOT_CONFIGURED" });
  fs.writeFileSync(path.join(state, "owner.json"), "broken", { mode: 0o600 });
  assert.throws(() => auth.metadata(), { status: 503 });
});
test("cookies are Host-only, strict and public cookies are Secure; duplicates and mixed names fail", async t => {
  const { state, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  for (const host of ["localhost:4317", "127.0.0.1:4317", "panel.example.test", "localhost:99", "127.0.0.1.evil.test"]) {
    const req = request(null, host), { grant, cookie } = await auth.login(req, { username: "synthetic", password });
    const isLocal = ["localhost:4317", "127.0.0.1:4317"].includes(host);
    assert.ok(cookie.startsWith(isLocal ? "panel_auth=" : "__Host-panel_auth="));
    assert.match(cookie, /Max-Age=28800; Path=\/; HttpOnly; SameSite=Strict/);
    assert.equal(cookie.includes("; Secure"), !isLocal); assert.doesNotMatch(cookie, /Domain=/);
    const pair = cookie.split(";")[0];
    assert.equal(await auth.session(request(pair + "; " + pair, host)), null);
    assert.equal(await auth.session(request(pair, isLocal ? "panel.example.test" : "127.0.0.1:4317")), null);
    assert.equal(await auth.session(request(pair, host)), grant);
    assert.equal((await auth.logout(req, grant)).includes("; Secure"), !isLocal);
  }
});
test("failed reauthentication preserves old grants; success revokes old cookie; restart rejects it", async t => {
  const { state, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  const first = await auth.login(request(), { username: "synthetic", password }), req = request(first.cookie.split(";")[0]);
  await assert.rejects(auth.login(req, { username: "synthetic", password: "bad" }), { status: 401 });
  assert.equal(await auth.session(req), first.grant);
  await auth.login(req, { username: "synthetic", password });
  assert.equal(await auth.session(req), null);
  assert.equal(await createLocalAuth({ state, app: "panel", port: 4317 }).session(req), null);
});
