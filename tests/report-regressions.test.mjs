import test from "node:test";
import assert from "node:assert/strict";
import { orderedMessages } from "../server/message-queue.mjs";
import { Sessions, PanelError } from "../server/session-store.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { CodexManager } from "../server/codex-manager.mjs";
import { ClaudeManager } from "../server/claude-manager.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("terminal input stays ordered across slow authorization and stops on closure", async () => {
  let open = true, checks = 0;
  const first = deferred(), writes = [];
  const receive = orderedMessages({ open: () => open, fail: assert.fail, handle: async (raw, active) => {
    checks++;
    if (raw === "a") await first.promise;
    if (active()) writes.push(raw);
  } });
  receive("a");
  const done = receive("b");
  await Promise.resolve();
  assert.equal(checks, 1, "second authorization waits for the first input");
  first.resolve(); await done;
  assert.deepEqual(writes, ["a", "b"]);

  const waiting = deferred();
  const closed = orderedMessages({ open: () => open, fail: assert.fail, handle: async (raw, active) => {
    await waiting.promise;
    if (active()) writes.push(raw);
  } });
  const inflight = closed("c");
  const queued = closed("d");
  await Promise.resolve(); open = false; waiting.resolve();
  await Promise.all([inflight, queued]);
  assert.deepEqual(writes, ["a", "b"]);
});

test("terminal errors and queue overflow fail once and discard remaining frames", async () => {
  for (const error of [new PanelError(404, "gone"), new Error("PTY closed")]) {
    let failures = 0, handles = 0;
    const receive = orderedMessages({ open: () => true,
      fail: value => { assert.equal(value, error); failures++; },
      handle: async () => { handles++; throw error; } });
    receive("a"); await receive("b"); await receive("c");
    assert.equal(failures, 1); assert.equal(handles, 1);
  }
  let failures = 0, handles = 0;
  const receive = orderedMessages({ maxPending: 2, open: () => true,
    fail: () => { failures++; }, handle: async () => { handles++; } });
  receive("a"); receive("b"); await receive("c");
  assert.equal(failures, 1); assert.equal(handles, 0);
});

test("unavailable terminal output does not prevent stop; unexpected errors still fail", async () => {
  for (const error of [new PanelError(409, "unavailable"), new Error("disk failed")]) {
    const record = { id: "test" }; let kills = 0, saves = 0;
    const store = { enqueue: fn => fn(), get: () => record,
      output: async () => { throw error; }, kill: async () => { kills++; }, save: () => { saves++; } };
    if (error.status === 409) {
      await Sessions.prototype.stop.call(store, record.id);
      assert.ok(record.endedAt); assert.equal(kills, 1); assert.equal(saves, 1);
      await Sessions.prototype.stop.call(store, record.id);
      assert.equal(kills, 1);
    } else {
      await assert.rejects(Sessions.prototype.stop.call(store, record.id), error);
      assert.equal(kills, 0); assert.equal(saves, 0);
    }
  }
});

test("all chat providers enforce 16000 UTF-8 bytes before connecting or logging", async () => {
  const boundary = "界".repeat(5333) + "a";
  assert.equal(Buffer.byteLength(boundary), 16000);
  for (const Manager of [StructuredManager, CodexManager, ClaudeManager]) {
    const sentinel = new Error("runtime boundary reached"); let connections = 0;
    const store = { get: () => ({}) };
    const manager = { store, _own: store.get, _ensureRuntime: async () => { connections++; throw sentinel; } };
    await assert.rejects(Manager.prototype.prompt.call(manager, "test", boundary + "a"), { status: 400 });
    assert.equal(connections, 0);
    await assert.rejects(Manager.prototype.prompt.call(manager, "test", boundary), sentinel);
    assert.equal(connections, 1);
  }
});
