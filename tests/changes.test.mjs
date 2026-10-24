// Unit tests for the chat "Değişiklikler" helpers and the browser mirror of
// the live-list patch applier. The sources are TypeScript; this suite
// transpiles them in-memory with the project's own typescript devDependency,
// so it runs on both the system node (26) and the target runtime (node 22,
// which has no native type stripping). No build step, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";
import { applySessionOps as referenceApply } from "../server/live-state.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(import.meta.dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-helpers-"));
function load(rel) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const file = path.join(out, path.basename(rel).replace(/\.ts$/, ".mjs"));
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}
const { diffLines } = await load("src/diff.ts");
const modules = clientModules();
modules("i18n.ts").setLanguage("tr");
const { collectChanges, buildCommentBlock, commentMatchesFile, commentBatches, insertCommentBlock } = modules("changes.ts");
const { applySessionOps: clientApply } = await load("src/live.ts");

test("diffLines: identical text is all context", () => {
  const result = diffLines("a\nb\nc", "a\nb\nc");
  assert.equal(result.tooLarge, false);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.lines.map((line) => line.type), ["ctx", "ctx", "ctx"]);
});

test("diffLines: counts and line numbers for a mixed change", () => {
  const result = diffLines("a\nb\nc", "a\nX\nc\nD");
  assert.equal(result.tooLarge, false);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(
    result.lines.filter((line) => line.type === "add").map((line) => line.text),
    ["X", "D"],
  );
  assert.deepEqual(
    result.lines.filter((line) => line.type === "del").map((line) => line.text),
    ["b"],
  );
  // Added lines carry only the new-side number; removed only the old-side one.
  for (const line of result.lines) {
    if (line.type === "del") assert.equal(line.newNo, null);
    if (line.type === "add") assert.equal(line.oldNo, null);
  }
});

test("diffLines: CRLF and lone CR read as the same text", () => {
  const result = diffLines("a\r\nb", "a\nb");
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
});

test("diffLines: a huge middle reports tooLarge without diffing it", () => {
  const make = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");
  const byLines = diffLines(make("old", 1600), make("new", 1600));
  assert.equal(byLines.tooLarge, true);
  assert.deepEqual(byLines.lines, []);
  assert.equal(byLines.oldLines, 1600);
  assert.equal(byLines.newLines, 1600);
  const byCells = diffLines(make("old", 1100), make("new", 1100));
  assert.equal(byCells.tooLarge, true);
});

test("collectChanges: preserves independently identified edit fragments per path", () => {
  const files = collectChanges([
    {
      type: "tool",
      tool: {
        id: "first",
        content: [
          { type: "diff", path: "src/a.ts", oldText: "1", newText: "2" },
          { type: "text", text: "ignored" },
        ],
      },
    },
    { type: "assistant", text: "ignored" },
    {
      type: "tool",
      tool: {
        id: "second",
        content: [
          { type: "diff", path: "src/a.ts", oldText: "2", newText: "3" },
          { type: "diff", path: "src/b.ts", oldText: "", newText: "new" },
        ],
      },
    },
  ]);
  assert.deepEqual(files, [
    { blockId: JSON.stringify(["src/a.ts", "first", null]) + "::1", path: "src/a.ts", oldText: "1", newText: "2", edits: 1 },
    { blockId: JSON.stringify(["src/a.ts", "second", null]) + "::1", path: "src/a.ts", oldText: "2", newText: "3", edits: 1 },
    { blockId: JSON.stringify(["src/b.ts", "second", null]) + "::2", path: "src/b.ts", oldText: "", newText: "new", edits: 1 },
  ]);
});

test("buildCommentBlock: preserves whole comments and splits long lists into message groups", () => {
  const block = buildCommentBlock([
    { id: "1", path: "src/a.ts", side: "new", line: 4, snippet: "  const x = 1;  ", text: " açıkla ", at: "" },
  ]);
  assert.equal(block, 'Değişiklik yorumları:\n- src/a.ts:4 (yeni satır) "const x = 1;" → açıkla');
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    path: "src/long.ts",
    side: "old",
    line: i,
    snippet: "x".repeat(120),
    text: "y".repeat(120),
    at: "",
  }));
  const batches = commentBatches(many);
  assert.deepEqual(batches.flat(), many);
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    const block = buildCommentBlock(batch);
    assert.ok(block.length <= 4000);
    for (const comment of batch) assert.ok(block.includes(comment.text));
    assert.equal(insertCommentBlock("", batch), block);
  }
  assert.ok(buildCommentBlock(many).includes("src/long.ts:59"));
  assert.equal(insertCommentBlock("x".repeat(7990), many.slice(0, 1)), null);
  assert.equal(insertCommentBlock("界".repeat(5300), [{ ...many[0], text: "界".repeat(100) }]), null);
  assert.equal(insertCommentBlock("taslak  ", many.slice(0, 1)), "taslak\n\n" + buildCommentBlock(many.slice(0, 1)));
  assert.deepEqual(commentBatches([]), []);
});

test("applySessionOps: the browser mirror matches the server reference (fuzz)", () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const ids = ["a", "b", "c", "d"];
  for (let round = 0; round < 300; round++) {
    const list = ids
      .slice(0, 1 + Math.floor(rand() * 3))
      .map((id) => ({ id, title: `t-${id}`, n: 0 }));
    const ops = [];
    for (let i = 0, count = Math.floor(rand() * 4); i < count; i++) {
      const kind = Math.floor(rand() * 3);
      const id = ids[Math.floor(rand() * ids.length)];
      if (kind === 0) ops.push({ op: "add", index: Math.floor(rand() * (list.length + 1)), item: { id, title: `t-${id}`, n: round } });
      else if (kind === 1) ops.push({ op: "remove", id });
      else ops.push({ op: "update", id, fields: { n: round } });
    }
    assert.deepEqual(clientApply(list, ops), referenceApply(list, ops), `round ${round}`);
  }
});

test("applySessionOps: an add for an existing id never duplicates (mirror)", () => {
  const list = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
  const out = clientApply(list, [{ op: "add", index: 0, item: { id: "a", v: 2 } }]);
  // The full list fetch that raced the patch already carried (at least as
  // fresh) data; the add must not duplicate it.
  assert.deepEqual(out, list);
});

test("change identity survives eviction, repeated tool ids and multiple fragments", () => {
  const edit = (key, text) => ({ type: "tool", key, tool: { id: "reused", content: [
    { type: "diff", path: "a.ts", oldText: "old", newText: text },
    { type: "diff", path: "a.ts", oldText: "old", newText: text },
  ] } });
  const first = edit(1, "first"), second = edit(9, "second");
  const all = collectChanges([first, second]), retained = collectChanges([second]);
  assert.deepEqual(retained, all.slice(2));
  assert.equal(new Set(all.map(file => file.blockId)).size, 4);
  const comment = { path: "a.ts", blockId: all[0].blockId, side: "new", line: 1, snippet: "first" };
  assert.equal(commentMatchesFile(comment, all[0]), true);
  assert.equal(retained.some(file => commentMatchesFile(comment, file)), false);
  assert.equal(commentMatchesFile({ ...comment, blockId: retained[0].blockId }, retained[0]), false);
  assert.equal(commentMatchesFile({ ...comment, blockId: "a.ts::1" }, retained[0]), false, "legacy ordinal stays orphaned");
});

test("changes panel shows evicted comments separately instead of attaching them to a newer fragment", () => {
  const modules = clientModules({ "./changes": { commentMatchesFile, commentBatches }, "./diff": { diffLines } });
  modules("i18n.ts").setLanguage("tr");
  const exports = modules("ChangesPanel.tsx");
  const file = collectChanges([{ type: "tool", key: 9, tool: { id: "new", content: [
    { type: "diff", path: "a.ts", oldText: "old", newText: "new" },
  ] } }])[0];
  const html = renderToStaticMarkup(React.createElement(exports.default, {
    files: [file], diffs: new Map([[file.blockId, diffLines(file.oldText, file.newText)]]), comments: [{ id: "c", path: "a.ts", blockId: "a.ts::1", side: "new", line: 1, snippet: "old", text: "orphan comment" }],
    onCommentsChange: assert.fail, onInsert: assert.fail, onClose: assert.fail,
  }));
  assert.match(html, /Geçmişten düşen veya değişen parçalara ait yorumlar \(1\)/);
  assert.match(html, /orphan comment/);
  assert.doesNotMatch(html, /class="diff-comment"/);
});
