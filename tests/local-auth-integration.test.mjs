import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { freePort, waitServer } from "./fixtures/portal-fixture.mjs";
import { localFixture, runPassword, childProcessAvailable } from "./fixtures/local-auth-fixture.mjs";

test("isolated full Panel: anonymous shell, private APIs, three sockets, CLI revocation and tmux survival", { timeout: 30000 }, async t => {
  if (!childProcessAvailable(t)) return;
  let port;
  try { port = await freePort(); }
  catch (error) { if (error.code === "EPERM") { t.skip("Sandbox denies loopback listen (EPERM)"); return; } throw error; }
  const cleanup = [];
  const { state, password } = localFixture({ after: fn => cleanup.push(fn) }), root = path.resolve(import.meta.dirname, "..");
  const appRoot = path.join(state, "app"), home = path.join(state, "home"), socket = path.join(state, "tmux.sock");
  fs.mkdirSync(path.join(appRoot, "config"), { recursive: true }); fs.mkdirSync(home);
  fs.cpSync(path.join(root, "server"), path.join(appRoot, "server"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(appRoot, "node_modules"));
  fs.writeFileSync(path.join(appRoot, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(appRoot, "config/projects.json"), JSON.stringify([{ id: "general", kind: "general", name: "Fixture" }]));
  fs.mkdirSync(path.join(appRoot, "dist/assets"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "dist/index.html"), '<!doctype html><html><body><script src="/assets/index-fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(appRoot, "dist/assets/index-fixture.js"), "// public shell fixture\n");
  fs.writeFileSync(path.join(appRoot, "dist/assets/index-fixture.js.map"), "private map fixture");
  const fake = path.join(state, "fake-acp.mjs");
  fs.writeFileSync(fake, `#!${process.execPath}\nimport ${JSON.stringify(path.join(root, "tests/fixtures/fake-acp-agent.mjs"))};\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(state, "agents.json"), JSON.stringify({ hermes: fake }), { mode: 0o600 });
  const base = `http://127.0.0.1:${port}`, sockets = [];
  const launch = () => spawn(process.execPath, [path.join(appRoot, "server/index.mjs")], { cwd: appRoot,
    env: { ...process.env, HOME: home, PANEL_STATE_DIR: state, PANEL_PORT: String(port), PANEL_TMUX_SOCKET: socket, PANEL_ACP_BINARY: fake }, stdio: "ignore" });
  let web = launch();
  const stop = async () => { if (web.exitCode === null && web.signalCode === null) { const exited = once(web, "exit"); web.kill("SIGTERM"); await exited; } };
  t.after(async () => {
    for (const ws of sockets) ws.terminate(); await stop();
    try { execFileSync("/usr/bin/tmux", ["-S", socket, "kill-server"], { stdio: "ignore" }); } catch {}
    cleanup.forEach(fn => fn());
  });
  await waitServer(base);
  assert.equal((await fetch(base)).status, 200); assert.equal((await fetch(base + "/assets/index-fixture.js")).status, 200);
  assert.equal((await fetch(base + "/assets/index-fixture.js.map")).status, 401);
  for (const route of ["/api/me", "/api/sessions", "/api/history", "/api/catalog"]) assert.equal((await fetch(base + route)).status, 401, route);
  assert.equal((await fetch(base + "/api/uploads", { method: "POST" })).status, 401);
  let cookie, csrf;
  const call = (route, method = "GET", body) => fetch(base + route, { method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}),
    "Content-Type": "application/json", ...(csrf ? { "X-Panel-CSRF": csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function login(secret) {
    const response = await call("/api/login", "POST", { username: "synthetic", password: secret }); assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie()[0].split(";")[0]; csrf = (await response.json()).csrf;
  }
  await login(password);
  assert.equal((await call("/api/me")).status, 200);
  const terminal = await (await call("/api/sessions", "POST", { kind: "terminal", agentId: "hermes", projectId: "general", requestId: crypto.randomUUID(), title: "Fixture terminal", allowParallel: true })).json();
  assert.ok(terminal.id);
  const chat = await (await call("/api/sessions", "POST", { kind: "structured", agentId: "hermes", projectId: "general", requestId: crypto.randomUUID(), title: "Fixture chat", allowParallel: true })).json();
  assert.ok(chat.id);
  const panePid = () => execFileSync("/usr/bin/tmux", ["-S", socket, "display-message", "-p", "-t", `ap-${terminal.id}`, "#{pane_pid}"], { encoding: "utf8" }).trim();
  const before = panePid();
  const ticket = async id => (await (await call(id === "live" ? "/api/live/ticket" : `/api/sessions/${id}/ticket`, "POST", {})).json()).ticket;
  const held = await ticket("live");
  for (const [route, id] of [["terminal", terminal.id], ["structured", chat.id], ["live", "live"]]) {
    const ws = new WebSocket(base.replace("http", "ws") + `/${route}`, "panel-ticket." + await ticket(id), { headers: { Origin: base, Cookie: cookie } });
    sockets.push(ws); await once(ws, "open");
  }
  const closed = sockets.map(ws => once(ws, "close"));
  assert.equal((await runPassword(state, ["--owner"], "new synthetic password\n")).code, 0);
  assert.deepEqual((await Promise.all(closed)).map(args => args[0]), [4001, 4001, 4001]);
  assert.equal(panePid(), before); assert.equal((await call("/api/me")).status, 401);
  const refused = new WebSocket(base.replace("http", "ws") + "/live", "panel-ticket." + held, { headers: { Origin: base, Cookie: cookie } });
  sockets.push(refused);
  const rejected = await new Promise((resolve, reject) => { refused.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode); }); refused.once("error", reject); });
  assert.equal(rejected, 401);
  await login("new synthetic password");
  assert.equal((await call("/api/logout", "POST", {})).status, 200); assert.equal((await call("/api/me")).status, 401);
  await login("new synthetic password"); const stale = cookie;
  await stop(); web = launch(); await waitServer(base);
  assert.equal(panePid(), before); assert.equal((await fetch(base + "/api/me", { headers: { Cookie: stale } })).status, 401);
});
