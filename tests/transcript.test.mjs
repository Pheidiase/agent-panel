import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../server/session-store.mjs";
const root = path.resolve(import.meta.dirname, "..");
const reader = path.join(root, "server/transcript.py");

async function render(content, tail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-transcript-"));
  const file = path.join(dir, "transcript.log");
  fs.writeFileSync(file, content);
  try {
    const args = [reader, file];
    if (tail !== undefined) args.push(String(tail));
    const result = await exec("/usr/bin/python3", args, { maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("transcript reader strips escapes and applies terminal line discipline", async () => {
  assert.equal(
    await render("\x1b[31mRED\x1b[0m\n\x1b]0;title\x07tail\n"),
    "RED\ntail",
  );
  // A progress line rewritten with carriage returns keeps only its last state.
  assert.equal(await render("progress 10%\rprogress 100%\n"), "progress 100%");
  // Backspace steps the cursor back, as a terminal would.
  assert.equal(await render("abc\x08\x08XY\n"), "aXY");
  // Chrome sequences and colour codes never reach the reader.
  assert.equal(await render("\x1b[?2004h\x1b[2Kplain\n"), "plain");
  // CRLF is a line ending, not a line eraser.
  assert.equal(await render("line\r\nnext\r\n"), "line\nnext");
  // A freshly pipped pane starts with the blank remainder of its screen.
  assert.equal(await render("\n\n\nREADY\n"), "READY");
});

test("transcript reader keeps the tail whole and never starts mid-line", async () => {
  const body = "FIRST_LINE\n" + "x".repeat(80) + "\nLAST_LINE\n";
  assert.equal(await render(body, 4096), "FIRST_LINE\n" + "x".repeat(80) + "\nLAST_LINE");
  // A tail that lands inside the long line drops that partial line only.
  const tailed = await render(body, 24);
  assert.ok(tailed.startsWith("LAST_LINE"), tailed);
  assert.ok(!tailed.includes("x"), tailed);
});

test("transcript reader decodes once so rewrites cannot split multi-byte characters", async () => {
  // Rewriting a line from column 0 used to slice the previous bytes mid-character
  // and turn the remainder into U+FFFD; the reader now works on decoded text.
  assert.equal(await render("üü\rz\n"), "zü");
  assert.equal(await render("işçi\riosis\n"), "iosis");
  // Replacement characters the application itself emitted pass through unchanged.
  assert.equal(await render("ok\uFFFD\uFFFD\n"), "ok\uFFFD\uFFFD");
});
