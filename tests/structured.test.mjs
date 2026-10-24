// Structured (ACP) sessions: store bounds, manager lifecycle, event
// normalization, the approval bridge, cancel and the resume path — all
// against the deterministic fixture agent (no model, no network, no
// Telegram). The fixture is a tiny JSON-RPC server scripted per prompt text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AcpConnection } from "../server/acp-client.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import {
  StructuredStore,
  EVENT_MAX_BYTES,
  EVENT_LOG_LIMIT,
} from "../server/structured-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixtureAgent = path.join(root, "tests/fixtures/fake-acp-agent.mjs");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-structured-"));
  const fixtureLog = path.join(dir, "fixture.log");
  const manager = new StructuredManager({
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [fixtureAgent] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: { ...process.env, FIXTURE_LOG: fixtureLog },
  });
  const wait = async (fn, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Beklenen koşul zaman aşımına uğradı.");
  };
  const events = (id, options) => manager.readEvents(id, options).events;
  return { dir, manager, fixtureLog, wait, events };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("structured sessions: create is live, idempotent, validated and capped", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup(dir);
  });
  const requestId = crypto.randomUUID();
  const record = await manager.create({
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Prova",
    requestId,
  });
  assert.equal(record.status, "running");
  assert.ok(String(record.acpSessionId).startsWith("fixture-"));
  assert.equal(record.kind, "structured");
  const again = await manager.create({
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Prova",
    requestId,
  });
  assert.equal(again.id, record.id);
  assert.equal(manager.list().length, 1);
  await assert.rejects(
    manager.create({
      projectId: "nope",
      agentId: "hermes",
      title: "x",
      requestId: crypto.randomUUID(),
    }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    manager.create({
      projectId: "agent-panel",
      agentId: "codex",
      title: "x",
      requestId: crypto.randomUUID(),
    }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    manager.create({
      projectId: "agent-panel",
      agentId: "hermes",
      title: "bad\nname",
      requestId: crypto.randomUUID(),
    }),
    (e) => e.status === 400,
  );
  // The adapter advertises commands and usage right after session/new.
  await wait(() => events(record.id).some((e) => e.kind === "commands"));
  await wait(() => events(record.id).some((e) => e.kind === "usage"));
  // Four live children max; the fifth create is refused.
  for (let i = 0; i < 3; i++) {
    await manager.create({
      projectId: "agent-panel",
      agentId: "hermes",
      title: `P${i}`,
      requestId: crypto.randomUUID(),
    });
  }
  await assert.rejects(
    manager.create({
      projectId: "agent-panel",
      agentId: "hermes",
      title: "P5",
      requestId: crypto.randomUUID(),
    }),
    (e) => e.status === 409,
  );
  assert.equal(manager.list().filter((s) => s.status === "running").length, 4);
});

test("structured prompts: streaming, approval bridge, cancel and validation", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup(dir);
  });
  const record = await manager.create({
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Sohbet",
    requestId: crypto.randomUUID(),
  });
  const turnEnded = async () => {
    const last = events(record.id).filter((e) => e.kind === "turn").length;
    return last;
  };
  // Streaming: same-messageId chunks merge, thoughts are separate.
  await manager.prompt(record.id, "two-chunks");
  await wait(async () => (await turnEnded()) >= 1);
  let evs = events(record.id);
  assert.equal(evs.filter((e) => e.kind === "user" && e.text === "two-chunks").length, 1);
  const chunks = evs.filter((e) => e.kind === "assistant" && e.id);
  assert.equal(chunks.map((c) => c.text).join(""), "Hello world");
  assert.equal(chunks[0].id, chunks[1].id);
  assert.ok(evs.some((e) => e.kind === "thought" && e.text === "fixture thinking"));
  // Approval bridge: request surfaces, approval completes the tool call.
  await manager.prompt(record.id, "needs-approval");
  await wait(() =>
    events(record.id).some((e) => e.kind === "approval" && e.status === "requested"),
  );
  const first = events(record.id).find(
    (e) => e.kind === "approval" && e.status === "requested",
  );
  assert.ok(first.options.some((o) => o.optionId === "allow_once"));
  assert.match(first.toolCall.title, /rm -rf build/);
  await manager.approve(record.id, first.requestId, "allow_once");
  await wait(() =>
    events(record.id).some((e) => e.kind === "approval" && e.status === "decided" && e.optionId === "allow_once"),
  );
  await wait(() =>
    events(record.id).some((e) => e.kind === "tool" && e.app === "update" && e.patch.status === "completed"),
  );
  await wait(() =>
    events(record.id).some((e) => e.kind === "assistant" && e.text.includes("Approved and done.")),
  );
  // Deny path.
  await manager.prompt(record.id, "needs-approval again");
  await wait(
    () =>
      events(record.id).filter((e) => e.kind === "approval" && e.status === "requested")
        .length >= 2,
  );
  const second = events(record.id).filter(
    (e) => e.kind === "approval" && e.status === "requested",
  )[1];
  await manager.approve(record.id, second.requestId, "deny");
  await wait(() =>
    events(record.id).some((e) => e.kind === "assistant" && e.text.includes("Denied.")),
  );
  // Unknown or foreign option ids are refused.
  await manager.prompt(record.id, "needs-approval one more");
  await wait(
    () =>
      events(record.id).filter((e) => e.kind === "approval" && e.status === "requested")
        .length >= 3,
  );
  const third = events(record.id).filter(
    (e) => e.kind === "approval" && e.status === "requested",
  )[2];
  await assert.rejects(manager.approve(record.id, third.requestId, "not-an-option"), (e) => e.status === 400);
  await manager.approve(record.id, third.requestId, "deny");
  await wait(() => manager.stateOf(record.id).status === "idle");
  // Cancel: the turn ends with stop_reason cancelled.
  await manager.prompt(record.id, "slow run");
  await wait(() => manager.stateOf(record.id).status === "running");
  await manager.cancel(record.id);
  await wait(() =>
    events(record.id).some((e) => e.kind === "turn" && e.stopReason === "cancelled"),
  );
  await wait(() => manager.stateOf(record.id).status === "idle");
  // Prompt validation.
  await assert.rejects(manager.prompt(record.id, "bad\x07char"), (e) => e.status === 400);
  await assert.rejects(manager.prompt(record.id, " "), (e) => e.status === 400);
  await assert.rejects(
    manager.prompt(record.id, "x".repeat(8001)),
    (e) => e.status === 400,
  );
});

test("structured sessions resume via session/load; stored log wins, empty log rebuilds", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-structured-"));
  const fixtureLog = path.join(dir, "fixture.log");
  const options = {
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [fixtureAgent] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: { ...process.env, FIXTURE_LOG: fixtureLog },
  };
  const wait = async (fn, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Beklenen koşul zaman aşımına uğradı.");
  };
  const first = new StructuredManager(options);
  let second = null;
  t.after(async () => {
    await first.shutdown().catch(() => {});
    await second?.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup(dir);
  });
  const record = await first.create({
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Kalıcılık",
    requestId: crypto.randomUUID(),
  });
  await first.prompt(record.id, "two-chunks");
  await wait(() => first.readEvents(record.id, {}).events.some((e) => e.kind === "turn"));
  const before = first.readEvents(record.id, {}).events.length;
  // Simulate a web service restart: children die, the state dir survives.
  await first.shutdown();
  second = new StructuredManager(options);
  assert.equal(second.get(record.id).connection, "offline");
  assert.equal(await second.ensureConnected(record.id), true);
  const events = second.readEvents(record.id, {}).events;
  assert.equal(second.get(record.id).connection, "idle");
  // The stored log stays canonical: the replay must not duplicate content.
  assert.ok(events.length >= before);
  assert.equal(events.filter((e) => e.kind === "user").length, 1);
  assert.ok(!events.some((e) => (e.text || "").includes("replay-assistant")));
  assert.ok(!events.some((e) => (e.text || "").includes("replay-user")));
  // The conversation continues after the resume.
  await second.prompt(record.id, "after resume");
  await wait(() =>
    second.readEvents(record.id, {}).events.some(
      (e) => e.kind === "assistant" && e.text === "Echo: after resume",
    ),
  );
  const fixtureLines = fs.readFileSync(fixtureLog, "utf8");
  assert.equal((fixtureLines.match(/^load fixture-1$/gm) || []).length, 1);
  // A session whose panel log is empty rebuilds its transcript from the replay.
  const id2 = crypto.randomUUID();
  second.store.add({
    id: id2,
    kind: "structured",
    acpSessionId: "fixture-rebuild",
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Rebuild",
    createdAt: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    endedAt: null,
  });
  assert.equal(await second.ensureConnected(id2), true);
  await wait(() =>
    second.readEvents(id2, {}).events.some((e) => e.text === "replay-assistant"),
  );
  const rebuilt = second.readEvents(id2, {}).events;
  assert.ok(rebuilt.some((e) => e.kind === "user" && e.text === "replay-user"));
  assert.ok(rebuilt.some((e) => e.kind === "assistant" && e.text === "replay-assistant"));
});

test("resume fallback: an ephemeral record reopens fresh; a list conflict fails loudly", async (t) => {
  const wait = async (fn, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Beklenen koşul zaman aşımına uğradı.");
  };
  const make = (env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-structured-"));
    const manager = new StructuredManager({
      root,
      stateDir: dir,
      agentCommand: { command: process.execPath, args: [fixtureAgent] },
      projects: [{ id: "agent-panel", name: "Panel", path: dir }],
      env: { ...process.env, FIXTURE_LOG: path.join(dir, "fixture.log"), ...env },
    });
    return { dir, manager };
  };
  const plain = make();
  const conflicted = make({ FIXTURE_LIST: "fixture-keep" });
  t.after(async () => {
    await plain.manager.shutdown().catch(() => {});
    await conflicted.manager.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup(plain.dir);
    cleanup(conflicted.dir);
  });
  // Ephemeral record: no persisted Hermes row → reopen with a fresh session.
  const id = crypto.randomUUID();
  plain.manager.store.add({
    id,
    kind: "structured",
    acpSessionId: "fixture-gone",
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Gone",
    createdAt: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    endedAt: null,
  });
  assert.equal(await plain.manager.ensureConnected(id), true);
  const reopened = plain.manager.get(id);
  assert.notEqual(reopened.acpSessionId, "fixture-gone");
  assert.ok(String(reopened.acpSessionId).startsWith("fixture-"));
  await wait(() =>
    plain.manager
      .readEvents(id, {})
      .events.some((e) => e.kind === "status" && e.status === "reopened"),
  );
  await plain.manager.prompt(id, "after reopen");
  await wait(() =>
    plain.manager
      .readEvents(id, {})
      .events.some((e) => e.kind === "assistant" && e.text === "Echo: after reopen"),
  );
  // The agent still lists the id although the load failed → refuse, retryable.
  const id2 = crypto.randomUUID();
  conflicted.manager.store.add({
    id: id2,
    kind: "structured",
    acpSessionId: "fixture-keep",
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Keep",
    createdAt: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    endedAt: null,
  });
  assert.equal(await conflicted.manager.ensureConnected(id2), false);
  assert.match(conflicted.manager.stateOf(id2).lastError, /yüklenemedi/);
});

test("structured stop keeps the log, delete removes it; ended sessions refuse prompts", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    cleanup(dir);
  });
  const record = await manager.create({
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Yaşam döngüsü",
    requestId: crypto.randomUUID(),
  });
  await manager.prompt(record.id, "with-plan");
  await wait(() => events(record.id).some((e) => e.kind === "turn"));
  await wait(() => events(record.id).some((e) => e.kind === "plan" && e.entries.length === 2));
  const logFile = manager.store.logPath(record.id);
  assert.ok(fs.existsSync(logFile));
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  await manager.stop(record.id);
  assert.equal(manager.get(record.id).status, "ended");
  assert.equal(manager.get(record.id).connection, "ended");
  assert.ok(events(record.id).length > 0);
  await manager.stop(record.id); // Repeated stop is harmless.
  await assert.rejects(manager.prompt(record.id, "hello"), (e) => e.status === 409);
  // Metadata updates mirror the terminal store's rules.
  const updated = await manager.store.update(record.id, { title: "Yeni ad", pinned: true });
  assert.equal(updated.title, "Yeni ad");
  assert.equal(updated.pinned, true);
  await assert.rejects(manager.store.update(record.id, { title: "bad\n" }), (e) => e.status === 400);
  await assert.rejects(manager.store.update(record.id, { nope: true }), (e) => e.status === 400);
  assert.equal(await manager.ensureConnected(record.id), false); // annotates, never throws
  assert.match(manager.stateOf(record.id).lastError, /sonlandırılmış/);
  await manager.delete(record.id);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(manager.list().length, 0);
  assert.throws(() => manager.get(record.id), (e) => e.status === 404);
});

test("structured event log is bounded: oversized events shrink, the file trims", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-structured-"));
  const store = new StructuredStore({ stateDir: dir });
  const id = crypto.randomUUID();
  // A single oversized event cannot enter the log whole.
  const stored = store.appendEvent(id, {
    kind: "assistant",
    id: null,
    text: "x".repeat(400_000),
  });
  assert.equal(stored.truncated, true);
  assert.ok(JSON.stringify(stored).length <= EVENT_MAX_BYTES);
  // Many large events force the trim; the newest lines stay readable.
  let lastSeq = stored.seq;
  for (let i = 0; i < 36; i++) {
    lastSeq = store.appendEvent(id, {
      kind: "assistant",
      id: null,
      text: "y".repeat(240_000) + `#${i}`,
    }).seq;
  }
  const file = store.logPath(id);
  assert.ok(fs.statSync(file).size <= EVENT_LOG_LIMIT);
  const { events, lastSeq: readLast, truncated } = store.readEvents(id, { after: 0 });
  assert.equal(readLast, lastSeq);
  assert.ok(truncated);
  assert.ok(events[0].seq > 1);
  assert.equal(events[events.length - 1].seq, lastSeq);
  const after = events[events.length - 2].seq;
  const filtered = store.readEvents(id, { after });
  assert.ok(filtered.events.every((e) => e.seq > after));
  cleanup(dir);
});

test("acp client: stray output, request routing, timeouts and close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-acp-"));
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(
    script,
    [
      'process.stdout.write("not json garbage\\n");',
      'process.stdin.setEncoding("utf8");',
      'let b = "";',
      'process.stdin.on("data", (c) => { b += c; let i;',
      '  while ((i = b.indexOf("\\n")) >= 0) {',
      '    const line = b.slice(0, i); b = b.slice(i + 1);',
      '    if (!line.trim()) continue;',
      '    const m = JSON.parse(line);',
      '    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\\n");',
      '    if (m.method === "ask") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "x/y", params: { n: 1 } }) + "\\n");',
      '  }',
      '});',
    ].join("\n"),
  );
  const connection = new AcpConnection({
    command: process.execPath,
    args: [script],
    cwd: dir,
    env: process.env,
  });
  connection.start();
  const result = await connection.request("initialize", {}, { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true });
  const asked = new Promise((resolve) => {
    connection.onRequest = (method, params) => {
      resolve({ method, params });
      return { answer: 42 };
    };
  });
  connection.request("ask", {}).catch(() => {});
  const request = await asked;
  assert.equal(request.method, "x/y");
  assert.deepEqual(request.params, { n: 1 });
  await assert.rejects(
    connection.request("ignored", {}, { timeoutMs: 150 }),
    /zaman aşımına uğradı/,
  );
  assert.equal(connection.alive, true);
  const pending = assert.rejects(connection.request("never-answered", {}), /kapatıldı/);
  await connection.close();
  await pending;
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.alive, false);
  await assert.rejects(connection.request("initialize", {}), /kapalı/);
  cleanup(dir);
});

test("structured events keep authoritative sequence and time within the UTF-8 byte limit", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-event-bytes-"));
  t.after(() => cleanup(dir));
  const store = new StructuredStore({ stateDir: dir }), id = crypto.randomUUID();
  const samples = [
    { kind: "assistant", text: "界".repeat(200_000) },
    { kind: "assistant", text: "😀".repeat(200_000) },
    { kind: "tool", data: { title: "x".repeat(400_000) } },
    { kind: "tool", patch: { title: "x".repeat(400_000) } },
    { kind: "assistant", seq: 9999, t: "invalid", text: "small" },
  ];
  samples.forEach((event, index) => {
    const stored = store.appendEvent(id, event);
    assert.equal(stored.seq, index + 1);
    assert.ok(Number.isFinite(Date.parse(stored.t)));
    assert.ok(Buffer.byteLength(JSON.stringify(stored) + "\n") <= EVENT_MAX_BYTES);
  });
  assert.deepEqual(store.readEvents(id).events.map(e => e.seq), [1, 2, 3, 4, 5]);
});

test("ACP rejects oversized protocol lines regardless of chunk boundaries", () => {
  const max = 8 * 1024 * 1024;
  const oversized = Buffer.from(JSON.stringify({ method: "notice", params: { text: "x".repeat(max) } }) + "\n");
  for (const chunks of [[oversized], [oversized.subarray(0, 100), oversized.subarray(100)],
    [oversized.subarray(0, -1), oversized.subarray(-1)]]) {
    const connection = new AcpConnection({ command: "unused" });
    let notifications = 0, kills = 0;
    connection.onNotification = () => notifications++;
    connection._kill = () => kills++;
    for (const chunk of chunks) connection._onStdout(chunk);
    assert.equal(notifications, 0);
    assert.equal(kills, 1);
    assert.equal(connection._terminated, true);
  }
  const connection = new AcpConnection({ command: "unused" });
  const normal = Buffer.from(JSON.stringify({ method: "notice", params: { text: "界" } }) + "\n");
  let params;
  connection.onNotification = (_method, value) => { params = value; };
  const cut = normal.indexOf(Buffer.from("界")) + 1;
  connection._onStdout(normal.subarray(0, cut));
  connection._onStdout(normal.subarray(cut));
  assert.deepEqual(params, { text: "界" });
});
