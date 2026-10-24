import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import { StructuredStore, EVENT_MAX_BYTES, EVENT_LOG_LIMIT } from "../server/structured-store.mjs";
import { replayEvents } from "../server/event-replay.mjs";
import { SessionCreation } from "../server/session-creation.mjs";
import { LiveState } from "../server/live-state.mjs";
import { attentionOf } from "../server/attention.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";

async function load(file) {
  const source = fs.readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}
const { retainChatEvents } = await load("chat-events");
const { mergeSessionList } = await load("live");
const client = clientModules();
client("i18n.ts").setLanguage("tr");
const { extractEvents, sessionMarker, markSeen } = client("inbox.ts");

function storeFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-arch-history-"));
  const store = new StructuredStore({ stateDir: dir });
  t.after(() => { store.closeLogs(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

for (const text of ["x", "界".repeat(100)]) {
  test(`reopen replays all 4001 chunks across count/byte pages (${text.length} chars per chunk)`, async t => {
    const store = storeFor(t);
    store.add({ id: "chat" });
    store.appendEvent("chat", { kind: "user", text: "go" });
    for (let i = 0; i < 4001; i++) store.appendEvent("chat", { kind: "assistant", id: "answer", text });
    store.closeLogs();
    const reopened = new StructuredStore({ stateDir: store.stateDir });
    t.after(() => reopened.closeLogs());
    const received = [], pages = [];
    let cursor = 0;
    const client = { replaying: true, ws: { readyState: 1, send(frame, done) {
      const page = JSON.parse(frame);
      assert.ok(Buffer.byteLength(frame) <= 1024 * 1024);
      assert.ok(page.events.every(e => e.seq > cursor));
      cursor = page.lastSeq;
      received.push(...page.events); pages.push(page);
      // Simulate a live event while an asynchronous snapshot frame drains.
      if (pages.length === 1) reopened.appendEvent("chat", { kind: "assistant", id: "answer", text: "LIVE" });
      queueMicrotask(done);
    } } };
    await replayEvents(client, options => reopened.readEvents("chat", options));
    assert.ok(pages.length > 1);
    assert.equal(pages.some(page => page.truncated), false);
    assert.equal(client.replaying, false);
    assert.equal(new Set(received.map(e => e.seq)).size, 4003);
    assert.equal(retainChatEvents(received).events.find(e => e.kind === "assistant").text, text.repeat(4001) + "LIVE");
    const reconnect = [];
    await replayEvents({ ws: { readyState: 1, send(frame, done) { reconnect.push(JSON.parse(frame)); done(); } } },
      options => reopened.readEvents("chat", options), cursor);
    assert.deepEqual(reconnect, [], "reconnect at the cursor does not duplicate text");
  });
}

test("paged replay reports actual retention loss and torn lines", async t => {
  const store = storeFor(t);
  for (let i = 0; i < 40; i++) store.appendEvent("chat", { kind: "assistant", text: "x".repeat(240_000) });
  assert.ok(fs.statSync(store.logPath("chat")).size <= EVENT_LOG_LIMIT);
  const first = store.readEvents("chat", { page: true });
  assert.ok(first.events[0].seq > 1);
  assert.equal(first.truncated, true);
  store.closeLogs();
  fs.appendFileSync(store.logPath("chat"), '{"seq":');
  assert.equal(store.readEvents("chat", { page: true }).truncated, true);
});

test("failed replay send never switches the viewer to live mode", async () => {
  const client = { replaying: true, ws: { readyState: 1, send(_frame, done) { done(new Error("closed")); } } };
  await assert.rejects(replayEvents(client, () => ({ events: [{ seq: 1 }], lastSeq: 1 })), /closed/);
  assert.equal(client.replaying, true);
});

test("oversized approvals preserve identity, decisions, questions and expiry", t => {
  const store = storeFor(t);
  const input = { kind: "approval", requestId: "approve", status: "requested", expiresAt: "later",
    toolCall: { toolCallId: "tool-1", title: "Command", rawInput: { command: "界".repeat(300_000) } },
    options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Deny" }],
    questions: [{ id: "q", question: "Choose", options: [{ label: "One" }], isSecret: true }],
  };
  const stored = store.appendEvent("chat", input);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= EVENT_MAX_BYTES);
  assert.equal(stored.truncated, true);
  for (const key of ["kind", "requestId", "status", "expiresAt", "options", "questions"]) assert.deepEqual(stored[key], input[key]);
  assert.equal(stored.toolCall.toolCallId, "tool-1");
  assert.deepEqual(store.readEvents("chat").events, [JSON.parse(JSON.stringify(stored))]);
  assert.equal(input.toolCall.rawInput.command.length, 300_000);
  assert.throws(() => store.appendEvent("chat", { ...input, options: [{ optionId: "x".repeat(300_000) }] }), { status: 503 });
  assert.equal(store.nextSeq("chat"), 1, "rejected approval is not logged as an empty card");
});

const types = ["terminal", "hermes", "codex", "claude"];
function creationFixture() {
  const records = [];
  let creates = 0, fail = false, start;
  const gate = new SessionCreation({
    list: async () => records.slice(),
    findExisting: input => records.find(r => r.requestId === input.requestId && r.agentId === input.agentId),
    create: async input => {
      creates++;
      if (start) await start;
      if (fail) throw new Error("failed start");
      const record = { ...input, id: `s${creates}`, status: "running" };
      records.push(record); return record;
    },
  });
  const input = (type, requestId, extra = {}) => ({ projectId: "p", title: "Session", kind: type === "terminal" ? "terminal" : "structured",
    agentId: type === "terminal" ? "codex" : type, requestId: `arch-create-${requestId}`, ...extra });
  return { gate, records, input, count: () => creates, fail: value => { fail = value; }, wait: promise => { start = promise; } };
}
for (const existing of types) for (const next of types) {
  test(`parallel consent: ${existing} blocks ${next} until explicitly allowed`, async () => {
    const { gate, input, count } = creationFixture();
    const first = await gate.run(input(existing, "first"));
    await assert.rejects(gate.run(input(next, "second")), { status: 409 });
    await assert.rejects(gate.run(input(next, "second", { allowParallel: "yes" })), { status: 400 });
    assert.equal(count(), 1);
    assert.equal((await gate.run(input(existing, "first"))).id, first.id, "idempotent retry needs no new consent");
    await gate.run(input(next, "second", { allowParallel: true }));
    assert.equal(count(), 2);
  });
}

test("project reservations cover concurrent starts, release failures, and do not block other projects", async () => {
  const f = creationFixture();
  let release;
  f.wait(new Promise(resolve => { release = resolve; }));
  const request = f.input("claude", "first");
  const first = f.gate.run(request);
  assert.equal(f.gate.run(request), first, "same pending request shares the reservation");
  await assert.rejects(f.gate.run(f.input("terminal", "second")), { status: 409 });
  const unrelated = f.gate.run(f.input("codex", "third", { projectId: "other" }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.count(), 2);
  release(); await Promise.all([first, unrelated]);
  assert.equal(f.gate.pending.size, 0);
  f.fail(true);
  await assert.rejects(f.gate.run(f.input("hermes", "failed", { projectId: "new" })), /failed start/);
  assert.equal(f.gate.pending.size, 0);
  f.fail(false);
  await f.gate.run(f.input("hermes", "failed", { projectId: "new" }));
});

test("old REST response cannot roll back a live rename followed by a pin patch", async () => {
  let items = [{ id: "a", title: "old", pinned: false }];
  const live = new LiveState({ build: async () => items });
  const oldHttp = await live.current();
  let state = mergeSessionList({ epoch: null, version: 0, items: [] }, oldHttp).state;
  const messages = [];
  live.on("patch", message => messages.push(message));
  items = [{ id: "a", title: "new", pinned: false }];
  await live.current();
  state = mergeSessionList(state, messages.at(-1)).state;
  assert.equal(mergeSessionList(state, oldHttp).state, state);
  items = [{ id: "a", title: "new", pinned: true }];
  await live.current();
  state = mergeSessionList(state, messages.at(-1)).state;
  assert.deepEqual(state.items, items);
  assert.equal(mergeSessionList(state, oldHttp).state, state);
  assert.equal(mergeSessionList(state, { ...messages[0], version: state.version + 2 }).resync, true);
  const restarted = await new LiveState({ build: async () => items }).current();
  const fresh = mergeSessionList(state, restarted, true).state;
  assert.equal(fresh.version, 1);
  assert.notEqual(fresh.epoch, state.epoch);
  assert.equal(mergeSessionList(fresh, oldHttp).state, fresh, "response from the old epoch is rejected");
});

test("restart restores stable unread error/done markers beyond the normal tail", t => {
  const store = storeFor(t);
  store.add({ id: "failed" }); store.add({ id: "done" }); store.add({ id: "cancelled" });
  store.appendEvent("failed", { kind: "turn", stopReason: "end_turn" });
  store.appendEvent("failed", { kind: "error", text: "Failed" });
  store.appendEvent("done", { kind: "turn", stopReason: "end_turn" });
  store.appendEvent("cancelled", { kind: "turn", stopReason: "cancelled" });
  // Attention must not depend on the 1 MiB / 3000 raw-event read window.
  for (let i = 0; i < 4000; i++) store.appendEvent("failed", { kind: "assistant", id: "a", text: "界".repeat(100) });
  const sessions = source => source.records.map(r => ({ ...r, attention: attentionOf(null, source.signals.get(r.id)) }));
  const before = extractEvents(sessions(store));
  store.closeLogs();
  const reopened = new StructuredStore({ stateDir: store.stateDir });
  assert.deepEqual(extractEvents(sessions(reopened)), before);
  assert.deepEqual(before.map(e => e.id).sort(), ["done:turn:1", "failed:error:2"]);
  const unseen = { seen: [], notified: [] };
  assert.equal(sessionMarker("failed", before, unseen), "unread");
  const seen = markSeen(unseen, ["failed:error:2"]);
  assert.equal(sessionMarker("failed", extractEvents(sessions(reopened)), seen), null);
  assert.equal(sessionMarker("done", extractEvents(sessions(reopened)), seen), "unread");
  assert.equal(reopened.appendEvent("failed", { kind: "error", text: "new" }).seq, 4003);
  reopened.closeLogs();
});

test("REST versioned response uses the live snapshot and keeps the legacy array contract", async () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('app.get("/api/sessions",'), source.indexOf("async function listHistory()"));
  let handler;
  const live = new LiveState({ build: async () => [{ id: "a", title: "Live" }] });
  new Function("app", "auth", "live", route)({ get(_url, _auth, callback) { handler = callback; } }, () => {}, live);
  let received;
  await handler({ query: { versioned: "1" } }, { json(value) { received = value; } }, assert.fail);
  assert.deepEqual(received, live.snapshot());
  await handler({ query: {} }, { json(value) { received = value; } }, assert.fail);
  assert.deepEqual(received, live.snapshot().items);
});

test("an entirely damaged log still reports incomplete history to the viewer", async () => {
  const frames = [], client = { replaying: true, ws: { readyState: 1, send(frame, done) { frames.push(JSON.parse(frame)); done(); } } };
  await replayEvents(client, () => ({ events: [], lastSeq: 0, truncated: true }));
  assert.equal(frames[0].truncated, true);
  assert.equal(client.replaying, false);
});

test("the creation route applies the shared guard before dispatching to any provider", async () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("const sessionCreation ="), source.indexOf('app.patch("/api/sessions/:id",'));
  const records = [], calls = [];
  const provider = name => ({ records, list: async () => records, create: async body => {
    calls.push(name); const record = { ...body, id: String(calls.length), status: "running" }; records.push(record); return record;
  } });
  let handler;
  new Function("app", "auth", "mutation", "SessionCreation", "chatList", "sessions", "structured", "codex", "claude", "live", route)(
    { post(_path, _auth, _mutation, callback) { handler = callback; } }, () => {}, () => {}, SessionCreation,
    () => records, provider("terminal"), provider("hermes"), provider("codex"), provider("claude"), { kick() {} },
  );
  const call = body => new Promise((resolve, reject) => handler({ body }, { status() { return { json: resolve }; } }, reject));
  for (const [index, agentId] of ["hermes", "codex", "claude"].entries()) {
    const body = { kind: "structured", agentId, projectId: "p", title: "Chat", requestId: `route-regression-${index}` };
    if (index) await assert.rejects(call(body), { status: 409 });
    await call({ ...body, allowParallel: index > 0 });
  }
  const terminal = { agentId: "codex", projectId: "p", title: "Terminal", requestId: "route-regression-term" };
  await assert.rejects(call(terminal), { status: 409 });
  await call({ ...terminal, allowParallel: true });
  assert.deepEqual(calls, ["hermes", "codex", "claude", "terminal"]);
});
