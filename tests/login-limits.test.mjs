import test from "node:test";
import assert from "node:assert/strict";
import { LoginLimits } from "../server/login-limits.mjs";

const wrong = async () => { throw Object.assign(new Error("bad credentials"), { status: 401 }); };
test("successful account switching does not consume failed-password budgets", async () => {
  const limits = new LoginLimits(() => 1000000);
  for (let i = 0; i < 40; i++) assert.equal(await limits.run("same-ip", i % 2 ? "owner" : "guest", async () => "ok"), "ok");
  assert.equal(limits.failures.size, 0);
});
test("wrong passwords are throttled with an accurate expiry; another account stays accessible", async () => {
  let now = 1000000; const limits = new LoginLimits(() => now);
  for (let i = 0; i < 6; i++) await assert.rejects(limits.run("same-ip", "guest", wrong), e => e.status === 401);
  await assert.rejects(limits.run("same-ip", "GUEST", wrong), e => e.status === 429 && e.retryAfter === 600);
  assert.equal(await limits.run("same-ip", "owner", async () => "ok"), "ok");
  now += 600001;
  assert.equal(await limits.run("same-ip", "guest", async () => "ok"), "ok");
});
test("account risk slows distributed guessing without rejecting a correct password", async () => {
  const pauses = [], limits = new LoginLimits(() => 1000000, async ms => pauses.push(ms));
  for (let i = 0; i < 5; i++) await assert.rejects(limits.run("a", "guest", wrong));
  await limits.run("a", "guest", async () => "ok");
  for (let i = 0; i < 10; i++) await assert.rejects(limits.run("ip-" + i, "guest", wrong), e => e.status === 401);
  assert.ok(pauses.length > 0 && pauses.every(ms => ms <= 1000));
  assert.equal(await limits.run("new-ip", "guest", async () => "ok"), "ok");
  assert.equal(limits.failures.has(limits.keys("new-ip", "guest").account), false);
});
test("120 failures on unrelated accounts cannot lock out the owner for ten minutes", async () => {
  const limits = new LoginLimits(() => 1000000, async () => {});
  for (let i = 0; i < 120; i++) await assert.rejects(limits.run("ip-" + Math.floor(i / 24), "guest-" + i, wrong), e => e.status === 401);
  assert.equal(await limits.run("fresh-ip", "owner", async () => "ok"), "ok");
});
test("rapid request floods and concurrent password checks remain bounded", async () => {
  const limits = new LoginLimits(() => 1000000);
  for (let i = 0; i < 60; i++) await limits.run("ip", "owner", async () => true);
  await assert.rejects(limits.run("ip", "owner", async () => true), e => e.status === 429 && e.retryAfter === 60);
  const other = new LoginLimits(() => 1000000), finish = [];
  const op = () => new Promise(resolve => finish.push(resolve));
  const a = other.run("ip", "owner", op), b = other.run("ip", "owner", op);
  await assert.rejects(other.run("ip", "owner", op), e => e.status === 429 && e.retryAfter === 1);
  finish.forEach(resolve => resolve(true)); await Promise.all([a, b]);
});

test("in-flight attempts reserve the remaining pair and IP failure budgets", async () => {
  for (const scope of ["pair", "ip"]) {
    const limits = new LoginLimits(() => 1000000, async () => {});
    for (let i = 0; i < (scope === "pair" ? 5 : 23); i++)
      await assert.rejects(limits.run("ip", scope === "pair" ? "guest" : "user-" + i, wrong));
    let release;
    const pending = limits.run("ip", "guest", () => new Promise((_, reject) => { release = () => reject(Object.assign(new Error("wrong"), { status: 401 })); }));
    const rejected = assert.rejects(pending, e => e.status === 401);
    await assert.rejects(limits.run("ip", scope === "pair" ? "guest" : "another", wrong), e => e.status === 429 && e.retryAfter === 1);
    release(); await rejected;
    assert.equal(limits.pending.size, 0);
    const key = limits.keys("ip", "guest")[scope];
    assert.equal(limits.failures.get(key).length, scope === "pair" ? 6 : 24);
  }
});

test("successful and non-password failures release reserved capacity", async () => {
  const limits = new LoginLimits(() => 1000000, async () => {});
  for (let i = 0; i < 5; i++) await assert.rejects(limits.run("ip", "guest", wrong));
  await assert.rejects(limits.run("ip", "guest", async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); }));
  assert.equal(await limits.run("ip", "guest", async () => "ok"), "ok");
  assert.equal(limits.pending.size, 0); assert.equal(limits.active, 0);
});
test("global burst and concurrency remain bounded across independent IPs", async () => {
  const limits = new LoginLimits(() => 1000000, async () => {});
  for (let i = 0; i < 300; i++) await limits.run("ip-" + i, "owner", async () => true);
  await assert.rejects(limits.run("fresh-ip", "owner", async () => true), { status: 429, retryAfter: 60 });
  const concurrent = new LoginLimits(() => 1000000, async () => {}), finish = [];
  const pending = Array.from({ length: 4 }, (_, i) => concurrent.run("ip-" + i, "owner", () => new Promise(resolve => finish.push(resolve))));
  await assert.rejects(concurrent.run("extra", "owner", async () => true), { status: 429, retryAfter: 1 });
  finish.forEach(resolve => resolve(true)); await Promise.all(pending); assert.equal(concurrent.active, 0);
});
test("success clears pair/account failures but preserves IP history; 429 does not consume failure budgets", async () => {
  const limits = new LoginLimits(() => 1000000, async () => {}), keys = limits.keys("ip", "owner");
  await assert.rejects(limits.run("ip", "owner", wrong));
  await assert.rejects(limits.run("ip", "owner", async () => { throw Object.assign(new Error(), { status: 429 }); }));
  await limits.run("ip", "owner", async () => true);
  assert.equal(limits.failures.has(keys.account), false); assert.equal(limits.failures.has(keys.pair), false);
  assert.equal(limits.failures.get(keys.ip).length, 1); assert.equal(limits.pending.size, 0);
});
