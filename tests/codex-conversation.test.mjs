import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { locateCodexRollout, parseCodexConversation, readCodexConversation } from "../server/codex-conversation.mjs";

const line = (o) => JSON.stringify(o);
const user = (id, text) => line({ timestamp: "2026-10-08T10:00:00Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text }] } } });
const sample = [
  line({ type: "session_meta", payload: { id: "t" } }),
  line({ type: "response_item", payload: { type: "message", role: "user", id: "inj", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } }),
  line({ type: "response_item", payload: { type: "message", role: "developer", id: "dev", content: [{ type: "input_text", text: "gizli yönerge" }] } }),
  user("u1", "testleri çalıştır"),
  line({ type: "response_item", payload: { type: "reasoning", id: "r", summary: [{ text: "gizli düşünce" }] } }),
  line({ timestamp: "2026-10-08T10:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", id: "a1", content: [{ type: "output_text", text: "Çalıştırıyorum." }] } }),
  line({ type: "response_item", payload: { type: "custom_tool_call", id: "c1", call_id: "k1", name: "exec", input: 'text(await tools.exec_command({cmd:"npm test",workdir:"/x"}))' } }),
  "{bozuk",
  line({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "k1", output: [{ type: "input_text", text: "Script completed\nWall time 1 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify({ exit_code: 0, output: "73 geçti\n" }) }] } }),
  line({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "yetim", output: "x" } }),
].join("\n");

test("parseCodexConversation: real user turns, answers and tool calls only", () => {
  const e = parseCodexConversation(sample);
  assert.deepEqual(e.map((x) => [x.role, x.kind]), [["user", "text"], ["assistant", "text"], ["assistant", "tool"]]);
  assert.equal(e[0].text, "testleri çalıştır");
  assert.equal(e[2].name, "exec");
  assert.equal(e[2].summary, "npm test");
  assert.equal(e[2].result, "73 geçti");
  const all = JSON.stringify(e);
  assert.ok(!all.includes("AGENTS.md") && !all.includes("gizli"));
});

test("parseCodexConversation: bounds entry count and sizes", () => {
  const many = Array.from({ length: 10 }, (_, i) => user(`u${i}`, `m${i}`)).join("\n");
  assert.deepEqual(parseCodexConversation(many, { max: 3 }).map((x) => x.text), ["m7", "m8", "m9"]);
  assert.equal(parseCodexConversation(user("b", "x".repeat(30000)))[0].text.length, 20000);
});

function fixture(threads) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
  const db = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, originator TEXT, archived INTEGER, created_at_ms INTEGER)");
  const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?)");
  for (const t of threads) {
    const file = path.join(home, ".codex", "sessions", `${t.id}.jsonl`);
    fs.writeFileSync(file, sample);
    ins.run(t.id, t.outside ? "/etc/passwd" : file, t.cwd || "/w", t.originator || "codex-tui", t.archived || 0, Date.parse(t.at));
  }
  db.close();
  return home;
}
const START = "2026-10-08T07:00:00.000Z";

test("locateCodexRollout: exactly one codex-tui thread in the start window", () => {
  const home = fixture([{ id: "ok", at: "2026-10-08T07:00:20Z" }, { id: "late", at: "2026-10-08T07:30:00Z" }, { id: "elsewhere", at: "2026-10-08T07:00:10Z", cwd: "/baska" }, { id: "app", at: "2026-10-08T07:00:10Z", originator: "codex_vscode" }]);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, home }).threadId, "ok");
});

test("locateCodexRollout: ambiguity, peers, bad paths and missing data fail closed", () => {
  const two = fixture([{ id: "a", at: "2026-10-08T07:00:20Z" }, { id: "b", at: "2026-10-08T07:00:40Z" }]);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, home: two }), null);
  const one = fixture([{ id: "a", at: "2026-10-08T07:00:20Z" }]);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, otherStarts: ["2026-10-08T07:01:00Z"], home: one }), null);
  assert.ok(locateCodexRollout({ cwd: "/w", startedAt: START, otherStarts: ["2026-10-08T09:00:00Z"], home: one }));
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, home: fixture([{ id: "x", at: "2026-10-08T07:00:20Z", outside: true }]) }), null);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, home: fixture([{ id: "x", at: "2026-10-08T07:00:20Z", archived: 1 }]) }), null);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: "nonsense", home: one }), null);
  assert.equal(locateCodexRollout({ cwd: "/w", startedAt: START, home: os.tmpdir() + "/yok-" + Date.now() }), null);
});

test("readCodexConversation: returns entries or unavailable", async () => {
  const home = fixture([{ id: "ok", at: "2026-10-08T07:00:20Z" }]);
  const r = await readCodexConversation({ cwd: "/w", startedAt: START }, { home });
  assert.equal(r.available, true);
  assert.equal(r.source, "codex");
  assert.equal(r.entries.length, 3);
  assert.deepEqual(await readCodexConversation({ cwd: "/nope", startedAt: START }, { home }), { available: false });
});
