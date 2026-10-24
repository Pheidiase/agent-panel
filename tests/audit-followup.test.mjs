import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPortalAuth } from "../server/portal-auth.mjs";
import { fileLock } from "../server/file-lock.mjs";
import { ImageUploads, UPLOAD_TTL_MS } from "../server/uploads.mjs";
import { Sessions } from "../server/session-store.mjs";
import { StructuredStore } from "../server/structured-store.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { CodexManager } from "../server/codex-manager.mjs";
import { ClaudeManager, ClaudeConnection } from "../server/claude-manager.mjs";

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function portal(t, limits) {
  const state = directory(t);
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43), portalInternal: "http://127.0.0.1:9", portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }));
  return createPortalAuth({ state, app: "panel", port: 1234, limits });
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("portal checks share only in-flight work, bound concurrency, and revalidate owner access", async t => {
  const auth = portal(t), waiting = [], calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body)); const wait = deferred(); waiting.push(wait); return wait.promise;
  });
  const checks = Array.from({ length: 12 }, () => auth.check("same"));
  assert.equal(calls.length, 1);
  waiting.shift().resolve(response({ owner: true, expires: Date.now() + 60000 }));
  await Promise.all(checks);
  const next = auth.check("same");
  assert.equal(calls.length, 2, "no successful authorization cache");
  waiting.shift().resolve(response({ owner: false }));
  assert.equal(await next, null); assert.equal(auth.grants.has("same"), false);
  const pending = Array.from({ length: 8 }, (_, i) => auth.check(`token-${i}`));
  await assert.rejects(auth.check("overflow"), { status: 503 });
  for (const wait of waiting.splice(0)) wait.resolve(response(null, 401));
  await Promise.all(pending);
  const again = auth.check("new"); waiting.shift().resolve(response(null, 401));
  assert.equal(await again, null);
});

test("full login state capacity preserves existing callbacks and permits same-browser retry", async t => {
  const auth = portal(t, { starts: 1e6 }), req = { url: "/", headers: { host: "127.0.0.1:1234" } };
  t.mock.method(globalThis, "fetch", async () => response({ owner: true, token: "a".repeat(43), expires: Date.now() + 60000 }));
  const first = auth.start(req), nonce = new URL(first.location).searchParams.get("state");
  for (let i = 1; i < 2000; i++) auth.start(req);
  assert.throws(() => auth.start(req), { status: 503 });
  const retry = { ...req, headers: { ...req.headers, cookie: first.cookie.split(";")[0] } };
  assert.equal(new URL(auth.start(retry).location).searchParams.get("state"), nonce);
  const url = new URL(`http://localhost/auth/callback?state=${nonce}&code=fixture`);
  assert.equal((await auth.callback(retry, url)).location, "/");
  await assert.rejects(auth.callback(retry, url), { status: 400 });
});

test("logout clears a grant and cookie when the portal says it already expired", async t => {
  const auth = portal(t), token = "a".repeat(43);
  auth.grants.set(token, { token });
  t.mock.method(globalThis, "fetch", async () => response(null, 401));
  assert.match(await auth.logout({ headers: { host: "127.0.0.1:1234" } }, { token }), /Max-Age=0/);
  assert.equal(auth.grants.has(token), false);
});

test("file locks recover a dead owner and protect live, legacy, and replacement locks", t => {
  const file = path.join(directory(t), "record.lock");
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  fs.writeFileSync(file, JSON.stringify({ pid: dead.pid }));
  const stale = fs.statSync(file);
  fs.writeFileSync(`${file}.recover-${stale.dev}-${stale.ino}`, JSON.stringify({ pid: dead.pid }));
  const unlock = fileLock(file);
  assert.throws(() => fileLock(file), { status: 409 });
  unlock(); assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(file);
  assert.throws(() => fileLock(file), { status: 409 });
  fs.rmdirSync(file);
  const release = fileLock(file);
  // The owner's candidate remains linked while a replacement gets a different inode.
  fs.renameSync(file, file + ".old"); fs.writeFileSync(file, "replacement");
  release(); assert.equal(fs.readFileSync(file, "utf8"), "replacement");
});

test("image uploads enforce signatures, exact byte/count quotas, privacy and expiry", t => {
  const dir = directory(t), body = Buffer.from("RIFF0000WEBP00000000");
  let now = Date.now();
  const uploads = new ImageUploads(dir, { now: () => now, maxFiles: 2, maxBytes: body.length * 2 });
  for (const invalid of [Buffer.from("RIFF0000WAVE00000000"), Buffer.from("RIFF0000AVI 00000000"), Buffer.from("short")])
    assert.throws(() => uploads.save(invalid, "image/webp"), { status: 400 });
  const first = uploads.save(body, "image/webp"), second = uploads.save(body, "image/webp");
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  assert.throws(() => uploads.save(body, "image/webp"), { status: 413 });
  assert.equal(fs.readdirSync(dir).length, 2);
  now += UPLOAD_TTL_MS + 1000; uploads.sweep();
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), false);
  const exact = Buffer.alloc(10 * 1024 * 1024); body.copy(exact);
  const large = new ImageUploads(dir);
  large.save(exact, "image/webp");
  assert.throws(() => large.save(Buffer.concat([exact, Buffer.from("x")]), "image/webp"), { status: 413 });
});

test("record save failure rolls back only the new terminal and permits a clean retry", async () => {
  let starts = 0, kills = 0, fail = true;
  const old = { id: "other" };
  const store = { projects: [{ id: "p", path: "/tmp", name: "P" }], agents: [{ id: "hermes", available: true, name: "H", executable: "/unused" }],
    root: "/tmp", records: [old], list: async () => [], tmux: async () => { starts++; },
    save: () => { if (fail) throw new Error("ENOSPC"); }, kill: async () => { kills++; }, startTranscript: async () => {} };
  const input = { projectId: "p", agentId: "hermes", title: "fixture", requestId: "audit-create-0001", allowParallel: true };
  await assert.rejects(Sessions.prototype.createSerial.call(store, input), /ENOSPC/);
  assert.deepEqual(store.records, [old]); assert.equal(starts, 1); assert.equal(kills, 1);
  fail = false; await Sessions.prototype.createSerial.call(store, input);
  assert.equal(starts, 2); assert.equal(store.records.length, 2);
});

test("creation reservations do not hold the metadata queue and deduplicate retries", async t => {
  const store = new StructuredStore({ stateDir: directory(t) }), wait = deferred();
  let starts = 0;
  const first = store.enqueueCreate("one", async () => { starts++; await wait.promise; return 42; });
  assert.equal(store.enqueueCreate("one", () => assert.fail()), first);
  assert.equal(await store.enqueue(() => 7), 7);
  const second = store.enqueueCreate("three", async () => 9);
  assert.equal(await second, 9);
  wait.resolve(); assert.equal(await first, 42); assert.equal(starts, 1);
  assert.equal(store.pendingCreates.size, 0);
});

test("all chat providers apply one shared four-process limit, including reconnects", t => {
  const store = new StructuredStore({ stateDir: directory(t) });
  store.runtimeMaps.add(new Map([["h1", { conn: { alive: true } }], ["h2", { status: "starting" }]]));
  const codex = new Map([["c", { conn: { alive: true } }]]), claude = new Map([["a", { conn: { alive: true } }]]);
  store.runtimeMaps.add(codex); store.runtimeMaps.add(claude);
  for (const Manager of [StructuredManager, CodexManager, ClaudeManager])
    assert.throws(() => Manager.prototype._startSession.call({ store }, { id: "fifth" }), { status: 409 });
  store.assertRunningCapacity("h1"); // replacing the same connection uses its own slot
  claude.clear(); store.assertRunningCapacity("fifth");
});

test("Hermes rejects prompt and setting races before RPC or log writes", async () => {
  const manager = Object.create(StructuredManager.prototype), request = deferred(); let rpc = 0;
  const runtime = { id: "x", acpSessionId: "native", inflight: 0, settingsChanging: false, pendingApprovals: new Map(), models: { currentModelId: "old" }, conn: { alive: true, request: async () => { rpc++; return request.promise; } } };
  Object.assign(manager, { _own: () => ({}), _ensureRuntime: async () => runtime, _broadcastState: () => {}, store: { get: () => ({}) } });
  const changing = manager.setModel("x", "new"); await Promise.resolve();
  await assert.rejects(manager.setMode("x", "mode"), { status: 409 });
  await assert.rejects(manager.prompt("x", "hello"), { status: 409 });
  assert.equal(rpc, 1); assert.equal(runtime.models.currentModelId, "old");
  request.resolve(); await changing;
  assert.equal(runtime.settingsChanging, false); assert.equal(runtime.models.currentModelId, "new");
  runtime.inflight = 1;
  await assert.rejects(manager.setModel("x", "other"), { status: 409 });
});

test("Claude rejects complete oversized lines before protocol dispatch", () => {
  const connection = new ClaudeConnection({ command: "unused" }); let handled = 0, killed = 0;
  connection._handleLine = () => handled++; connection._kill = () => killed++;
  connection._onStdout(Buffer.from(JSON.stringify({ type: "system", x: "x".repeat(8 * 1024 * 1024) }) + "\n"));
  assert.equal(handled, 0); assert.equal(killed, 1);
});

test("event sequence survives restart and transcript starts are shared", async t => {
  const dir = directory(t), store = new StructuredStore({ stateDir: dir });
  for (let i = 1; i <= 100; i++) assert.equal(store.appendEvent("x", { kind: "assistant", text: "界" }).seq, i);
  const restarted = new StructuredStore({ stateDir: dir });
  assert.equal(restarted.appendEvent("x", { kind: "assistant", text: "next" }).seq, 101);
  const wait = deferred(); let captures = 0;
  const sessions = { transcriptStarts: new Map(), startTranscriptSerial: async () => { captures++; await wait.promise; } };
  const a = Sessions.prototype.startTranscript.call(sessions, { id: "x" });
  const b = Sessions.prototype.startTranscript.call(sessions, { id: "x" });
  assert.equal(captures, 1); wait.resolve(); await Promise.all([a, b]);
  assert.equal(sessions.transcriptStarts.size, 0);
});

test("large terminal transcripts trim at complete Unicode lines and reopen the capture pipe", async t => {
  const dir = directory(t), file = path.join(dir, "transcript.log"), calls = [];
  fs.writeFileSync(file, "old\n".repeat(4_300_000) + "new界\n".repeat(100), { mode: 0o600 });
  const sessions = { list: async () => [{ id: "x", tmux: "ap-x", status: "running" }],
    transcriptPath: () => file, tmux: async args => { calls.push(args); } };
  await Sessions.prototype.trimTranscripts.call(sessions);
  assert.ok(fs.statSync(file).size <= 8 * 1024 * 1024);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("old\n")); assert.ok(text.endsWith("new界\n")); assert.ok(!text.includes("\uFFFD"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(calls[0][0], "pipe-pane"); assert.ok(calls[1].includes("-o"));
});

test("event read failures close their descriptor and never reset the persisted sequence", t => {
  const dir = directory(t), store = new StructuredStore({ stateDir: dir });
  fs.writeFileSync(store.logPath("x"), '{"seq":99}\n');
  const close = fs.closeSync; let closed = 0;
  t.mock.method(fs, "readSync", () => { throw Object.assign(new Error("read failed"), { code: "EIO" }); });
  t.mock.method(fs, "closeSync", fd => { closed++; return close(fd); });
  assert.throws(() => store.nextSeq("x"), { code: "EIO" });
  assert.equal(closed, 1); assert.equal(store.sequences.has("x"), false);
});
