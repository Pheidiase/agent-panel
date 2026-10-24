// Exercise incremental state and deferred rows
// without browsers, live providers, model prompts or external services.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import { setStaticCache } from "../server/static-cache.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";

const require = createRequire(import.meta.url);
const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
const read = file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
function compile(source, deps = {}) {
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", "t", js)(name => deps[name] ?? (name === "./i18n" ? i18n : require(name)), exports, i18n.t);
  return exports;
}
const chat = read("StructuredView.tsx");
const { turnNotice } = compile(read("ux-state.ts"));
const { foldEvents, foldApprovals } = compile(`const i18n_1 = { t };\nconst turnNotice = ${turnNotice.toString()};\n` +
  chat.slice(chat.indexOf("function foldEvents("), chat.indexOf("function ApprovalCard(")) + "\nexport { foldEvents, foldApprovals };");
const { retainChatEvents } = compile(read("chat-events.ts"));
const { collectChanges } = compile(read("changes.ts"));
const { retainDiffs, diffLines } = compile(read("diff.ts"));

test("streamed chat equals replay; unchanged messages and tools retain identity", () => {
  const events = [
    { kind: "user", text: "first" },
    { kind: "assistant", id: "a", text: "first answer" },
    { kind: "user", text: "second" },
    { kind: "assistant", id: "a", text: "second" },
    { kind: "tool", id: "t", app: "start", data: { title: "edit", status: "pending" } },
    { kind: "thought", id: "thought", text: "thinking" },
    { kind: "tool", id: "t", patch: { status: "completed", content: [{ type: "diff", path: "a", oldText: "old", newText: "new" }] } },
    { kind: "assistant", id: "a", text: " answer" },
    { kind: "thought", id: "thought", text: "." },
    { kind: "turn", stopReason: "cancelled" },
  ].map((event, index) => ({ ...event, seq: index + 1 }));
  let items = [];
  for (let index = 0; index < events.length; index++) {
    const before = items;
    items = foldEvents([events[index]], items);
    assert.deepEqual(items, foldEvents(events.slice(0, index + 1)));
    if (index > 1) assert.equal(items[1], before[1], "closed turn must stay untouched");
    if (events[index].kind === "tool" && events[index].patch) {
      assert.equal(before.find(item => item.type === "tool").tool.status, "pending", "update must not mutate React's previous state");
      assert.equal(items.find(item => item.key === 4), before.find(item => item.key === 4));
    }
    if (events[index].seq === 8) assert.equal(items.find(item => item.type === "tool"), before.find(item => item.type === "tool"));
  }
  assert.equal(items.find(item => item.key === 4).text, "second answer");
  assert.equal(collectChanges(items).length, 1);
});

test("incremental approvals preserve request envelope and expire only in the ended view", () => {
  const requested = { seq: 1, kind: "approval", requestId: "r", status: "requested", options: [{ optionId: "yes" }], questions: [{ id: "q" }] };
  const before = foldApprovals([requested]);
  const after = foldApprovals([{ seq: 2, kind: "approval", requestId: "r", status: "decided", optionId: "yes" }], false, before);
  assert.equal(before[0].status, "requested");
  assert.equal(after[0].status, "decided");
  assert.deepEqual(after[0].questions, requested.questions);
  assert.deepEqual(foldApprovals([], true, before)[0], { ...before[0], status: "expired" });
});

test("retention rebuild drops evicted changes and shared diff cache releases them", () => {
  const cache = new Map();
  let computations = 0;
  const compute = (...args) => { computations++; return diffLines(...args); };
  const events = [
    { seq: 1, kind: "user", text: "old" },
    { seq: 2, kind: "tool", id: "t", app: "start", data: { content: [{ type: "diff", path: "a", oldText: "old", newText: "new" }] } },
  ];
  const oldFiles = collectChanges(foldEvents(events));
  const first = retainDiffs(cache, oldFiles, compute);
  assert.equal(retainDiffs(cache, oldFiles, compute).get(oldFiles[0].blockId), first.get(oldFiles[0].blockId));
  assert.equal(computations, 1, "header and panel reuse the same diff object");
  const changed = [{ ...oldFiles[0], newText: "updated" }];
  retainDiffs(cache, changed, compute);
  assert.equal(computations, 2, "an updated fragment invalidates its own entry");
  for (let i = 3; i < 50; i++) events.push({ seq: i, kind: "user", text: "界".repeat(40_000) });
  const kept = retainChatEvents(events);
  assert.equal(kept.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(kept.events)) <= 4 * 1024 * 1024);
  const retainedFiles = collectChanges(foldEvents(kept.events));
  assert.deepEqual(retainedFiles, []);
  retainDiffs(cache, retainedFiles, compute);
  assert.equal(cache.size, 0);
});

test("offscreen rows defer Markdown, keep measured space and render search targets", t => {
  const slots = [], effects = [];
  let cursor = 0, markdownCalls = 0, intersect;
  const element = { getBoundingClientRect: () => ({ height: 540 }), contains: () => false, querySelectorAll: () => [] };
  const root = { current: { scrollTop: 0, scrollHeight: 2400 } }, follow = { current: true };
  const react = {
    memo: fn => fn,
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useEffect(fn) { cursor++; effects.push(fn); },
    useLayoutEffect(fn) { cursor++; effects.push(fn); },
  };
  const savedIntersection = globalThis.IntersectionObserver, savedResize = globalThis.ResizeObserver, savedDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  t.after(() => {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedIntersection === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = savedIntersection;
    if (savedResize === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = savedResize;
  });
  globalThis.IntersectionObserver = class {
    constructor(fn) { intersect = fn; }
    observe() {} disconnect() {}
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const { ChatRow } = compile('import { useI18n } from "./i18n";\nimport React, { useRef, useState, useEffect, useLayoutEffect } from "react";\n' +
    'const renderMarkdown = require("markdown-spy"); const Sparkles = () => null; const CopyButton = () => null;\n' +
    chat.slice(chat.indexOf("// Keep measured space")) + "\nexport { ChatRow };", {
      "./i18n": { ...i18n, useI18n() {} }, react, "markdown-spy": text => { markdownCalls++; return text; },
    });
  const props = { item: { type: "assistant", key: 1, text: "**answer**" }, root, follow, initial: false, hit: false };
  const render = extra => { cursor = 0; effects.length = 0; return ChatRow({ ...props, ...extra }); };
  let row = render();
  slots[0].current = element;
  for (const effect of effects) effect();
  assert.equal(markdownCalls, 0);
  intersect([{ isIntersecting: true }]);
  row = render();
  for (const effect of effects) effect();
  assert.equal(markdownCalls, 1);
  assert.equal(root.current.scrollTop, 2400, "expanding deferred content keeps the reader at the end");
  intersect([{ isIntersecting: false }]);
  row = render();
  assert.equal(markdownCalls, 1);
  assert.equal(row.props.style.height, 540);
  render({ hit: true, current: false });
  assert.equal(markdownCalls, 1, "matching offscreen rows stay deferred until selected");
  render({ hit: true, current: true });
  assert.equal(markdownCalls, 2, "a search target renders even outside the viewport");
});

test("only hashed static code/styles/fonts receive private immutable caching", () => {
  for (const [file, expected] of [
    ["/panel/dist/assets/index-Abcd12_-.js", "private, max-age=31536000, immutable"],
    ["/panel/dist/assets/font-Abcd1234.woff2", "private, max-age=31536000, immutable"],
    ["/panel/dist/assets/index-Abcd1234.css", "private, max-age=31536000, immutable"],
    ["/panel/dist/index.html", "no-store"], ["/panel/dist/assets/plain.js", "no-store"],
    ["/panel/dist/assets/data-Abcd1234.json", "no-store"],
  ]) {
    let header;
    setStaticCache({ setHeader: (name, value) => { assert.equal(name, "Cache-Control"); header = value; } }, file);
    assert.equal(header, expected, file);
  }
});
