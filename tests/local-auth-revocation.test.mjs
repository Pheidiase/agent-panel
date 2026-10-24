import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createLocalAuth } from "../server/local-auth.mjs";
import { setPassword } from "../ops/set-password.mjs";
import { localFixture, request } from "./fixtures/local-auth-fixture.mjs";

const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const source = index.slice(index.indexOf("  if (checkingAuth) return;"), index.indexOf("}, 5000).unref();"));
const tick = new Function("wss", "portalAuth", "grants", `let checkingAuth = false; return async () => {${source}}`);
test("CLI authVersion changes invalidate HTTP grants and all three socket types at the next check", async t => {
  const { state, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  const { grant, cookie } = await auth.login(request(), { username: "synthetic", password });
  const clients = ["terminal", "structured", "live"].map(route => ({ route, panel: { grant }, close(code) { this.code = code; } }));
  await tick({ clients }, auth, auth.grants)(); assert.ok(clients.every(ws => !ws.code));
  await setPassword({ state, args: ["--owner"], input: Readable.from(["new synthetic password\n"]), output: { write() {} } });
  await tick({ clients }, auth, auth.grants)(); assert.deepEqual(clients.map(ws => ws.code), [4001, 4001, 4001]);
  assert.equal(await auth.session(request(cookie.split(";")[0])), null); assert.equal(auth.grants.size, 0);
  const fresh = await auth.login(request(), { username: "synthetic", password: "new synthetic password" });
  assert.ok(fresh.grant.token !== grant.token);
  assert.doesNotMatch(source, /tmux|\.kill\(|\.stop\(/);
});
test("unreadable/corrupt accounts fail closed on HTTP and close every socket on the periodic tick", async t => {
  for (const problem of ["corrupt", "missing", "io"]) {
    const { state, store, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
    const { grant } = await auth.login(request(), { username: "synthetic", password });
    if (problem === "corrupt") fs.writeFileSync(store.file, "broken");
    if (problem === "missing") fs.unlinkSync(store.file);
    if (problem === "io") {
      const read = fs.readFileSync;
      t.mock.method(fs, "readFileSync", (file, ...args) => {
        if (file === path.join(state, "owner.json")) throw Object.assign(new Error(), { code: "EIO" });
        return read(file, ...args);
      });
    }
    const clients = [1, 2, 3].map(() => ({ panel: { grant }, close(code) { this.code = code; } }));
    await tick({ clients }, auth, auth.grants)(); assert.deepEqual(clients.map(ws => ws.code), [4001, 4001, 4001]);
    assert.equal(auth.grants.size, 0); t.mock.restoreAll();
  }
});
test("terminal input checks the fresh owner before touching agent input", async t => {
  const { state, store, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  const { grant } = await auth.login(request(), { username: "synthetic", password });
  store.setOwnerCredential({ username: "synthetic", salt: "0".repeat(32), hash: "0".repeat(128) });
  const start = index.indexOf('      try { if (!await portalAuth.check(g.token))', index.indexOf('ws.on("message", orderedMessages({', index.indexOf('terminal.onData')));
  const guard = index.slice(start, index.indexOf('      let msg;', start));
  const handle = new Function("portalAuth", "g", "ws", "active", "grants", `return (async () => {${guard} return "agent-write";})()`);
  const ws = { close(code) { this.code = code; } };
  assert.notEqual(await handle(auth, grant, ws, () => true, auth.grants), "agent-write"); assert.equal(ws.code, 4001);
});
