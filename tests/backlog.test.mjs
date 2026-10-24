import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const js = ts.transpileModule(fs.readFileSync(new URL("../src/backlog.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { updateBacklog } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const source = Array.from({ length: 5000 }, (_, i) => `Satır ${i}: Türkçe 🌍 ───`).join("\n");
const joined = doc => doc.blocks.flatMap(block => block.rows.map(row => row.text)).join("");

test("backlog preserves blank lines, trailing newline and Unicode exactly", () => {
  for (const text of ["", "\n", "\n\n", "a\n\nb\n", "Türkçe 🌍\n───"]) {
    assert.equal(joined(updateBacklog(undefined, text, {})), text);
  }
});

test("one changed row retains all other rows, blocks and its own parent key", () => {
  const before = updateBacklog(undefined, source, {});
  assert.equal(updateBacklog(before, source, {}), before);
  const text = source.replace("Satır 2500:", "Değişen 2500:");
  const after = updateBacklog(before, text, {});
  assert.equal(joined(after), text);
  assert.equal(after.rows.filter((row, i) => row === before.rows[i]).length, 4999);
  assert.equal(after.blocks.filter((block, i) => block === before.blocks[i]).length, before.blocks.length - 1);
  assert.deepEqual(after.blocks.map(b => b.id), before.blocks.map(b => b.id));
});

test("trimmed history and appends reuse retained blocks without duplicate keys", () => {
  const before = updateBacklog(undefined, source, {});
  const text = source.slice(source.indexOf("\n") + 1) + "\nYeni satır";
  const after = updateBacklog(before, text, {});
  assert.equal(joined(after), text);
  assert.ok(after.blocks.filter(block => before.blocks.includes(block)).length > 70);
  assert.equal(after.rows[0], before.rows[1]);
  assert.equal(new Set(after.rows.map(r => r.id)).size, after.rows.length);
  assert.equal(new Set(after.blocks.map(b => b.id)).size, after.blocks.length);
});

test("duplicate lines remain exact across replacements, inserts and clearing", () => {
  let doc;
  for (const text of ["a\na\na\n", "a\nb\na\n", "a\na\nb\na\n", "", "a\na"]) {
    doc = updateBacklog(doc, text, {});
    assert.equal(joined(doc), text);
    assert.equal(new Set(doc.rows.map(r => r.id)).size, doc.rows.length);
    assert.equal(new Set(doc.blocks.map(b => b.id)).size, doc.blocks.length);
  }
});

test("colour changes update unchanged text; palette reindexing preserves identity", () => {
  const before = updateBacklog(undefined, "red\nblue", { styles: ["p1||000000", "p4||000000"], runs: [0, 3, 0, 4, 4, 1] });
  const indexed = updateBacklog(before, "red\nblue", { styles: ["p4||000000", "p1||000000"], runs: [0, 3, 1, 4, 4, 0] });
  assert.equal(indexed, before);
  const changed = updateBacklog(before, "red\nblue", { styles: ["p2||000000", "p4||000000"], runs: [0, 3, 0, 4, 4, 1] });
  assert.notEqual(changed.rows[0], before.rows[0]);
  assert.equal(changed.rows[1], before.rows[1]);
  assert.equal(changed.blocks[0].id, before.blocks[0].id);
});

test("runs spanning line breaks are clipped and offset correctly per row", () => {
  const doc = updateBacklog(undefined, "ab\ncd", { styles: ["p1||000000"], runs: [1, 4, 0] });
  assert.deepEqual(doc.rows.map(r => r.styled.runs), [[1, 2, 0], [0, 2, 0]]);
  const split = updateBacklog(doc, "ab\ncd", { styles: ["p1||000000"], runs: [1, 1, 0, 2, 3, 0] });
  assert.equal(split, doc);
});

test("mixed trims, appends, edits and palette changes match a fresh render", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `repeat ${i % 7} ───`);
  let doc;
  for (let step = 0; step < 40; step++) {
    if (step % 4 === 0) lines.shift();
    if (step % 4 === 1) lines.push(`new ${step}`);
    if (step % 4 === 2) lines[step] += " edit";
    const styles = step % 3 === 0 ? ["p1||000000", "p2||000000"] : ["p2||000000", "p1||000000"];
    const runs = []; let at = 0;
    lines.forEach((line, i) => {
      runs.push(at, line.length, (i + step) % 2); at += line.length + 1;
    });
    const text = lines.join("\n"), styled = { styles, runs };
    doc = updateBacklog(doc, text, styled);
    const fresh = updateBacklog(undefined, text, styled);
    assert.equal(joined(doc), text);
    assert.deepEqual(doc.rows.map(r => r.signature), fresh.rows.map(r => r.signature));
    assert.equal(new Set(doc.blocks.map(b => b.id)).size, doc.blocks.length);
  }
});
