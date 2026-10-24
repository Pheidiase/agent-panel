import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readAuthConfig, createAuth } from "../server/auth.mjs";
import { tempState, request } from "./fixtures/local-auth-fixture.mjs";

test("missing auth.json is local even with old credentials or portal config; mode stays fixed", t => {
  const state = tempState(t);
  for (const file of ["auth-client.json", "credentials.json"]) fs.writeFileSync(path.join(state, file), "not used");
  assert.deepEqual(readAuthConfig(state), { mode: "local", trustProxyHeader: false });
  t.mock.method(globalThis, "fetch", assert.fail);
  const auth = createAuth({ state, app: "panel", port: 4317 });
  assert.deepEqual(auth.metadata(), { mode: "local", configured: false });
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }));
  assert.equal(auth.mode, "local");
  assert.equal(createAuth({ state, app: "panel", port: 4317 }).mode, "portal");
});
test("explicit mode and boolean proxy trust are the only accepted config fields", t => {
  const state = tempState(t), file = path.join(state, "auth.json");
  for (const c of [null, [], {}, { mode: "other" }, { mode: 1 }, { mode: "local", trustProxyHeader: 1 }, { mode: "local", typo: true }]) {
    fs.writeFileSync(file, JSON.stringify(c));
    assert.throws(() => createAuth({ state, app: "panel", port: 4317 }), { status: 503 });
  }
  fs.writeFileSync(file, "{"); assert.throws(() => readAuthConfig(state), { status: 503 });
  for (const mode of ["local", "portal"]) {
    fs.writeFileSync(file, JSON.stringify({ mode, trustProxyHeader: true }));
    assert.deepEqual(readAuthConfig(state), { mode, trustProxyHeader: true });
  }
});
test("unreadable, non-file and symlink configs never fall back to local", t => {
  const state = tempState(t), file = path.join(state, "auth.json");
  fs.mkdirSync(file); assert.throws(() => readAuthConfig(state), { status: 503 }); fs.rmdirSync(file);
  fs.symlinkSync("missing", file); assert.throws(() => readAuthConfig(state), { status: 503 }); fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({ mode: "portal" }));
  t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error(), { code: "EACCES" }); });
  assert.throws(() => readAuthConfig(state), { status: 503 });
});
test("portal backend errors never try a local owner", async t => {
  const state = tempState(t); fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }));
  const auth = createAuth({ state, app: "panel", port: 4317 });
  assert.deepEqual(auth.metadata(), { mode: "portal" });
  await assert.rejects(auth.session(request("panel_auth=" + "x".repeat(43))), { status: 503 });
  assert.equal(auth.mode, "portal"); assert.equal(auth.login, undefined);
});
