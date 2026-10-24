import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clientIp } from "../server/client-ip.mjs";
import { createPortalAuth } from "../server/portal-auth.mjs";
import { createLocalAuth } from "../server/local-auth.mjs";
import { tempState, localFixture, request } from "./fixtures/local-auth-fixture.mjs";

test("proxy headers are ignored by default, with consistent IPv4-mapped normalization", () => {
  for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "192.0.2.1"]) {
    const req = request(null, undefined, ip);
    Object.assign(req.headers, { "cf-connecting-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3", forwarded: "for=198.51.100.4" });
    assert.equal(clientIp(req), ip.replace("::ffff:", ""));
  }
});
test("proxy trust needs explicit permission, loopback and a single valid IP", () => {
  const req = request();
  for (const header of [null, ["192.0.2.1"], "192.0.2.1,192.0.2.2", " 192.0.2.1", "", "bad", "x".repeat(100)]) {
    req.headers["cf-connecting-ip"] = header;
    assert.equal(clientIp(req, { trustProxyHeader: true }), "127.0.0.1");
  }
  req.headers["cf-connecting-ip"] = "::ffff:192.0.2.1";
  assert.equal(clientIp(req, { trustProxyHeader: true }), "192.0.2.1");
  req.socket.remoteAddress = "192.0.2.2";
  assert.equal(clientIp(req, { trustProxyHeader: true }), "192.0.2.2");
});
test("CF rotation cannot bypass portal unknown-cookie budgets unless explicitly trusted", async t => {
  for (const trustProxyHeader of [false, true]) {
    const auth = createPortalAuth({ state: tempState(t), app: "panel", port: 4317, trustProxyHeader, limits: { unknownTokens: 1 } });
    const req = request("panel_auth=" + "x".repeat(43));
    req.headers["cf-connecting-ip"] = "192.0.2.1";
    await assert.rejects(async () => auth.session(req), { status: 503 });
    req.headers["cf-connecting-ip"] = "192.0.2.2";
    await assert.rejects(async () => auth.session(req), { status: trustProxyHeader ? 503 : 429 });
  }
});
test("local failure budgets and audit share the same default socket IP", async t => {
  const { state } = localFixture(t);
  const auth = createLocalAuth({ state, app: "panel", port: 4317, limits: { pause: async () => {} } });
  const req = request();
  for (let i = 0; i < 6; i++) {
    req.headers["cf-connecting-ip"] = `192.0.2.${i + 1}`;
    await assert.rejects(auth.login(req, { username: "synthetic", password: "wrong" }), { status: 401 });
  }
  await assert.rejects(auth.login(req, { username: "synthetic", password: "wrong" }), e => e.status === 429 && e.retryAfter > 0);
  const { AuditLog } = await import("../server/audit.mjs");
  assert.ok(new AuditLog(state).read().every(e => e.ip === "127.0.0.1"));
});
test("portal start budgets use the same explicit trust setting as cookie checks", t => {
  for (const trustProxyHeader of [false, true]) {
    const state = tempState(t);
    fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43),
      portalInternal: "http://127.0.0.1:9", portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }));
    const auth = createPortalAuth({ state, app: "panel", port: 4317, trustProxyHeader, limits: { starts: 1 } });
    const req = request(); req.headers["cf-connecting-ip"] = "192.0.2.1"; auth.start(req);
    req.headers["cf-connecting-ip"] = "192.0.2.2";
    if (trustProxyHeader) assert.ok(auth.start(req).location); else assert.throws(() => auth.start(req), { status: 429 });
  }
});
test("explicit trusted loopback CF IP is used consistently by local login and audit", async t => {
  const { state, password } = localFixture(t);
  const auth = createLocalAuth({ state, app: "panel", port: 4317, trustProxyHeader: true, limits: { pause: async () => {} } });
  const req = request(); req.headers["cf-connecting-ip"] = "192.0.2.1";
  for (let i = 0; i < 6; i++) await assert.rejects(auth.login(req, { username: "synthetic", password: "bad" }), { status: 401 });
  req.headers["cf-connecting-ip"] = "192.0.2.2";
  assert.ok((await auth.login(req, { username: "synthetic", password })).grant);
  const { AuditLog } = await import("../server/audit.mjs");
  const events = new AuditLog(state).read();
  assert.equal(events.find(e => e.type === "login.ok").ip, "192.0.2.2");
  assert.ok(events.filter(e => e.type === "login.fail").every(e => e.ip === "192.0.2.1"));
});
