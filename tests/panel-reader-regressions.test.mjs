import { clientModules } from "./fixtures/client-modules.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
function compile(source) {
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  new Function("exports", "t", js)(exports, i18n.t);
  return exports;
}
const view = fs.readFileSync(new URL("../src/StructuredView.tsx", import.meta.url), "utf8");
const { foldEvents } = compile(view.slice(view.indexOf("function foldEvents("), view.indexOf("function foldApprovals(")) + "\nexport { foldEvents };");
const { retainConversation } = clientModules()("convblocks.ts");

test("rendered chat scopes reused assistant, thought and tool ids to their turn", () => {
  const events = [];
  for (const turn of [1, 2]) {
    const add = e => events.push({ seq: events.length + 1, ...e });
    add({ kind: "user", text: `Q${turn}` });
    add({ kind: "assistant", id: "same", text: `A${turn}` });
    add({ kind: "assistant", id: "same", text: "." });
    add({ kind: "thought", id: "thought", text: `T${turn}` });
    add({ kind: "thought", id: "thought", text: "." });
    // The second turn may start in a truncated history with only an update.
    if (turn === 1) add({ kind: "tool", id: "tool", app: "start", data: { title: "read" } });
    add({ kind: "tool", id: "tool", app: "update", patch: { status: "completed", content: `result${turn}` } });
  }
  const items = foldEvents(events);
  assert.deepEqual(items.map(i => i.type), ["user", "assistant", "thought", "tool", "user", "assistant", "thought", "tool"]);
  assert.deepEqual(items.filter(i => i.type === "assistant").map(i => i.text), ["A1.", "A2."]);
  assert.deepEqual(items.filter(i => i.type === "thought").map(i => i.text), ["T1.", "T2."]);
  assert.deepEqual(items.filter(i => i.type === "tool").map(i => i.tool.content), ["result1", "result2"]);
  assert.equal(new Set(items.map(i => i.key)).size, items.length);
});

test("terminal reader retains updates to parallel tools even when the last entry is unchanged", () => {
  const current = { partial: false, entries: [
    { id: "q", role: "user", kind: "text", text: "question" },
    { id: "a", role: "assistant", kind: "tool", name: "Read", result: "" },
    { id: "b", role: "assistant", kind: "tool", name: "Bash", result: "" },
  ] };
  const next = structuredClone(current);
  next.entries[1].result = "completed A";
  assert.equal(retainConversation(current, next), next);
  assert.equal(current.entries[1].result, "", "previous immutable snapshot survives");
  assert.equal(retainConversation(next, structuredClone(next)), next, "unchanged log keeps its identity");
  for (const [field, value] of Object.entries({ name: "Grep", summary: "new", isError: true, truncated: true, time: "2026-10-21", text: "updated", role: "user", kind: "text", id: "new" })) {
    const changed = structuredClone(next);
    changed.entries[1][field] = value;
    assert.equal(retainConversation(next, changed), changed, field);
  }
  assert.equal(retainConversation(next, null), null);
  const partial = { ...next, partial: true };
  assert.equal(retainConversation(next, partial), partial);
});

const cancelSource = view.slice(view.indexOf("  async function cancel("), view.indexOf("  async function answer("));
const { composer } = compile(`export function composer(request) {
  let stopping = false, error = "";
  const session = { id: "chat" }, setError = value => { error = value; }, setStopping = value => { stopping = value; };
  ${cancelSource}
  return { click() { setStopping(true); return cancel(); }, state: () => ({ stopping, error }) };
}`);

test("cancelled:false unlocks Stop with an explanation and permits another cancellation", async () => {
  let calls = 0;
  const ui = composer(async (url, method) => {
    assert.equal(url, "/sessions/chat/cancel");
    assert.equal(method, "POST");
    return { cancelled: ++calls > 1 };
  });
  await ui.click();
  assert.equal(ui.state().stopping, false);
  assert.deepEqual(ui.state().error, { key: "chat.stopFailed" });
  assert.match(i18n.messageText(ui.state().error), /durdurulamadı/);
  await ui.click();
  assert.equal(calls, 2);
  assert.deepEqual(ui.state(), { stopping: true, error: "" }, "accepted cancellation waits for the turn's state event");
});

test("a failed cancellation request also unlocks Stop", async () => {
  const ui = composer(async () => { throw Error("connection failed"); });
  await ui.click();
  assert.equal(ui.state().stopping, false);
  assert.ok(ui.state().error instanceof Error);
  assert.equal(i18n.messageText(ui.state().error), "connection failed");
});
