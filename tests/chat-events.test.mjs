import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";
const source = fs.readFileSync(new URL("../src/chat-events.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { retainChatEvents } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const MESSAGE_BYTES = 2 * 1024 * 1024, HISTORY_BYTES = 4 * 1024 * 1024;

test("over 4000 chunks retain the entire active answer without mutating prior events", () => {
  const first = { seq: 1, kind: "assistant", id: "answer", text: "START" };
  const events = [first, ...Array.from({ length: 4500 }, (_, i) => ({ seq: i + 2, kind: "assistant", id: "answer", text: "x" }))];
  const result = retainChatEvents(events);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].text, "START" + "x".repeat(4500));
  assert.equal(first.text, "START"); assert.equal(result.truncated, false);
});

test("old turns trim at a user boundary and identical message ids in new turns stay separate", () => {
  const events = Array.from({ length: 5000 }, (_, i) => ({ seq: i + 1, kind: i % 100 === 0 ? "user" : "tool", text: "x" }));
  const result = retainChatEvents(events);
  assert.equal(result.events[0].kind, "user"); assert.equal(result.truncated, true);
  const shared = retainChatEvents([{ seq: 1, kind: "assistant", id: "same", text: "old" }, { seq: 2, kind: "user" }, { seq: 3, kind: "assistant", id: "same", text: "new" }]);
  assert.equal(shared.events.length, 3);
});

test("a 10 MiB streamed answer is shortened and further live chunks remain bounded", () => {
  const chunk = "x".repeat(64 * 1024);
  const source = Array.from({ length: 160 }, (_, i) => ({ seq: i + 1, kind: "assistant", id: "answer", text: chunk }));
  let result = retainChatEvents(source);
  assert.equal(result.events.length, 1);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.events[0].text) <= MESSAGE_BYTES);
  assert.equal(source[0].text, chunk, "the source is not shortened in place");
  for (let i = 0; i < 4; i++) {
    result = retainChatEvents([...result.events, { seq: 161 + i, kind: "assistant", id: "answer", text: chunk + "LATEST" }]);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.events[0].text) <= MESSAGE_BYTES);
    assert.ok(result.events[0].text.endsWith("LATEST"));
  }
});

test("multibyte assistant, thought and id-less text are shortened without broken characters", () => {
  for (const kind of ["assistant", "thought", "user", "error"]) {
    const result = retainChatEvents([{ seq: 1, kind, text: "界😀".repeat(400_000) + "SON" }]);
    assert.equal(result.truncated, true);
    assert.equal(result.events.length, 1);
    const text = result.events[0].text;
    assert.ok(Buffer.byteLength(text) <= MESSAGE_BYTES);
    assert.ok(text.endsWith("SON"));
    assert.equal(text.includes("\uFFFD"), false);
    assert.equal(text.isWellFormed(), true);
  }
});

test("the total byte budget includes nested tool results and retains newest events intact", () => {
  const source = Array.from({ length: 24 }, (_, i) => ({ seq: i + 1, kind: "tool", id: `tool-${i}`,
    patch: { content: [{ type: "text", text: "界".repeat(80_000) }] } }));
  source.push({ seq: 25, kind: "approval", requestId: "pending", status: "requested", options: [] });
  const result = retainChatEvents(source);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= HISTORY_BYTES);
  assert.ok(result.events[0].seq > 1);
  assert.deepEqual(result.events.at(-1), source.at(-1));
  assert.deepEqual(result.events.at(-2), source.at(-2));
  assert.equal(source.length, 25);
});

test("multiple large answers and a single oversized nested event cannot bypass the total budget", () => {
  const events = Array.from({ length: 4 }, (_, i) => ({ seq: i + 1, kind: "assistant", id: `answer-${i}`, text: "x".repeat(1_500_000) }));
  const result = retainChatEvents(events);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= HISTORY_BYTES);
  assert.equal(result.events.at(-1).id, "answer-3");
  const oversized = retainChatEvents([{ seq: 1, kind: "tool", patch: { content: "x".repeat(HISTORY_BYTES + 1) } }, { seq: 2, kind: "turn" }]);
  assert.equal(oversized.truncated, true);
  assert.deepEqual(oversized.events, [{ seq: 2, kind: "turn" }]);
});
