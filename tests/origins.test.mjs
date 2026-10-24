import { fixturePortal, portalLogin, freePort } from "./fixtures/portal-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { canonicalOrigin, readOrigins, hostAllowed, originAllowed } from "../server/origins.mjs";

const named = "https://example.test";
const old = "https://fixture-existing.trycloudflare.com";
test("rejects origins that widen the trust boundary", () => {
  assert.equal(canonicalOrigin(named), named);
  for (const value of ["http://example.test", named + "/", named + "/path", named + "?x=1", named + "#x", "https://*.example.test", "https://user@example.test", named + ":8443", "null", null])
    assert.throws(() => canonicalOrigin(value));
  assert.equal(originAllowed([named, old], "example.test", old), false);
  assert.equal(hostAllowed([named], "example.test.evil.example"), false);
});

test("custom-domain portal login, CSRF, logout and one-use WebSocket ticket; quick tunnel retained", { timeout: 30000 }, async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "panel-origins-"));
  const root = path.resolve(import.meta.dirname, "..");
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const password = crypto.randomBytes(24).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const write = (file, value) => fs.writeFileSync(path.join(state, file), JSON.stringify(value), { mode: 0o600 });
  write("credentials.json", { username: "fixture", salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") });
  const fixture = path.join(state, "hermes-fixture.mjs"), home = path.join(state, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(fixture, `#!${process.execPath}\nimport ${JSON.stringify(path.join(root, "tests/fixtures/fake-acp-agent.mjs"))};\n`, { mode: 0o700 });
  write("agents.json", { hermes: fixture });
  write("public-origin.json", { origin: old });
  write("named-origins.json", { origins: [named] });
  const portal = await fixturePortal({ panelState: state, panelBase: named, password, username: "fixture" });
  const web = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: { ...process.env, HOME: home, PANEL_ACP_BINARY: fixture, PANEL_STATE_DIR: state, PANEL_PORT: String(port), PANEL_TMUX_SOCKET: path.join(state, "tmux.sock") }, stdio: "ignore" });
  const sockets = [];
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(local + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "isolated server ready");
    const request = (url, { origin = named, host = new URL(origin).host, method = "GET", body, rawBody, contentType = "application/json", encoding, cookie, csrf } = {}) => new Promise((resolve, reject) => {
      const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
      const req = http.request(local + url, { method, headers: { Host: host, Origin: origin, "Content-Type": contentType, ...(encoding ? { "Content-Encoding": encoding } : {}), ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-Panel-CSRF": csrf } : {}) } }, res => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: { get: name => { const value = res.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(", ") : value; } }, json: async () => JSON.parse(data) }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    for (const [encoding, compress] of [["br", zlib.brotliCompressSync], ["gzip", zlib.gzipSync], ["deflate", zlib.deflateSync]]) {
      const response = await request("/api/login", { method: "POST", encoding, rawBody: compress(Buffer.from("{}")) });
      assert.equal(response.status, 415); assert.match((await response.json()).error, /Sıkıştırılmış/);
    }
    for (const origin of [named, old]) {
      assert.equal((await request("/api/health", { origin })).status, 200);
      assert.equal((await request("/api/sessions", { origin })).status, 401);
      assert.equal((await request("/api/uploads", { origin, method: "POST", body: {} })).status, 401);
    }
    assert.equal((await request("/api/health", { host: "attacker.example" })).status, 403);
    assert.equal((await request("/api/login", { host: "example.test", origin: old, method: "POST", body: { username: "fixture", password } } )).status, 410);
    const start = await request("/");
    assert.equal(start.status, 302);
    const owner = await portalLogin(portal.base, "fixture", password);
    const authorize = await fetch(start.headers.get("location"), { redirect: "manual", headers: { Cookie: owner.cookie } });
    const callback = new URL(authorize.headers.get("location"));
    const login = await request(callback.pathname + callback.search, { cookie: start.headers.get("set-cookie").split(";")[0] });
    assert.equal(login.status, 302);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Domain=/i);
    const cookie = setCookie.split(";")[0];
    const { csrf } = await (await request("/api/me", { cookie })).json();
    const compressedImage = await request("/api/uploads", { method: "POST", cookie, csrf, contentType: "image/png", encoding: "br", rawBody: zlib.brotliCompressSync(Buffer.from("image")) });
    assert.equal(compressedImage.status, 415);
    assert.match((await compressedImage.json()).error, /Sıkıştırılmış/);
    assert.equal(fs.existsSync(path.join(state, "uploads")), false);
    // Signature validation runs through authenticated HTTP and writes only
    // inside this test's private state, never the real uploads directory.
    for (const rawBody of [Buffer.from("RIFF0000WAVE00000000"), Buffer.from("RIFF0000AVI 00000000"), Buffer.from("RIFF")]) {
      const upload = await request("/api/uploads", { method: "POST", cookie, csrf, contentType: "image/webp", rawBody });
      assert.equal(upload.status, 400);
      assert.equal(fs.existsSync(path.join(state, "uploads")), false);
    }
    for (const [contentType, rawBody] of [
      ["image/webp", Buffer.from("RIFF0000WEBP00000000")],
      ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(12).fill(0)])],
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, ...Array(13).fill(0)])],
      ["image/gif", Buffer.from("GIF8000000000000")],
    ]) {
      const upload = await request("/api/uploads", { method: "POST", cookie, csrf, contentType, rawBody });
      assert.equal(upload.status, 200);
      const file = (await upload.json()).path;
      assert.equal(path.dirname(file), path.join(state, "uploads"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readFileSync(file), rawBody);
    }
    assert.equal((await request("/api/me", { cookie })).status, 200);
    assert.equal((await request("/api/uploads", { cookie, method: "POST", body: {} })).status, 403);
    assert.equal((await request("/api/live/ticket", { method: "POST", cookie, body: {} })).status, 403);
    const ticketReply = await request("/api/live/ticket", { method: "POST", cookie, csrf, body: {} });
    assert.equal(ticketReply.status, 200);
    const { ticket } = await ticketReply.json();
    const connect = (origin = named) => new Promise((resolve, reject) => {
      const ws = new WebSocket(local.replace("http", "ws") + "/live", "panel-ticket." + ticket, { headers: { Host: "example.test", Origin: origin, Cookie: cookie } });
      sockets.push(ws);
      ws.on("open", () => resolve(101));
      ws.on("unexpected-response", (_req, reply) => { reply.resume(); resolve(reply.statusCode); });
      ws.on("error", reject);
    });
    assert.equal(await connect(old), 403);
    assert.equal(await connect(), 101);
    assert.equal(await connect(), 401);
    const terminal = await (await request("/api/sessions", { method: "POST", cookie, csrf, body: { kind: "terminal", agentId: "hermes", projectId: "general", title: "fixture terminal", requestId: crypto.randomUUID(), allowParallel: true } })).json();
    const chatBody = { kind: "structured", agentId: "hermes", projectId: "general", title: "fixture chat", requestId: crypto.randomUUID() };
    assert.equal((await request("/api/sessions", { method: "POST", cookie, csrf, body: chatBody })).status, 409, "a running terminal requires parallel consent for a chat in the same project");
    const chatReply = await request("/api/sessions", { method: "POST", cookie, csrf, body: { ...chatBody, allowParallel: true } });
    assert.equal(chatReply.status, 201);
    const chat = await chatReply.json();
    const extraSockets = [];
    for (const [route, session] of [["terminal", terminal], ["structured", chat]]) {
      const reply = await request(`/api/sessions/${session.id}/ticket`, { method: "POST", cookie, csrf, body: {} });
      assert.equal(reply.status, 200);
      const { ticket: extraTicket } = await reply.json();
      const ws = new WebSocket(local.replace("http", "ws") + `/${route}?id=${session.id}`, "panel-ticket." + extraTicket, { headers: { Host: "example.test", Origin: named, Cookie: cookie } });
      sockets.push(ws); extraSockets.push(ws);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    }
    const pid = () => execFileSync("/usr/bin/tmux", ["-S", path.join(state, "tmux.sock"), "display-message", "-p", "-t", `ap-${terminal.id}`, "#{pane_pid}"], { encoding: "utf8" }).trim();
    const beforePid = pid();
    const closed = [sockets.find(ws => ws.readyState === 1), ...extraSockets].map(ws => new Promise(resolve => ws.once("close", resolve)));
    assert.equal((await request("/api/logout", { method: "POST", cookie, csrf, body: {} })).status, 200);
    await Promise.all(closed);
    assert.equal(pid(), beforePid, "central logout closes terminal/chat/live viewers while preserving the tmux agent");
    assert.equal((await request("/api/me", { cookie })).status, 401);
    // Future subdomain can be added without rewriting quick tunnel state.
    write("named-origins.json", { origins: [named, "https://panel.example.test"] });
    assert.equal((await request("/api/health", { origin: "https://panel.example.test" })).status, 200);
    write("named-origins.json", { origins: [named, "https://*.example.com"] });
    assert.equal(readOrigins({ state, port }).includes(named), false);
    assert.equal((await request("/api/health", { origin: old })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "public-origin.json"))).origin, old);
  } finally {
    for (const ws of sockets) ws.terminate();
    web.kill("SIGTERM");
    await new Promise(resolve => web.exitCode !== null ? resolve() : web.once("exit", resolve));
    await portal.close();
    try { execFileSync("/usr/bin/tmux", ["-S", path.join(state, "tmux.sock"), "kill-server"], { stdio: "ignore" }); } catch {}
    fs.rmSync(state, { recursive: true, force: true });
  }
});
