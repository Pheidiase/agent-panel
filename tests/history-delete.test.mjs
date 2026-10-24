// Permanent history deletion: every agent is deleted through its own mechanism
// (Claude files, Codex app-server request, Hermes CLI). The tests use a
// throw-away home directory and stubs; no real history and no model is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryDeleter, ACTIVE_WINDOW_S, BATCH_MAX } from "../server/history-delete.mjs";
import { HistoryPrefs } from "../server/history-prefs.mjs";

const NOW = 2_000_000_000;
const OLD = NOW - ACTIVE_WINDOW_S - 60;
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-hdel-"));
  const folder = path.join(home, ".claude/projects/-tmp-proje");
  fs.mkdirSync(path.join(folder, U1), { recursive: true });
  fs.writeFileSync(path.join(folder, `${U1}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(folder, U1, "tool.txt"), "x");
  fs.writeFileSync(path.join(folder, `${U2}.jsonl`), "{}\n");
  fs.mkdirSync(path.join(home, ".claude/file-history", U1), { recursive: true });
  return { home, folder };
}

function deleter(home, records, extra = {}) {
  return new HistoryDeleter({
    listHistory: async () => records,
    agents: { hermes: "/bin/hermes-stub" },
    codexCommand: { command: "/bin/codex-stub", args: ["app-server"] },
    home,
    now: () => NOW,
    ...extra,
  });
}

test("Claude: removes only that session's files", async () => {
  const { home, folder } = fakeHome();
  const d = deleter(home, [{ agentId: "claude", id: U1, updatedAt: OLD }, { agentId: "claude", id: U2, updatedAt: OLD }]);
  const [r] = await d.deleteMany([{ agentId: "claude", id: U1 }]);
  assert.deepEqual(r, { key: `claude:${U1}`, ok: true });
  assert.equal(fs.existsSync(path.join(folder, `${U1}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(folder, U1)), false);
  assert.equal(fs.existsSync(path.join(home, ".claude/file-history", U1)), false);
  assert.equal(fs.existsSync(path.join(folder, `${U2}.jsonl`)), true, "other sessions stay");
});

test("refuses ids that are not in the current history listing", async () => {
  const { home, folder } = fakeHome();
  const d = deleter(home, [{ agentId: "claude", id: U1, updatedAt: OLD }]);
  const [r] = await d.deleteMany([{ agentId: "claude", id: U2 }]);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(folder, `${U2}.jsonl`)), true);
});

test("Claude refuses a symlinked file-history parent before deleting any transcript", async t => {
  const { home, folder } = fakeHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "panel-history-outside-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(outside, U1)); fs.writeFileSync(path.join(outside, U1, "keep"), "keep");
  fs.rmdirSync(path.join(home, ".claude/file-history", U1)); fs.rmdirSync(path.join(home, ".claude/file-history"));
  fs.symlinkSync(outside, path.join(home, ".claude/file-history"));
  const d = deleter(home, [{ agentId: "claude", id: U1, updatedAt: OLD }]);
  const [result] = await d.deleteMany([{ agentId: "claude", id: U1 }]);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(outside, U1, "keep"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(folder, `${U1}.jsonl`)), true);
});

test("refuses a recently used record (it may still be open)", async () => {
  const { home, folder } = fakeHome();
  const d = deleter(home, [{ agentId: "claude", id: U1, updatedAt: NOW - 30 }]);
  const [r] = await d.deleteMany([{ agentId: "claude", id: U1 }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /az önce kullanıldı/);
  assert.equal(fs.existsSync(path.join(folder, `${U1}.jsonl`)), true);
});

test("rejects malformed input before touching anything", async () => {
  const { home } = fakeHome();
  const d = deleter(home, []);
  await assert.rejects(d.deleteMany([]), { status: 400 });
  await assert.rejects(d.deleteMany("x"), { status: 400 });
  await assert.rejects(d.deleteMany(Array.from({ length: BATCH_MAX + 1 }, () => ({ agentId: "claude", id: U1 }))), { status: 400 });
  await assert.rejects(d.deleteMany([{ agentId: "gemini", id: U1 }]), { status: 400 });
  await assert.rejects(d.deleteMany([{ agentId: "claude", id: "../../etc/passwd" }]), { status: 400 });
  await assert.rejects(d.deleteMany([{ agentId: "codex", id: "not-a-uuid" }]), { status: 400 });
  await assert.rejects(d.deleteMany([{ agentId: "hermes", id: "a b;rm" }]), { status: 400 });
});

test("Hermes: uses the official CLI with --yes and the exact id", async () => {
  const calls = [];
  const d = deleter(fakeHome().home, [{ agentId: "hermes", id: "20261009_abc", updatedAt: OLD }], {
    run: async (command, args) => { calls.push([command, ...args]); return ""; },
  });
  const [r] = await d.deleteMany([{ agentId: "hermes", id: "20261009_abc" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [["/bin/hermes-stub", "sessions", "delete", "--yes", "20261009_abc"]]);
});

test("Hermes rejects option-like ids even when listed, before invoking the CLI", async () => {
  let calls = 0;
  const ids = ["--help", "-a", "--yes"];
  const d = deleter("/unused", ids.map(id => ({ agentId: "hermes", id, updatedAt: OLD })), {
    run: async () => { calls++; return ""; },
  });
  for (const id of ids) await assert.rejects(d.deleteMany([{ agentId: "hermes", id }]), { status: 400 });
  assert.equal(calls, 0);
});

test("Hermes: a 'No session' answer is not reported as deleted", async () => {
  const d = deleter(fakeHome().home, [{ agentId: "hermes", id: "gone_1", updatedAt: OLD }], {
    run: async () => "No session 'gone_1'. Run: hermes sessions list to find the id.\n",
  });
  const [r] = await d.deleteMany([{ agentId: "hermes", id: "gone_1" }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /bulunamadı/);
});

test("Codex: initializes, sends thread/delete, and always closes the connection", async () => {
  const sent = [];
  let closed = 0;
  const connect = () => ({
    start() {},
    async request(method, params) { sent.push([method, params]); return {}; },
    async close() { closed++; },
  });
  const d = deleter(fakeHome().home, [{ agentId: "codex", id: U3, updatedAt: OLD }], { connect });
  const [r] = await d.deleteMany([{ agentId: "codex", id: U3 }]);
  assert.equal(r.ok, true);
  assert.deepEqual(sent.map((x) => x[0]), ["initialize", "thread/delete"]);
  assert.deepEqual(sent[1][1], { threadId: U3 });
  assert.equal(closed, 1);
});

test("Codex failure is reported per item and still closes the connection", async () => {
  let closed = 0;
  const connect = () => ({
    start() {},
    async request(method) { if (method === "thread/delete") throw new Error("thread bulunamadı"); return {}; },
    async close() { closed++; },
  });
  const d = deleter(fakeHome().home, [{ agentId: "codex", id: U3, updatedAt: OLD }, { agentId: "claude", id: U2, updatedAt: OLD }], { connect });
  const out = await d.deleteMany([{ agentId: "codex", id: U3 }, { agentId: "claude", id: U2 }]);
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /bulunamadı/);
  assert.equal(out[1].ok, true, "one failure does not stop the others");
  assert.equal(closed, 1);
});

test("forgets hide flags and titles of deleted records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-forget-"));
  const prefs = new HistoryPrefs(dir);
  prefs.setHidden({ keys: ["claude:a", "codex:b"], hidden: true });
  prefs.setTitle({ key: "claude:a", title: "Ad" });
  const snap = prefs.forget(["claude:a", "hermes:yok"]);
  assert.deepEqual(snap.hidden, ["codex:b"]);
  assert.deepEqual(snap.titles, {});
  assert.deepEqual(new HistoryPrefs(dir).snapshot().hidden, ["codex:b"]);
});
