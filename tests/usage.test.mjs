// Usage view: Codex rate_limits are read from the newest rollout tail, Claude
// from the statusline snapshot; expired windows reset to 0 and missing data
// degrades to available:false.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsage } from "../server/usage.mjs";

const NOW = 1_791_500_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-usage-"));

function codexHome(limits) {
  const home = tmp();
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "09");
  fs.mkdirSync(dir, { recursive: true });
  const ev = (rl) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: rl } });
  fs.writeFileSync(path.join(dir, "rollout-a.jsonl"), [ev({ primary: { used_percent: 99, resets_at: 1 } }), ev(limits), "{broken"].join("\n"));
  return home;
}

test("codex: last rate_limits event wins, windows parsed", async () => {
  const home = codexHome({
    plan_type: "plus",
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: NOW / 1000 + 600 },
    secondary: { used_percent: 23, window_minutes: 10080, resets_at: NOW / 1000 + 90000 },
  });
  const u = await readUsage({ stateDir: tmp(), home, now: NOW });
  assert.equal(u.codex.available, true);
  assert.equal(u.codex.plan, "plus");
  assert.equal(u.codex.fiveHour.usedPercent, 12.5);
  assert.equal(u.codex.weekly.usedPercent, 23);
  assert.equal(u.claude.available, false);
});

test("expired window counts as reset", async () => {
  const home = codexHome({ primary: { used_percent: 80, resets_at: NOW / 1000 - 5 }, secondary: { used_percent: 10, resets_at: NOW / 1000 + 5 } });
  const u = await readUsage({ stateDir: tmp(), home, now: NOW });
  assert.deepEqual(u.codex.fiveHour, { usedPercent: 0, resetsAt: null, stale: true });
  assert.equal(u.codex.weekly.usedPercent, 10);
});

test("claude: snapshot from statusline", async () => {
  const stateDir = tmp();
  fs.writeFileSync(
    path.join(stateDir, "claude-usage.json"),
    JSON.stringify({ updated_at: NOW / 1000 - 30, five_hour: { used_percentage: 41, resets_at: NOW / 1000 + 100 }, seven_day: { used_percentage: 7, resets_at: NOW / 1000 + 9000 } }),
  );
  const u = await readUsage({ stateDir, home: tmp(), now: NOW });
  assert.equal(u.claude.available, true);
  assert.equal(u.claude.fiveHour.usedPercent, 41);
  assert.equal(u.claude.weekly.usedPercent, 7);
  assert.equal(u.claude.updatedAt, NOW - 30000);
  assert.equal(u.codex.available, false);
});

test("garbage snapshot is unavailable", async () => {
  const stateDir = tmp();
  fs.writeFileSync(path.join(stateDir, "claude-usage.json"), "not json");
  assert.equal((await readUsage({ stateDir, home: tmp(), now: NOW })).claude.available, false);
});
