// History presentation state: hide flags and display titles live in the panel's
// own state file, keyed by agent and session id. Validation rejects anything
// that is not a plain record key, and the store survives a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryPrefs } from "../server/history-prefs.mjs";

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-prefs-"));
}

test("hides and restores records by key, and persists across restart", () => {
  const dir = tempState();
  const a = new HistoryPrefs(dir);
  a.setHidden({ keys: ["claude:abc-1", "codex:xyz_2"], hidden: true });
  a.setHidden({ keys: ["codex:xyz_2"], hidden: false });
  const b = new HistoryPrefs(dir);
  assert.deepEqual(b.snapshot().hidden, ["claude:abc-1"]);
  assert.equal(fs.statSync(path.join(dir, "history-prefs.json")).mode & 0o777, 0o600);
});

test("renames records; an empty title restores the original", () => {
  const dir = tempState();
  const store = new HistoryPrefs(dir);
  store.setTitle({ key: "claude:abc-1", title: "  Deploy notları " });
  assert.equal(new HistoryPrefs(dir).snapshot().titles["claude:abc-1"], "Deploy notları");
  const cleared = store.setTitle({ key: "claude:abc-1", title: "   " });
  assert.deepEqual(cleared.titles, {});
});

test("rejects malformed keys, titles and bulk selections", () => {
  const store = new HistoryPrefs(tempState());
  assert.throws(() => store.setHidden({ keys: ["../etc:passwd"], hidden: true }), { status: 400 });
  assert.throws(() => store.setHidden({ keys: [], hidden: true }), { status: 400 });
  assert.throws(() => store.setHidden({ keys: ["claude:abc"] }), { status: 400 });
  assert.throws(() => store.setTitle({ key: "claude:abc", title: "a\nb" }), { status: 400 });
  assert.throws(() => store.setTitle({ key: "claude:abc", title: "x".repeat(81) }), { status: 400 });
});

test("ignores invalid entries in an existing state file", () => {
  const dir = tempState();
  fs.writeFileSync(path.join(dir, "history-prefs.json"), JSON.stringify({
    hidden: ["claude:ok-1", "bad key", 42],
    titles: { "codex:ok-2": "Ad", "nope": "x", "claude:ok-3": 7 },
  }));
  const snap = new HistoryPrefs(dir).snapshot();
  assert.deepEqual(snap.hidden, ["claude:ok-1"]);
  assert.deepEqual(snap.titles, { "codex:ok-2": "Ad" });
});
