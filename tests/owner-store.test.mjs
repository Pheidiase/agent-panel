import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OwnerStore, validateOwnerRecord } from "../server/owner-store.mjs";
import { privateJson } from "../server/json-store.mjs";
import { withUserLock } from "../server/user-lock.mjs";
import { localFixture, tempState } from "./fixtures/local-auth-fixture.mjs";

test("owner schema rejects extra owners, invalid profiles, credentials, versions and identities", t => {
  const { owner } = localFixture(t);
  for (const patch of [{ owner: false }, { enabled: false }, { version: 2 }, { authVersion: 0 }, { authVersion: 1.5 },
    { authVersion: Number.MAX_SAFE_INTEGER + 1 }, { id: "wrong" }, { createdAt: "yesterday" }, { createdAt: "2026-01-01" },
    { hash: "f".repeat(127) }, { salt: "F".repeat(32) }, { username: " spaced " }, { username: "\u0000" },
    { scrypt: { version: 3 } }, { scrypt: { ...owner.scrypt, N: 1 << 25 } }, { users: [owner] }])
    assert.throws(() => validateOwnerRecord({ ...owner, ...patch }), { status: 503 });
  assert.throws(() => validateOwnerRecord(null), { status: 503 });
  assert.throws(() => validateOwnerRecord([owner]), { status: 503 });
});
test("owner writes preserve id/date, increment version, reread under lock and prevent overflow", t => {
  const { store, owner, credential } = localFixture(t);
  const changed = store.setOwnerCredential({ username: "renamed", ...credential });
  assert.equal(changed.id, owner.id); assert.equal(changed.createdAt, owner.createdAt); assert.equal(changed.authVersion, 2);
  const result = store.setOwnerCredential(credential, { preserveName: true });
  assert.equal(result.username, "renamed"); assert.equal(result.authVersion, 3);
  store.write({ ...result, authVersion: Number.MAX_SAFE_INTEGER });
  assert.throws(() => store.setOwnerCredential(credential, { preserveName: true }), { status: 503 });
});
test("privateJson writes atomically with private modes and cleans failed temporary files", t => {
  const state = tempState(t), file = path.join(state, "nested", "sample.json");
  privateJson(file, { ok: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error(), { code: "EIO" }); });
  assert.throws(() => privateJson(file, { ok: false }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ok: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sample.json"]);
});
test("active or abandoned locks are never removed by another writer; failed callbacks release their own lock", t => {
  const { state, store, credential } = localFixture(t), lock = path.join(state, "owner.json.lock");
  fs.mkdirSync(lock); fs.utimesSync(lock, 0, 0);
  assert.throws(() => store.setOwnerCredential({ username: "synthetic", ...credential }), { status: 503 });
  assert.equal(fs.existsSync(lock), true); fs.rmdirSync(lock);
  assert.throws(() => withUserLock(state, () => { throw new Error("failed"); }), /failed/);
  assert.equal(fs.existsSync(lock), false);
});
test("missing account is distinct from corrupted, symlink, non-file or unsafe permissions", t => {
  const state = tempState(t), store = new OwnerStore(state);
  assert.equal(store.read(), null);
  fs.writeFileSync(store.file, "broken", { mode: 0o600 }); assert.throws(() => store.read(), { status: 503 }); fs.unlinkSync(store.file);
  fs.symlinkSync("missing", store.file); assert.throws(() => store.read(), { status: 503 }); fs.unlinkSync(store.file);
  fs.mkdirSync(store.file); assert.throws(() => store.read(), { status: 503 }); fs.rmdirSync(store.file);
  fs.writeFileSync(store.file, "{}", { mode: 0o644 }); fs.chmodSync(store.file, 0o644); assert.throws(() => store.read(), { status: 503 });
  fs.chmodSync(state, 0o755); assert.throws(() => store.read(), { status: 503 });
});
