import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLimiter, createPortalAuth } from "../server/portal-auth.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("limiter counts per key inside a window and resets after it", () => {
  let t = 0;
  const hit = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(hit("a"), true);
  assert.equal(hit("a"), true);
  assert.equal(hit("a"), false);
  assert.equal(hit("b"), true);
  t = 1001;
  assert.equal(hit("a"), true);
});

test("limiter refuses new keys at capacity instead of growing", () => {
  const hit = createLimiter({ max: 1, windowMs: 1000, now: () => 0, maxKeys: 2 });
  assert.equal(hit("a"), true);
  assert.equal(hit("b"), true);
  assert.equal(hit("c"), false);
});

test("unknown session cookies are rate limited per client before the portal is called", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ap-auth-"));
  const auth = createPortalAuth({ state, app: "panel", port: 1, trustProxyHeader: true, limits: { unknownTokens: 3 } });
  const req = (token, ip) => ({ headers: { host: "127.0.0.1:1", cookie: `panel_auth=${token}`, "cf-connecting-ip": ip }, socket: { remoteAddress: "127.0.0.1" } });
  const outcome = async (r) => { try { await auth.session(r); return "ok"; } catch (e) { return e.status; } };
  // No auth-client.json: the portal is unreachable (503) until the limit trips.
  for (let i = 0; i < 3; i++) assert.equal(await outcome(req("A".repeat(43), "192.0.2.1")), 503);
  assert.equal(await outcome(req("A".repeat(43), "192.0.2.1")), 429);
  assert.equal(await outcome(req("A".repeat(43), "198.51.100.2")), 503);
  fs.rmSync(state, { recursive: true, force: true });
});

test("server stays up when upgrade clients reset the socket; anonymous and cross-origin requests are refused", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ap-sec-"));
  const free = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const [portalPort, port] = [await free(), await free()];
  const token = "T".repeat(43), csrf = "C".repeat(43);
  fs.writeFileSync(path.join(state, "agents.json"), "{}");
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({
    app: "panel", key: "K".repeat(43), portalInternal: `http://127.0.0.1:${portalPort}`,
    portalOrigin: `http://127.0.0.1:${portalPort}`, publicOrigin: `http://127.0.0.1:${port}` }));
  const portal = http.createServer((q, s) => { q.resume(); q.on("end", () => {
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ token, owner: true, username: "o", userId: 1, csrf, expires: Date.now() + 3600e3 })); }); }).listen(portalPort, "127.0.0.1");
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], { cwd: root, stdio: "ignore",
    env: { ...process.env, PANEL_STATE_DIR: state, PANEL_PORT: String(port), PANEL_TMUX_SOCKET: path.join(state, "t.sock") } });
  let exited = false; child.on("exit", () => { exited = true; });
  t.after(() => { child.kill(); portal.close(); fs.rmSync(state, { recursive: true, force: true }); });
  const host = `127.0.0.1:${port}`, origin = `http://${host}`;
  const call = (method, p, headers = {}) => new Promise(resolve => {
    const q = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host, accept: "application/json", ...headers } },
      s => { s.resume(); s.on("end", () => resolve(s.statusCode)); });
    q.on("error", () => resolve(0)); q.end();
  });
  for (let i = 0; i < 50 && !(await call("GET", "/api/health")); i++) await new Promise(r => setTimeout(r, 100));
  // Anonymous: every API route answers 401.
  for (const [m, p] of [["GET", "/api/sessions"], ["GET", "/api/me"], ["POST", "/api/sessions"], ["POST", "/api/live/ticket"], ["GET", "/api/catalog"]])
    assert.equal(await call(m, p), 401, `${m} ${p}`);
  // Authenticated mutations need both a matching Origin and the CSRF header.
  const cookie = `panel_auth=${token}`;
  assert.equal(await call("POST", "/api/live/ticket", { cookie }), 403);
  assert.equal(await call("POST", "/api/live/ticket", { cookie, origin }), 403);
  assert.equal(await call("POST", "/api/live/ticket", { cookie, origin: "https://evil.example", "x-panel-csrf": csrf }), 403);
  assert.equal(await call("POST", "/api/live/ticket", { cookie, origin, "x-panel-csrf": csrf }), 200);
  // WebSocket upgrades without Origin or ticket are refused.
  const upgrade = (extra) => new Promise(resolve => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET /live HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`));
    let d = ""; s.on("data", x => d += x); s.on("error", () => resolve("err")); s.on("close", () => resolve(d.split("\r\n")[0]));
  });
  assert.match(await upgrade(""), / 403 /);
  assert.match(await upgrade(`Origin: ${origin}\r\n`), / 401 /);
  // Regression: resetting the raw socket during the async auth check used to
  // raise an unhandled 'error' and kill the whole panel.
  for (let i = 0; i < 200; i++) {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET /live HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${origin}\r\n\r\n`);
      s.resetAndDestroy();
    });
    s.on("error", () => {});
    if (i % 20 === 0) await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(exited, false, "server must survive reset upgrade sockets");
  assert.equal(await call("GET", "/api/health"), 200);
});
