import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { descendants, encodeCwd, locateClaudeLog, parseConversation, readClaudeConversation, readClaudeLogById, readTail } from "../server/claude-conversation.mjs";

const SID = "11111111-2222-4333-8444-555555555555";
const line = (o) => JSON.stringify(o);
const sample = [
  line({ type: "user", uuid: "u1", timestamp: "2026-10-08T10:00:00Z", message: { role: "user", content: "Merhaba, testleri çalıştır" } }),
  line({ type: "user", uuid: "u0", message: { role: "user", content: "<command-name>/model</command-name>" } }),
  line({ type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "gizli düşünce" }, { type: "text", text: "Çalıştırıyorum." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "x" } }] } }),
  "{bozuk json",
  line({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "68 geçti" }], is_error: false }] } }),
  line({ type: "assistant", uuid: "s1", isSidechain: true, message: { content: [{ type: "text", text: "alt ajan" }] } }),
  line({ type: "assistant", uuid: "m1", isMeta: true, message: { content: [{ type: "text", text: "meta" }] } }),
  line({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Hepsi geçti." }] } }),
  line({ type: "attachment", uuid: "x" }),
].join("\n");

test("parseConversation: messages and tool calls, without noise, thinking or sub-agents", () => {
  const e = parseConversation(sample);
  assert.deepEqual(e.map((x) => [x.role, x.kind]), [["user", "text"], ["assistant", "text"], ["assistant", "tool"], ["assistant", "text"]]);
  assert.equal(e[0].text, "Merhaba, testleri çalıştır");
  assert.equal(e[2].name, "Bash");
  assert.equal(e[2].summary, "npm test");
  assert.equal(e[2].result, "68 geçti");
  assert.equal(e[2].isError, false);
  assert.ok(!JSON.stringify(e).includes("gizli düşünce") && !JSON.stringify(e).includes("alt ajan") && !JSON.stringify(e).includes("meta"));
});

test("parseConversation: bounds entry count and text sizes", () => {
  const many = Array.from({ length: 10 }, (_, i) => line({ type: "user", uuid: `u${i}`, message: { content: `m${i}` } })).join("\n");
  assert.deepEqual(parseConversation(many, { max: 3 }).map((x) => x.text), ["m7", "m8", "m9"]);
  const big = line({ type: "assistant", uuid: "b", message: { content: [{ type: "text", text: "x".repeat(30000) }, { type: "tool_use", id: "t", name: "Read", input: {} }] } })
    + "\n" + line({ type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(5000), is_error: true }] } });
  const e = parseConversation(big);
  assert.equal(e[0].text.length, 20000);
  assert.equal(e[0].truncated, true);
  assert.equal(e[1].result.length, 1500);
  assert.equal(e[1].isError, true);
});

test("descendants walks the process tree breadth first without looping", () => {
  const table = [[10, 1], [11, 10], [12, 11], [13, 10], [99, 98], [10, 12]];
  assert.deepEqual(descendants(10, table), [10, 11, 13, 12]);
});

test("locateClaudeLog maps the pane's process tree to its own log only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-claude-"));
  const cwd = "/srv/projects/demo";
  const dir = path.join(home, ".claude", "projects", encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), sample);
  fs.writeFileSync(path.join(home, ".claude", "sessions", "300.json"), JSON.stringify({ pid: 300, sessionId: SID, cwd }));
  fs.writeFileSync(path.join(home, ".claude", "sessions", "400.json"), JSON.stringify({ pid: 400, sessionId: "../../etc/passwd", cwd }));
  const table = [[200, 100], [300, 200], [400, 500]];
  const hit = await locateClaudeLog(100, { home, table });
  assert.equal(hit.sessionId, SID);
  assert.equal(await locateClaudeLog(500, { home, table }), null);        // invalid session id is rejected
  assert.equal(await locateClaudeLog(999, { home, table }), null);        // unrelated tree
  assert.equal(await locateClaudeLog(-1, { home, table }), null);
  const conv = await readClaudeConversation(100, { home, table });
  assert.equal(conv.available, true);
  assert.equal(conv.entries.length, 4);
  assert.equal((await readClaudeConversation(999, { home, table })).available, false);
});

test("readTail drops the partial first line of a tail read", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-tail-")), "t.jsonl");
  fs.writeFileSync(f, "aaaaaaaaaa\nbbbb\ncccc\n");
  const t = readTail(f, 6);
  assert.equal(t.partial, true);
  assert.equal(t.text, "cccc\n");
  assert.equal(readTail(f, 1000).text, "aaaaaaaaaa\nbbbb\ncccc\n");
});

test("readClaudeLogById: an ended session reads the remembered log, nothing else", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-conv-id-"));
  try {
    const cwd = "/srv/projects/example";
    const dir = path.join(home, ".claude", "projects", encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), sample);
    const r = readClaudeLogById({ id: SID, cwd }, { home });
    assert.equal(r.available, true);
    assert.equal(r.entries.length, 4);
    assert.equal(readClaudeLogById({ id: "../../etc/passwd", cwd }, { home }).available, false);
    assert.equal(readClaudeLogById({ id: SID, cwd: "relative" }, { home }).available, false);
    assert.equal(readClaudeLogById({ id: SID, cwd: "/elsewhere" }, { home }).available, false);
    assert.equal(readClaudeLogById(undefined, { home }).available, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
