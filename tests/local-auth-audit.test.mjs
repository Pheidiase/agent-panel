import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { AuditLog } from "../server/audit.mjs";
import { LoginLimits } from "../server/login-limits.mjs";
import { OwnerStore } from "../server/owner-store.mjs";
import { createLocalAuth } from "../server/local-auth.mjs";
import { setPassword } from "../ops/set-password.mjs";
import { tempState, localFixture, request, password, runPassword, childProcessAvailable } from "./fixtures/local-auth-fixture.mjs";

test("audit whitelists fields, caps lengths, skips damaged lines and rotates privately", t => {
  const state = tempState(t), audit = new AuditLog(state, { maxBytes: 1024 });
  audit.record("login.ok", { actor: { id: "id", username: "owner" }, ip: "x".repeat(300), ua: "u".repeat(500),
    password: "SECRET", token: "SECRET", csrf: "SECRET", salt: "SECRET", hash: "SECRET", headers: { key: "SECRET" },
    reason: "SECRET", changes: { password: true, key: "SECRET" } });
  assert.doesNotMatch(fs.readFileSync(audit.file, "utf8"), /SECRET/);
  const event = audit.read()[0]; assert.equal(event.ip.length, 64); assert.equal(event.ua.length, 200);
  for (let i = 0; i < 20; i++) audit.record("login.fail", { ip: "192.0.2.1", reason: "LOGIN_FAILED" });
  assert.ok(fs.statSync(audit.file).size <= 1024); assert.ok(fs.statSync(audit.old).size <= 1024);
  for (const file of [audit.file, audit.old]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const count = audit.read().length; fs.appendFileSync(audit.file, "broken\n{}"); assert.equal(audit.read().length, count);
  assert.deepEqual(fs.readdirSync(state).sort(), ["audit.1.jsonl", "audit.jsonl"]);
});
test("audit lock/disk/rotated-file errors never block login or password changes; warning is fixed and once", async t => {
  for (const problem of ["lock", "current-directory", "old-directory", "disk"]) {
    const { state, password } = localFixture(t), audit = new AuditLog(state), warnings = [];
    t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
    if (problem === "lock") fs.mkdirSync(path.join(state, "audit.jsonl.lock"));
    if (problem === "current-directory") fs.mkdirSync(audit.file);
    if (problem === "old-directory") fs.mkdirSync(audit.old);
    if (problem === "disk") t.mock.method(fs, "appendFileSync", () => { throw Object.assign(new Error("SECRET"), { code: "ENOSPC" }); });
    const auth = createLocalAuth({ state, app: "panel", port: 4317 });
    await assert.rejects(auth.login(request(), { username: "synthetic", password: "wrong" }), { status: 401, code: "LOGIN_FAILED" });
    const { grant } = await auth.login(request(), { username: "synthetic", password }); assert.ok(grant.token);
    await auth.logout(request(), grant);
    assert.equal(warnings.length, 1); assert.equal(warnings[0], "Denetim günlüğüne erişilemiyor.");
    await setPassword({ state, args: ["--owner"], input: Readable.from([password + "\n"]), output: { write() {} } });
    assert.equal(new AuditLog(state).read().length, 0);
    t.mock.restoreAll();
  }
});
test("owner read failure during audit attribution preserves the original login failure", async t => {
  const { state } = localFixture(t), read = OwnerStore.prototype.read;
  let reads = 0;
  t.mock.method(OwnerStore.prototype, "read", function () {
    if (++reads === 2) throw new Error("AUDIT-READ-SECRET");
    return read.call(this);
  });
  const auth = createLocalAuth({ state, app: "panel", port: 4317 });
  await assert.rejects(auth.login(request(), { username: "synthetic", password: "wrong" }), {
    status: 401, code: "LOGIN_FAILED", message: "Kullanıcı adı veya parola hatalı.",
  });
  assert.equal(reads, 2); assert.equal(auth.grants.size, 0);
  const event = new AuditLog(state).read()[0];
  assert.equal(event.type, "login.fail"); assert.equal(event.actor, undefined);
  assert.equal(event.reason, "LOGIN_FAILED"); assert.doesNotMatch(JSON.stringify(event), /AUDIT-READ-SECRET/);
});
test("untrusted login usernames are never recorded; limited events deduplicate with bounded memory", async t => {
  const { state } = localFixture(t), events = [];
  t.mock.method(AuditLog.prototype, "record", (type, fields) => events.push({ type, fields }));
  const auth = createLocalAuth({ state, app: "panel", port: 4317 });
  await assert.rejects(auth.login(request(), { username: "SYNTHETIC-SECRET-USERNAME", password: "bad" }), { status: 401 });
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC-SECRET-USERNAME/);
  events.length = 0;
  t.mock.method(LoginLimits.prototype, "run", async () => { throw Object.assign(new Error("limited"), { status: 429 }); });
  for (let i = 0; i < 5002; i++) {
    const req = request(null, undefined, "2001:db8::" + i.toString(16));
    await assert.rejects(auth.login(req, { username: "synthetic", password }), { status: 429 });
  }
  assert.equal(events.length, 5000);
  await assert.rejects(auth.login(request(null, undefined, "2001:db8::1"), { username: "synthetic", password }), { status: 429 });
  assert.equal(events.length, 5000);
});
test("audit lock is separate from owner lock and all writers release it after failure", t => {
  const { state } = localFixture(t), audit = new AuditLog(state);
  fs.mkdirSync(path.join(state, "owner.json.lock")); audit.record("login.fail", { reason: "LOGIN_FAILED" });
  assert.equal(audit.read().length, 1); assert.equal(fs.existsSync(path.join(state, "audit.jsonl.lock")), false);
  fs.rmdirSync(path.join(state, "owner.json.lock"));
  t.mock.method(fs, "appendFileSync", () => { throw new Error("failure"); });
  t.mock.method(console, "error", () => {}); audit.record("logout");
  assert.equal(fs.existsSync(path.join(state, "audit.jsonl.lock")), false);
});
test("real CLI and web audit rotation share one lock without corrupting JSON lines", async t => {
  if (!childProcessAvailable(t)) return;
  const { state } = localFixture(t), audit = new AuditLog(state, { maxBytes: 1024 });
  const writing = Promise.all([runPassword(state), runPassword(state)]);
  for (let i = 0; i < 100; i++) {
    audit.record("login.fail", { ip: "192.0.2.1", reason: "LOGIN_FAILED" });
    await new Promise(resolve => setImmediate(resolve));
  }
  await writing;
  for (const file of [audit.file, audit.old]) {
    assert.ok(fs.statSync(file).size <= 1 << 20);
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});
