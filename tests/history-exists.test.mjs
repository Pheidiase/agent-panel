// Ghost hide flags: keys of records that were deleted elsewhere are detected
// read-only from each agent's own store. A throw-away HOME is used; nothing real is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const script = path.resolve(import.meta.dirname, "../server/history-exists.py");

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-exists-"));
  fs.mkdirSync(path.join(home, ".hermes"));
  fs.mkdirSync(path.join(home, ".codex"));
  const h = new DatabaseSync(path.join(home, ".hermes/state.db"));
  h.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('live_one');");
  h.close();
  const c = new DatabaseSync(path.join(home, ".codex/state_5.sqlite"));
  c.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('${U1}');`);
  c.close();
  fs.mkdirSync(path.join(home, ".claude/projects/-tmp-x"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/projects/-tmp-x", `${U2}.jsonl`), "{}\n");
  return home;
}

const run = (home, keys) =>
  JSON.parse(execFileSync("/usr/bin/python3", [script, JSON.stringify(keys)], { env: { ...process.env, HOME: home } }).toString());

test("reports only the keys that still exist in each agent's store", () => {
  const home = fakeHome();
  const keys = ["hermes:live_one", "hermes:gone_1", `codex:${U1}`, "codex:00000000-0000-4000-8000-000000000000", `claude:${U2}`, `claude:${U1}`];
  assert.deepEqual(run(home, keys).sort(), [`claude:${U2}`, `codex:${U1}`, "hermes:live_one"].sort());
});

test("a store that cannot be read keeps its keys (never forget on a failed read)", () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, ".hermes/state.db"), "not a database");
  assert.deepEqual(run(home, ["hermes:live_one", "hermes:gone_1"]).sort(), ["hermes:gone_1", "hermes:live_one"]);
});

test("a missing store means its records do not exist; hostile keys are ignored", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-exists-empty-"));
  assert.deepEqual(run(home, ["hermes:a", "codex:b", "../x:y", "claude:../../etc/passwd"]), []);
});
