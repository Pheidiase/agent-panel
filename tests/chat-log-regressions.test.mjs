import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelError } from "../server/session-store.mjs";
import { StructuredStore } from "../server/structured-store.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { CodexManager } from "../server/codex-manager.mjs";
import { ClaudeManager } from "../server/claude-manager.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";

const source = fs.readFileSync(new URL("../src/StructuredView.tsx", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
function compile(text) {
  const js = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", "t", js)(name => name === "./i18n" ? i18n : require(name), exports, i18n.t);
  return exports;
}
// Exercise the actual fold and card, without importing browser-only modules.
const { foldApprovals, ApprovalCard } = compile(`
  ${fs.readFileSync(new URL("../src/ux-state.ts", import.meta.url), "utf8")}
  import { useState, useEffect } from "react";
  const TerminalSquare = () => null, ShieldAlert = () => null, Clock = () => null;
  ${source.slice(source.indexOf("function foldApprovals("), source.indexOf("function CopyButton("))}
  export { foldApprovals, ApprovalCard };
`);

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-chat-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(t, Manager, agentId) {
  const store = new StructuredStore({ stateDir: directory(t) });
  store.add({ id: "chat", agentId, projectId: "p", title: "Chat", endedAt: null });
  const manager = new Manager({ store, agentCommand: { command: "unused", args: [] }, projects: [] });
  const runtime = {
    id: "chat", status: "idle", inflight: 0, userEchoes: [], items: new Map(),
    pendingApprovals: new Map(), intentional: false, starting: null, sends: 0,
    modeId: "workspace-write", threadId: "native", acpSessionId: "native",
  };
  runtime.conn = {
    alive: true,
    request: async () => { runtime.sends++; return {}; },
    write: () => { runtime.sends++; },
    close: async () => { runtime.conn.alive = false; },
  };
  manager.runtimes.set(runtime.id, runtime);
  return { store, manager, runtime, id: runtime.id };
}

for (const [label, tail, expected, damaged] of [
  ["torn JSON", '{"seq":42,"text":"yarım', [41, 42, 43], true],
  ["complete JSON without newline", '{"seq":42,"kind":"assistant","text":"tam"}', [41, 42, 43, 44], false],
]) {
  test(`reopened log isolates ${label} and reads both new events`, t => {
    const dir = directory(t), store = new StructuredStore({ stateDir: dir });
    const file = store.logPath("chat");
    const original = '{"seq":41,"kind":"user","text":"önce"}\n' + tail;
    fs.writeFileSync(file, original);
    const reopened = new StructuredStore({ stateDir: dir });
    const first = reopened.appendEvent("chat", { kind: "assistant", text: "yeni 1" });
    const second = reopened.appendEvent("chat", { kind: "assistant", text: "yeni 2" });
    const read = reopened.readEvents("chat");
    assert.deepEqual(read.events.map(e => e.seq), expected);
    assert.deepEqual(read.events.slice(-2), [first, second]);
    assert.equal(read.truncated, damaged);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.startsWith(original + "\n"), "original bytes preserved on their own line");
    assert.equal(raw.split("\n").filter(Boolean).filter(line => {
      try { JSON.parse(line); return false; } catch { return true; }
    }).length, damaged ? 1 : 0);
  });
}

test("a partial failed append is isolated on retry even with a cached sequence", t => {
  const store = new StructuredStore({ stateDir: directory(t) });
  store.appendEvent("chat", { kind: "user", text: "first" });
  const append = fs.appendFileSync;
  let fail = true;
  t.mock.method(fs, "appendFileSync", (file, data, options) => {
    if (fail) {
      fail = false;
      append(file, data.slice(0, 12), options);
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return append(file, data, options);
  });
  assert.throws(() => store.appendEvent("chat", { kind: "assistant", text: "lost" }), { code: "EIO" });
  const next = store.appendEvent("chat", { kind: "assistant", text: "retry" });
  assert.equal(next.seq, 2);
  assert.deepEqual(store.readEvents("chat").events.map(e => e.text), ["first", "retry"]);
  assert.equal(store.readEvents("chat").truncated, true);
});

for (const [agentId, Manager] of [["hermes", StructuredManager], ["codex", CodexManager], ["claude", ClaudeManager]]) {
  test(`${agentId}: failed user log rejects delivery and preserves the UI draft`, async t => {
    const { manager, store, runtime, id } = fixture(t, Manager, agentId);
    t.mock.method(console, "error", () => {});
    t.mock.method(store, "appendEvent", () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); });
    await assert.rejects(manager.prompt(id, "taslağım"), { status: 503 });
    assert.equal(runtime.sends, 0);
    assert.equal(runtime.inflight, 0);
    assert.deepEqual(runtime.userEchoes, []);
    // Run the real composer submit against the rejecting manager boundary.
    const submitSource = source.slice(source.indexOf("  async function submit("), source.indexOf("  async function cancel("));
    const { send } = compile(`export async function send(request) {
      let draft = "taslağım", sending = false, error = "";
      const sendBlocked = false, session = { id: "chat" };
      const setDraft = fn => { draft = fn(draft); }, setSending = value => { sending = value; };
      const setError = value => { error = value; }, setStick = () => {};
      ${submitSource}
      await submit(); return { draft, sending, error };
    }`);
    // The first failure closed the connection; supply the captured HTTP error.
    const result = await send(async () => { throw new Error("Sohbet günlüğü yazılamadı."); });
    assert.equal(result.draft, "taslağım");
    assert.equal(result.sending, false);
    assert.ok(result.error instanceof Error);
    assert.match(i18n.messageText(result.error), /günlüğü yazılamadı/);
  });

  test(`${agentId}: in-flight log failure is visible through offline state`, t => {
    const { manager, store, runtime, id } = fixture(t, Manager, agentId);
    runtime.inflight = 1;
    let closes = 0;
    t.mock.method(runtime.conn, "close", async () => { closes++; runtime.conn.alive = false; });
    const states = [];
    manager.on("state", (_id, state) => states.push(state));
    t.mock.method(console, "error", () => {});
    t.mock.method(store, "appendEvent", () => { throw new Error("EIO"); });
    assert.equal(manager._append(id, { kind: "assistant", text: "lost" }), null);
    assert.equal(runtime.conn.alive, false);
    assert.equal(states.at(-1).status, "offline");
    assert.match(states.at(-1).lastError, /günlüğü yazılamadı/);
    // A rejected/finished turn must not hide the disk error by returning idle.
    runtime.inflight = 0;
    manager._syncRuntimeStatus(runtime);
    manager._broadcastState(id);
    manager._append(id, { kind: "turn", stopReason: "end_turn" });
    assert.equal(states.at(-1).status, "offline");
    assert.equal(closes, 1);
  });

  for (const operation of ["stop", "exit", "shutdown"]) {
    test(`${agentId}: ${operation} persists expired command and secret-question approvals`, async t => {
      const { manager, store, runtime, id } = fixture(t, Manager, agentId);
      const resolved = [];
      for (const requestId of ["command", "question"]) {
        store.appendEvent(id, { kind: "approval", requestId, status: "requested",
          options: [{ optionId: "allow", kind: "allow_once", name: "İzin ver" }],
          ...(requestId === "question" ? { questions: [{ id: "secret", question: "Parola?", isSecret: true, options: [] }] } : {}),
        });
        runtime.pendingApprovals.set(requestId, {
          timer: setTimeout(() => assert.fail("approval timer leaked"), 60000),
          resolve: value => resolved.push(value), isQuestion: requestId === "question",
        });
      }
      if (operation === "exit") {
        runtime.conn.alive = false;
        manager._onExit(id, runtime, runtime.conn);
      } else await manager[operation](operation === "stop" ? id : undefined);
      assert.equal(runtime.pendingApprovals.size, 0);
      assert.equal(resolved.length, 2);
      const replay = new StructuredStore({ stateDir: store.stateDir }).readEvents(id).events;
      const approvals = foldApprovals(replay);
      assert.deepEqual(approvals.map(a => a.status), ["expired", "expired"]);
      assert.equal(replay.filter(e => e.kind === "approval" && e.status === "expired").length, 2);
      const markup = renderToStaticMarkup(React.createElement(ApprovalCard, { approval: approvals[0], busy: false, onAnswer: assert.fail }));
      assert.doesNotMatch(markup, /<button/);
      assert.match(markup, /Süre doldu/);
      assert.equal(manager.stateOf(id).pendingApprovalCount, 0);
      if (operation !== "stop") {
        const fresh = { kind: "approval", requestId: "next-turn", status: "requested", options: [] };
        assert.equal(foldApprovals([...replay, fresh]).filter(a => a.status === "requested").length, 1);
      }
    });
  }

  test(`${agentId}: concurrent stop and delete wait for final writes; late events cannot recreate log`, async t => {
    const { manager, store, runtime, id } = fixture(t, Manager, agentId);
    store.appendEvent(id, { kind: "user", text: "hello" });
    const closed = deferred();
    let closes = 0, deleted = false;
    runtime.conn.close = async () => { closes++; await closed.promise; runtime.conn.alive = false; };
    const stopping = manager.stop(id);
    const deleting = manager.delete(id).then(() => { deleted = true; });
    await Promise.resolve();
    assert.equal(deleted, false);
    assert.equal(store.has(id), true);
    assert.equal(closes, 1);
    closed.resolve();
    await Promise.all([stopping, deleting]);
    assert.equal(store.has(id), false);
    assert.equal(fs.existsSync(store.logPath(id)), false);
    t.mock.method(console, "error", () => {});
    manager._append(id, { kind: "assistant", text: "late notification" });
    manager._onExit(id, runtime, runtime.conn);
    assert.throws(() => store.appendEvent(id, { kind: "turn" }), { status: 404 });
    assert.equal(fs.existsSync(store.logPath(id)), false);
    assert.equal(manager.stopping.size, 0);
  });
}

test("ended sessions turn legacy requested cards into expired cards", () => {
  const events = [{ kind: "approval", requestId: "old", status: "requested", options: [] }];
  assert.equal(foldApprovals(events)[0].status, "requested");
  assert.equal(foldApprovals(events, true)[0].status, "expired");
  assert.equal(foldApprovals(events)[0].status, "requested", "source events are unchanged");
});

for (const [agentId, Manager] of [["hermes", StructuredManager], ["codex", CodexManager], ["claude", ClaudeManager]]) {
  test(`${agentId}: a displayable command remains an actionable approval card after reopening`, async t => {
    const { store, manager, runtime, id } = fixture(t, Manager, agentId);
    t.after(() => store.closeLogs());
    const command = "界".repeat(agentId === "claude" ? 4000 : 300_000);
    const decision = agentId === "hermes"
      ? manager._onRequest(id, runtime, "session/request_permission", {
        toolCall: { toolCallId: "tool", title: "Command", rawInput: { command } },
        options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
      })
      : agentId === "codex"
        ? manager._approvalRequest(id, runtime, "item/commandExecution/requestApproval", { itemId: "tool", command })
        : manager._permissionRequest(id, runtime, { tool_name: "Bash", input: { command } }, "control");
    const replay = new StructuredStore({ stateDir: store.stateDir }).readEvents(id).events;
    const approval = foldApprovals(replay)[0];
    assert.equal(approval.status, "requested");
    assert.ok(approval.requestId);
    assert.ok(approval.expiresAt);
    assert.ok(approval.options.length);
    if (agentId === "claude") {
      assert.equal(command.length, 4000);
      assert.equal(approval.toolCall.rawInput.command, command);
      assert.equal(runtime.pendingApprovals.size, 1);
    }
    const markup = renderToStaticMarkup(React.createElement(ApprovalCard, { approval, busy: false, onAnswer: assert.fail }));
    assert.match(markup, /<button/);
    if (agentId !== "claude") assert.match(markup, /önizlemesi kısaltıldı/);
    const optionId = approval.options.find(option => option.kind === "allow_once").optionId;
    await manager.approve(id, approval.requestId, optionId);
    const result = await decision;
    assert.ok(result);
    if (agentId === "claude") {
      assert.equal(result.behavior, "allow");
      assert.equal(result.updatedInput.command, command);
    }
    assert.equal(runtime.pendingApprovals.size, 0);
    assert.equal(foldApprovals(store.readEvents(id).events)[0].status, "decided");
  });

  test(`${agentId}: an approval that cannot be stored is denied without leaving a timer`, async t => {
    const { manager, store, runtime, id } = fixture(t, Manager, agentId);
    t.mock.method(console, "error", () => {});
    t.mock.method(store, "appendEvent", () => { throw new PanelError(503, "Onay isteği güvenli biçimde gösterilemeyecek kadar büyük; istek reddedildi."); });
    const result = await (agentId === "hermes"
      ? manager._onRequest(id, runtime, "session/request_permission", { options: [] })
      : agentId === "codex"
        ? manager._approvalRequest(id, runtime, "item/commandExecution/requestApproval", { command: "x" })
        : manager._permissionRequest(id, runtime, { tool_name: "Bash", input: { command: "x" } }, "control"));
    assert.equal(runtime.pendingApprovals.size, 0);
    assert.equal(manager.stateOf(id).status, "offline");
    assert.match(manager.stateOf(id).lastError, /Onay isteği.*büyük.*reddedildi/);
    assert.equal(agentId === "hermes" ? result.outcome.outcome : agentId === "codex" ? result.decision : result.behavior,
      agentId === "hermes" ? "cancelled" : agentId === "codex" ? "decline" : "deny");
  });
}

test("claude: a 4001-character Bash command is denied immediately with a persisted visible notice", async t => {
  const { store, manager, runtime, id } = fixture(t, ClaudeManager, "claude");
  t.after(() => store.closeLogs());
  t.after(() => manager._resolveAllPending(runtime));
  const command = "界".repeat(4001);
  const timers = t.mock.method(globalThis, "setTimeout");
  const emitted = [];
  manager.on("event", (sessionId, event) => emitted.push({ sessionId, event }));
  const decision = manager._permissionRequest(id, runtime, { tool_name: "Bash", input: { command } }, "control");
  assert.equal(runtime.pendingApprovals.size, 0, "must not wait for owner approval");
  assert.equal(timers.mock.callCount(), 0, "must not start an approval timeout");
  assert.equal(manager.stateOf(id).pendingApprovalCount, 0);
  const result = await decision;
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /Komut.*uzun/);
  const replay = new StructuredStore({ stateDir: store.stateDir }).readEvents(id).events;
  assert.equal(foldApprovals(replay).length, 0, "must not create an actionable card");
  const notice = replay.find(event => event.kind === "status" && event.status === "notice");
  assert.ok(notice, "automatic denial must remain visible after reopening");
  assert.match(notice.detail, /Komut.*uzun.*reddedildi/);
  assert.ok(emitted.some(item => item.sessionId === id && item.event.seq === notice.seq),
    "the connected panel also receives the denial notice");
});

test("claude: the Bash command length limit does not reject other tools", async t => {
  const { store, manager, runtime, id } = fixture(t, ClaudeManager, "claude");
  t.after(() => store.closeLogs());
  t.after(() => manager._resolveAllPending(runtime));
  const input = { file_path: "/fixture.txt", command: "界".repeat(4001) };
  const decision = manager._permissionRequest(id, runtime, { tool_name: "Read", input }, "control");
  assert.equal(runtime.pendingApprovals.size, 1);
  const replay = new StructuredStore({ stateDir: store.stateDir }).readEvents(id).events;
  const approval = foldApprovals(replay)[0];
  assert.equal(approval.status, "requested");
  assert.equal(replay.some(event => event.kind === "status" && event.status === "notice"), false);
  await manager.approve(id, approval.requestId, "allow");
  assert.deepEqual(await decision, { behavior: "allow", updatedInput: input });
  assert.equal(runtime.pendingApprovals.size, 0);
});
