import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Sessions, exec } from "../server/session-store.mjs";
import { utf8Env } from "../server/config.mjs";
import { serviceUnits } from "../ops/install.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("utf8Env keeps an active UTF-8 locale and fixes the variable that wins (LC_ALL > LC_CTYPE > LANG)", () => {
  const same = env => assert.equal(utf8Env(env), env);
  same({ LANG: "en_US.UTF-8" });
  same({ LC_CTYPE: "tr_TR.utf8", LANG: "C" });
  same({ LC_ALL: "C.UTF-8", LANG: "C" });
  // LC_ALL beats a UTF-8 LANG, so a non-UTF-8 LC_ALL is the variable to replace.
  assert.deepEqual(utf8Env({ LC_ALL: "C", LANG: "en_US.UTF-8" }), { LC_ALL: "C.UTF-8", LANG: "en_US.UTF-8" });
  assert.deepEqual(utf8Env({ LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" }), { LC_CTYPE: "C.UTF-8", LANG: "en_US.UTF-8" });
  assert.deepEqual(utf8Env({ LANG: "C", PATH: "/bin" }), { LANG: "C", PATH: "/bin", LC_CTYPE: "C.UTF-8" });
  assert.deepEqual(utf8Env({ PATH: "/bin" }), { PATH: "/bin", LC_CTYPE: "C.UTF-8" });
  const original = { LANG: "C" };
  utf8Env(original);
  assert.deepEqual(original, { LANG: "C" });
});

test("generated units add a UTF-8 locale only when the setup environment has none", () => {
  const options = { root: "/srv/panel", state: "/srv/panel/var", socket: "/srv/panel/var/tmux.sock", tools: { tmux: "/usr/bin/tmux", python3: "/usr/bin/python3" } };
  for (const env of [{ PATH: "/usr/bin", LANG: "en_US.UTF-8" }, { PATH: "/usr/bin", LC_ALL: "C.UTF-8" }])
    assert.doesNotMatch(Object.values(serviceUnits({ ...options, env })).join("\n"), /LC_/);
  for (const [name, text] of Object.entries(serviceUnits({ ...options, env: { PATH: "/usr/bin", LANG: "C" } })))
    assert.match(text, /Environment="LC_CTYPE=C\.UTF-8"/, name);
});

// The failure seen on a runner without a locale: tmux printed tabs as "_", so list() lost every session.
for (const [name, locale] of [
  ["no locale variables", {}],
  ["LANG=C", { LANG: "C" }],
  ["LC_CTYPE=POSIX", { LC_CTYPE: "POSIX" }],
  ["LC_ALL=C overriding a UTF-8 LANG", { LC_ALL: "C", LANG: "C.UTF-8" }],
]) test(`tmux-backed sessions work with ${name}`, async t => {
  const saved = { ...process.env };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"]) delete process.env[key];
  Object.assign(process.env, locale);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-locale-"));
  const socket = path.join(dir, "tmux.sock");
  const fixture = path.join(dir, "fixture");
  fs.writeFileSync(fixture, `#!${process.execPath}\nconsole.log("FIXTURE_READY");setInterval(()=>{},10000);`, { mode: 0o700 });
  // Like a systemd unit: the tmux server itself starts with the same locale-less environment.
  const server = spawn("tmux", ["-D", "-S", socket, "-f", path.join(root, "config/tmux.conf")], { stdio: "ignore", env: { ...process.env } });
  t.after(async () => {
    await exec("tmux", ["-S", socket, "kill-server"], { env: { ...process.env, LANG: "C.UTF-8" } }).catch(() => {});
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ["LANG", "LC_ALL", "LC_CTYPE"]) delete process.env[key];
    Object.assign(process.env, Object.fromEntries(["LANG", "LC_ALL", "LC_CTYPE"].filter(key => saved[key]).map(key => [key, saved[key]])));
  });
  const store = new Sessions({
    root, stateDir: dir, socket,
    projects: [{ id: "agent-panel", name: "Panel", path: root }],
    agents: [{ id: "codex", name: "Codex", available: true, executable: fixture }],
  });
  for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await new Promise(r => setTimeout(r, 40));
  const record = await store.create({ projectId: "agent-panel", agentId: "codex", title: "Locale çğş", requestId: "locale-test-0000001" });
  const [session] = await store.list();
  assert.equal(session.id, record.id);
  assert.equal(session.status, "running");
  assert.deepEqual(session.geometry, { cols: 120, rows: 34 });
});
