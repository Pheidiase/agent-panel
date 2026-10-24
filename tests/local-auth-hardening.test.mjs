import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LocalIdentity, validateLogin } from "../server/local-identity.mjs";
import { derivePassword, passwordProfile, validatePassword, CURRENT_SCRYPT } from "../server/passwords.mjs";
import { localFixture } from "./fixtures/local-auth-fixture.mjs";

test("scrypt v2 parameters and the four-derivation process cap are preserved", async () => {
  assert.deepEqual(CURRENT_SCRYPT, { version: 2, N: 16384, r: 8, p: 5 });
  const work = Array.from({ length: 4 }, () => derivePassword("synthetic", "0".repeat(32)));
  await assert.rejects(derivePassword("synthetic", "0".repeat(32)), { status: 429, retryAfter: 1 });
  await Promise.all(work);
  assert.equal((await derivePassword("synthetic", "0".repeat(32))).length, 64);
  assert.throws(() => passwordProfile({ scrypt: { version: 900 } }), { status: 503 });
});
test("creation validates 12-200 characters, login keeps legacy short passwords compatible", () => {
  for (const value of ["x".repeat(11), "x".repeat(201), null, 123]) assert.throws(() => validatePassword(value), { status: 400 });
  for (const value of ["x".repeat(12), "x".repeat(200)]) assert.equal(validatePassword(value), value);
  assert.doesNotThrow(() => validateLogin({ username: "synthetic", password: "short" }));
  for (const data of [null, [], "x", {}, { username: [], password: "x" }, { username: "x", password: {} },
    { username: "x".repeat(101), password: "x" }, { username: "x", password: "x".repeat(201) }, { username: "x", password: "x", other: true }])
    assert.throws(() => validateLogin(data), { status: 400 });
});
test("unknown and known usernames use the owner's scrypt profile on failed login", async t => {
  const legacy = { version: 1, N: 16384, r: 8, p: 1 };
  for (const [name, scrypt] of [["implicit v1", undefined], ["explicit v1", legacy], ["v2", CURRENT_SCRYPT]]) {
    await t.test(name, async t => {
      const { state, store, owner } = localFixture(t, { legacy: scrypt?.version !== 2 });
      if (scrypt) store.write({ ...owner, scrypt: { ...scrypt } });
      const before = store.read(), calls = [], wrongHash = Buffer.from(owner.hash, "hex");
      wrongHash[0] ^= 0xff;
      const identity = new LocalIdentity(state, new Map(), {
        derive: async (password, salt, profile) => { calls.push({ salt, profile }); return wrongHash; },
        record: async () => assert.fail("failed login must not upgrade the password"),
      });
      for (const username of [owner.username, "unknown-owner"])
        await assert.rejects(identity.login(username, "wrong password"), { status: 401, code: "LOGIN_FAILED" });
      assert.deepEqual(calls, [
        { salt: owner.salt, profile: scrypt || legacy },
        { salt: identity.dummySalt, profile: scrypt || legacy },
      ]);
      assert.notEqual(identity.dummySalt, owner.salt);
      assert.equal(identity.grants.size, 0); assert.deepEqual(store.read(), before);
    });
  }
});
test("eight owner sessions and absolute eight-hour expiry use one grants map", async t => {
  const { state, password } = localFixture(t); let now = 10000;
  const grants = new Map(), identity = new LocalIdentity(state, grants, { now: () => now });
  const first = await identity.login("synthetic", password);
  for (let i = 0; i < 8; i++) await identity.login("synthetic", password);
  assert.equal(grants.size, 8); assert.equal(identity.check(first.token), null);
  const latest = [...grants.values()].at(-1);
  assert.equal(identity.check(latest.token), latest);
  now += 8 * 3600000;
  assert.equal(identity.check(latest.token), null);
});
test("a valid short legacy password upgrades without changing owner identity or authVersion", async t => {
  const { state, store, owner } = localFixture(t, { legacy: true });
  store.write({ ...owner, hash: crypto.scryptSync("short", owner.salt, 64).toString("hex") });
  const grant = await new LocalIdentity(state).login("synthetic", "short");
  assert.equal(grant.userId, owner.id); assert.equal(store.read().authVersion, 1); assert.equal(store.read().scrypt.version, 2);
});
