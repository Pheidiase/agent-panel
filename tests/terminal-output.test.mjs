import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const js = ts.transpileModule(fs.readFileSync(new URL("../src/terminal-output.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { TerminalOutputBuffer } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes = [];
  let now = 0;
  const buffer = new TerminalOutputBuffer(data => writes.push(data), () => now);
  t.after(() => buffer.dispose());
  return { buffer, writes, advance(ms) { now += ms; t.mock.timers.tick(ms); } };
}

test("stream bursts preserve split escape sequences and flush on a fixed deadline", t => {
  const { buffer, writes, advance } = setup(t);
  buffer.push("\x1b["); advance(12);
  buffer.push("2Jredraw"); advance(11);
  assert.deepEqual(writes, []);
  advance(1);
  assert.deepEqual(writes, ["\x1b[2Jredraw"]);
});

test("typing drains older output in order and echo skips the stream delay", t => {
  const { buffer, writes, advance } = setup(t);
  buffer.push("old"); advance(2);
  buffer.input();
  buffer.push(".");
  assert.deepEqual(writes, ["old", "."]);
  advance(30);
  assert.deepEqual(writes, ["old", "."], "the old timer cannot duplicate output");
});

test("typing keeps multi-part echoes fast; idle streaming returns to batching", t => {
  const { buffer, writes, advance } = setup(t);
  buffer.input(); advance(200); buffer.push("a");
  buffer.input(); advance(200); buffer.push("b");
  assert.deepEqual(writes, ["a", "b"]);
  advance(50); buffer.push("stream");
  assert.deepEqual(writes, ["a", "b"]);
  advance(24);
  assert.deepEqual(writes, ["a", "b", "stream"]);
});

test("large bursts flush immediately without dropping or reordering text", t => {
  const { buffer, writes } = setup(t);
  buffer.push("prefix");
  buffer.push("x".repeat(262144));
  assert.equal(writes.join(""), "prefix" + "x".repeat(262144));
});

test("disposed connections discard queued output and cancel late writes", t => {
  const { buffer, writes, advance } = setup(t);
  buffer.push("pending"); buffer.dispose();
  advance(1000); buffer.input(); buffer.push("late");
  assert.deepEqual(writes, []);
});
