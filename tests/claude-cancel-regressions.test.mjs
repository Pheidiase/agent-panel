import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AcpConnection } from "../server/acp-client.mjs";
import { ClaudeConnection, ClaudeManager } from "../server/claude-manager.mjs";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const manager = Object.create(ClaudeManager.prototype);
  const record = { id: "chat", agentId: "claude" };
  const events = [], ack = deferred();
  const runtime = {
    id: "chat", inflight: 0, turnId: 0, streamed: new Set(), pendingApprovals: new Map(),
    conn: { alive: true, control: () => ack.promise, write() {}, async close() { this.alive = false; } },
  };
  manager.runtimes = new Map([[record.id, runtime]]);
  manager._own = () => record;
  manager._ensureRuntime = async () => runtime;
  manager._append = (_id, ev) => events.push(ev);
  manager._broadcastState = () => {};
  manager._markStarted = () => {};
  return { manager, runtime, events, ack };
}

for (const outcome of ["resolve", "reject"]) {
  test(`Claude: old interrupt ${outcome} cannot change the next turn`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { manager, runtime, ack, events } = fixture();
    await manager.prompt("chat", "first");
    const cancel = manager.cancel("chat");
    manager._onResult("chat", runtime, { subtype: "success" });
    await manager.prompt("chat", "second");
    runtime.cancelRequested = true; // A separate cancellation belongs to the new turn.
    ack[outcome](outcome === "reject" ? new Error("late timeout") : {});
    await cancel;
    assert.equal(runtime.cancelRequested, true);
    t.mock.timers.tick(8001);
    assert.equal(runtime.inflight, 1);
    assert.equal(runtime.conn.alive, true);
    assert.equal(events.filter(e => e.kind === "turn").length, 1);
    await assert.rejects(manager.prompt("chat", "third"), { status: 409 });
  });
}

test("Claude: interrupt timeout closes an unconfirmed connection without claiming idle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, runtime, ack, events } = fixture();
  await manager.prompt("chat", "first");
  const cancel = manager.cancel("chat");
  ack.resolve({});
  assert.deepEqual(await cancel, { cancelled: true });
  t.mock.timers.tick(8001);
  await flush();
  assert.equal(runtime.conn.alive, false);
  assert.equal(runtime.inflight, 1);
  assert.equal(events.some(e => e.kind === "turn"), false);
  assert.ok(events.some(e => e.kind === "error"));
});

test("Claude: normal interrupted result clears the fallback timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, runtime, ack, events } = fixture();
  await manager.prompt("chat", "first");
  const cancel = manager.cancel("chat");
  ack.resolve({});
  await cancel;
  manager._onResult("chat", runtime, { subtype: "success" });
  await manager.prompt("chat", "second");
  t.mock.timers.tick(8001);
  assert.equal(runtime.inflight, 1);
  assert.equal(runtime.conn.alive, true);
  assert.equal(events.find(e => e.kind === "turn").stopReason, "cancelled");
});

test("Claude: malformed control requests return errors through the real manager handler", async () => {
  const { manager, runtime } = fixture();
  const conn = new ClaudeConnection({ command: "unused" }), replies = [], received = [];
  conn._tryWrite = reply => replies.push(reply);
  conn.onControl = (request, id) => manager._onControl("chat", runtime, request, id);
  conn.onMessage = msg => received.push(msg.type);
  for (const [index, request] of [null, {}, { subtype: "unknown" }, { subtype: { toString: null } }].entries()) {
    assert.doesNotThrow(() => conn._onStdout(Buffer.from(JSON.stringify({ type: "control_request", request_id: String(index), request }) + "\n")));
  }
  conn._onStdout(Buffer.from('{"type":"system"}\n'));
  await flush();
  assert.deepEqual(received, ["system"]);
  assert.equal(replies.length, 4);
  assert.ok(replies.every(reply => reply.response.subtype === "error"));
});

test("Claude: request followed immediately by cancellation preserves protocol order", async () => {
  const conn = new ClaudeConnection({ command: "unused" }), replies = [], pending = new Map();
  conn._tryWrite = reply => replies.push(reply);
  conn.onControl = (_request, id) => new Promise(resolve => pending.set(id, resolve));
  conn.onControlCancel = id => {
    pending.get(id)?.({ behavior: "deny" });
    pending.delete(id);
  };
  const messages = [
    { type: "control_request", request_id: "permission", request: { subtype: "can_use_tool" } },
    { type: "control_cancel_request", request_id: "permission" },
  ];
  conn._onStdout(Buffer.from(messages.map(m => JSON.stringify(m)).join("\n") + "\n"));
  await flush();
  assert.equal(pending.size, 0);
  assert.equal(replies[0].response.response.behavior, "deny");
});

for (const Connection of [AcpConnection, ClaudeConnection]) {
  test(`${Connection.name}: throwing request handler produces an error and reading continues`, async () => {
    const conn = new Connection({ command: "unused" }), replies = [], received = [];
    conn._tryWrite = reply => replies.push(reply);
    const handler = () => { throw new Error("handler failed"); };
    conn.onRequest = conn.onControl = handler;
    conn.onNotification = method => received.push(method);
    conn.onMessage = msg => received.push(msg.type);
    const messages = Connection === AcpConnection
      ? [{ id: 1, method: "bad" }, { method: "next" }]
      : [{ type: "control_request", request_id: "1", request: { subtype: { toString: null } } }, { type: "next" }];
    assert.doesNotThrow(() => conn._onStdout(Buffer.from(messages.map(m => JSON.stringify(m)).join("\n") + "\n")));
    await flush();
    assert.deepEqual(received, ["next"]);
    assert.match(JSON.stringify(replies[0]), /handler failed/);
    conn.onRequest = conn.onControl = () => ({ ok: true });
    conn._onStdout(Buffer.from(JSON.stringify(messages[0]) + "\n"));
    await flush();
    assert.match(JSON.stringify(replies[1]), /"ok":true/);
  });

  test(`${Connection.name}: failed diagnostic tail read always closes its fd`, t => {
    const conn = new Connection({ command: "unused", stderrPath: "/unused-diagnostic" });
    let opens = 0, closes = 0, writes = 0;
    t.mock.method(fs, "appendFileSync", () => {});
    t.mock.method(fs, "statSync", () => ({ size: 2 * 1024 * 1024 }));
    t.mock.method(fs, "openSync", () => { opens++; return 99; });
    t.mock.method(fs, "readSync", () => { throw new Error("EIO"); });
    t.mock.method(fs, "closeSync", fd => { assert.equal(fd, 99); closes++; });
    t.mock.method(fs, "writeFileSync", () => { writes++; });
    for (let i = 0; i < 3; i++) assert.doesNotThrow(() => conn._onStderr(Buffer.from("diagnostic\n")));
    assert.equal(opens, 3);
    assert.equal(closes, opens);
    assert.equal(writes, 0, "a failed read must not overwrite the log");
    t.mock.method(fs, "readSync", (_fd, buffer) => buffer.write("old\nkept\n"));
    conn._onStderr(Buffer.from("next\n"));
    assert.equal(closes, 4);
    assert.equal(writes, 1);
  });
}
