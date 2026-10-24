import test from "node:test";
import assert from "node:assert/strict";
import { LocalIdentity } from "../server/local-identity.mjs";
import { LoginLimits } from "../server/login-limits.mjs";
import { derivePassword, passwordRecord } from "../server/passwords.mjs";
import { localFixture, runPassword, childProcessAvailable } from "./fixtures/local-auth-fixture.mjs";

test("two legacy logins upgrade concurrently without consuming failure budgets or changing authVersion", async t => {
  const { state, store, owner, password } = localFixture(t, { legacy: true });
  const identity = new LocalIdentity(state), limits = new LoginLimits();
  const run = ip => limits.run(ip, owner.username, () => identity.login(owner.username, password));
  const results = await Promise.allSettled([run("a"), run("b")]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "fulfilled"]);
  assert.equal(limits.failures.size, 0);
  assert.equal(store.read().scrypt.version, 2); assert.equal(store.read().authVersion, 1); assert.equal(store.read().id, owner.id);
});
test("a separate CLI password change wins while an old login is hashing", async t => {
  if (!childProcessAvailable(t)) return;
  const { state, store, owner, password } = localFixture(t, { legacy: true });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const identity = new LocalIdentity(state, new Map(), { derive: async (...args) => { const value = await derivePassword(...args); entered(); await gate; return value; } });
  const pending = identity.login(owner.username, password);
  await waiting;
  const changed = await runPassword(state, ["--owner"], "different synthetic password\n");
  assert.equal(changed.code, 0); assert.equal(store.read().authVersion, 2);
  release(); await assert.rejects(pending, { status: 401 }); assert.equal(identity.grants.size, 0);
});
test("a second same-version hash change during retry cannot spin indefinitely", async t => {
  const { state, store, owner, password } = localFixture(t, { legacy: true });
  let calls = 0;
  const identity = new LocalIdentity(state, new Map(), { derive: async (...args) => {
    const value = await derivePassword(...args); calls++;
    const current = store.read(); store.write({ ...current, ...await passwordRecord(password) });
    return value;
  } });
  await assert.rejects(identity.login(owner.username, password), { status: 401 });
  assert.equal(calls, 2); assert.equal(identity.grants.size, 0); assert.equal(store.read().authVersion, 1);
});
