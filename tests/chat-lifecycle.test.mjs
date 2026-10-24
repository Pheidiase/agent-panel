import test from "node:test";
import assert from "node:assert/strict";
import { StructuredStore } from "../server/structured-store.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { CodexManager } from "../server/codex-manager.mjs";
import { ClaudeManager } from "../server/claude-manager.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Real store methods and manager lifecycle, with disk and process boundaries in memory.
function fixture(t, Manager, agentId) {
  const store = Object.assign(Object.create(StructuredStore.prototype), {
    records: [], serial: Promise.resolve(), pendingCreates: new Map(),
    runtimeMaps: new Set(), signals: new Map(), sequences: new Map(), deletedIds: new Set(),
  });
  let persisted = [], failure = null;
  store.save = () => {
    if (failure) { const error = failure; failure = null; throw error; }
    persisted = structuredClone(store.records);
  };
  store.appendEvent = (_id, event) => event;
  store.removeFiles = () => {};
  const manager = new Manager({
    store, agentCommand: { command: "unused", args: [] },
    projects: [{ id: "p", name: "Project", path: "/unused" }],
  });
  const starts = [];
  t.mock.method(manager, "_startSession", ({ id }) => {
    store.assertRunningCapacity(id);
    const runtime = {
      id, status: "idle", starting: null, intentional: false,
      pendingApprovals: new Map(), items: new Map(), userEchoes: [], inflight: 0,
      acpSessionId: "native", threadId: "native", modeId: "workspace-write",
      models: { currentModelId: "default", currentReasoningEffort: null },
      closes: 0, sends: 0,
    };
    runtime.conn = {
      alive: true,
      close: async () => { runtime.closes++; runtime.conn.alive = false; },
      request: async () => { runtime.sends++; return {}; },
      send: () => { runtime.sends++; },
    };
    starts.push(runtime);
    manager.runtimes.set(id, runtime);
    return runtime;
  });
  const record = { id: "chat", agentId, projectId: "p", title: "Chat", endedAt: null };
  return {
    manager, store, starts, record,
    failSave(code) { failure = Object.assign(new Error(code), { code }); },
    persisted: () => persisted,
  };
}

for (const [agentId, Manager] of [
  ["hermes", StructuredManager], ["codex", CodexManager], ["claude", ClaudeManager],
]) {
  test(`${agentId}: failed stop save can be retried without a false ended record`, async t => {
    const f = fixture(t, Manager, agentId), { manager, store, record } = f;
    store.add(record);
    const runtime = manager._startSession({ id: record.id });
    let resolved = 0;
    runtime.pendingApprovals.set("approval", { resolve: () => resolved++ });
    f.failSave("EIO");
    await assert.rejects(manager.stop(record.id), { code: "EIO" });
    assert.equal(manager.get(record.id).status, "running");
    assert.equal(store.get(record.id).endedAt, null);
    assert.equal(f.persisted()[0].endedAt, null);
    assert.equal(runtime.conn.alive, true);
    assert.equal(runtime.closes, 0);

    assert.equal((await manager.stop(record.id)).status, "ended");
    assert.ok(f.persisted()[0].endedAt);
    assert.equal(runtime.conn.alive, false);
    assert.equal(runtime.closes, 1);
    assert.equal(manager.runtimes.has(record.id), false);
    assert.equal(runtime.pendingApprovals.size, 0);
    assert.equal(resolved, 1);
    await manager.stop(record.id);
    assert.equal(runtime.closes, 1);
  });

  test(`${agentId}: stop also cleans up a live runtime with an ended record`, async t => {
    const { manager, store, record } = fixture(t, Manager, agentId);
    record.endedAt = "2026-10-21T00:00:00.000Z";
    store.add(record);
    const runtime = manager._startSession({ id: record.id });
    await manager.stop(record.id);
    assert.equal(runtime.conn.alive, false);
    assert.equal(runtime.closes, 1);
    assert.equal(manager.runtimes.size, 0);
  });

  for (const operation of ["stop", "delete"]) {
    for (const existing of [false, true]) {
      test(`${agentId}: ${operation} during ${existing ? "existing" : "new"} startup prevents reconnect and prompt`, async t => {
        const { manager, store, record, starts } = fixture(t, Manager, agentId);
        store.add(record);
        const ready = deferred();
        if (existing) manager._startSession({ id: record.id }).starting = ready.promise;
        else {
          const start = manager._startSession.bind(manager);
          t.mock.method(manager, "_startSession", options => {
            const runtime = start(options);
            runtime.starting = ready.promise;
            return runtime;
          });
        }
        const connecting = manager._ensureRuntime(record.id);
        const prompting = manager.prompt(record.id, "must not be sent");
        const results = Promise.allSettled([connecting, prompting]);
        assert.equal(starts.length, 1);
        await manager[operation](record.id);
        ready.resolve();
        for (const result of await results) {
          assert.equal(result.status, "rejected");
          assert.equal(result.reason.status, operation === "delete" ? 404 : 409);
        }
        assert.equal(starts.length, 1, "no replacement process after stop");
        assert.equal(starts[0].sends, 0);
        assert.equal(starts[0].conn.alive, false);
        assert.equal(manager.runtimes.size, 0);
        if (operation === "delete") assert.equal(store.has(record.id), false);
        else assert.ok(store.get(record.id).endedAt);
      });
    }
  }

  test(`${agentId}: startup completion cannot return a replacement runtime`, async t => {
    const { manager, store, record, starts } = fixture(t, Manager, agentId);
    store.add(record);
    const runtime = manager._startSession({ id: record.id }), ready = deferred();
    runtime.starting = ready.promise;
    const connecting = manager._ensureRuntime(record.id);
    const rejected = assert.rejects(connecting, { status: 503 });
    const replacement = manager._startSession({ id: record.id });
    ready.resolve();
    await rejected;
    assert.equal(starts.length, 2);
    assert.equal(manager.runtimes.get(record.id), replacement);
    assert.equal(replacement.conn.alive, true);
  });

  test(`${agentId}: add save failure removes only the new record and process and allows retry`, async t => {
    const f = fixture(t, Manager, agentId), { manager, store, record, starts } = f;
    store.add(record);
    const other = manager._startSession({ id: record.id });
    const input = { projectId: "p", agentId, title: "New", requestId: "lifecycle-create-0001" };
    f.failSave("ENOSPC");
    await assert.rejects(manager.create(input), { code: "ENOSPC" });
    assert.deepEqual(store.records, [record]);
    assert.deepEqual(f.persisted(), [record]);
    assert.equal(store.findByIdempotencyKey(input.requestId), null);
    assert.equal(store.pendingCreates.size, 0);
    assert.equal(manager.runtimes.size, 1);
    assert.equal(manager.runtimes.get(record.id), other);
    assert.equal(other.conn.alive, true);
    assert.equal(other.closes, 0);
    assert.equal(starts[1].conn.alive, false);
    assert.equal(starts[1].closes, 1);
    assert.equal(starts[1].intentional, true);

    const retry = await manager.create(input);
    assert.notEqual(retry.id, starts[1].id);
    assert.equal(starts.length, 3);
    assert.equal(store.records.length, 2);
    assert.equal(store.pendingCreates.size, 0);
    assert.equal(manager.runtimes.size, 2);
    assert.equal((await manager.create(input)).id, retry.id);
    assert.equal(starts.length, 3, "successful retries remain idempotent");
  });
}
