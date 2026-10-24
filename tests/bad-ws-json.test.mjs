import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const root = path.resolve(import.meta.dirname, "..");
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const csrf = "c".repeat(43), tok = "t".repeat(43);

test("a WebSocket frame whose JSON is not an object ('null', number, array) closes the socket and does not crash the server", { timeout: 30000 }, async t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "panel-badws-")), port = await freePort(), pport = await freePort();
  const write = (file, value) => fs.writeFileSync(path.join(state, file), JSON.stringify(value), { mode: 0o600 });
  write("agents.json", {});
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  write("auth-client.json", { app: "panel", key: "k".repeat(43), portalInternal: `http://127.0.0.1:${pport}`, portalOrigin: "https://portal.example/", publicOrigin: `http://127.0.0.1:${port}/` });
  // Sahte portal: her oturum jetonunu sahip olarak doğrular.
  const portal = http.createServer((req, res) => { let b = ""; req.on("data", d => { b += d; }); req.on("end", () => {
    const j = b ? JSON.parse(b) : {};
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/internal/session" ? JSON.stringify({ token: j.token, userId: "u1", username: "tester", owner: true, csrf, storageKey: "k", expires: Date.now() + 3600e3 }) : "{}");
  }); }).listen(pport, "127.0.0.1");
  await once(portal, "listening");
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], { cwd: root, stdio: "ignore",
    env: { ...process.env, HOME: state, PANEL_STATE_DIR: state, PANEL_PORT: String(port), PANEL_TMUX_SOCKET: path.join(state, "tmux.sock") } });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } portal.close(); fs.rmSync(state, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const headers = { Cookie: `panel_auth=${tok}`, Origin: base, "x-panel-csrf": csrf, "content-type": "application/json" };
  for (const payload of ["null", "5", "[]", "\"x\"", "true"]) {
    const r = await fetch(base + "/api/live/ticket", { method: "POST", headers, body: "{}" });
    assert.equal(r.status, 200);
    const { ticket } = await r.json();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, "panel-ticket." + ticket, { headers: { Origin: base, Cookie: headers.Cookie } });
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send(payload);
    const [code] = await closed;
    assert.equal(code, 1008, `payload ${payload}`);
    assert.equal(child.exitCode, null, `server survived ${payload}`);
  }
  assert.equal((await fetch(base + "/api/health")).status, 200);
});
