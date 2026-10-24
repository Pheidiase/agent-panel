// Cron view store: fixture jobs.json + a real (temp) SQLite database with the
// runtime schema — parsing, ordering, per-job last runs, incidents, caps and
// graceful degradation. The module is read-only by construction; this test
// also verifies the read path leaves the database bytes untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCronReader } from "../server/cron-reader.mjs";
import { readCronView, CRON_JOB_LIMIT, CRON_RUN_LIMIT } from "../server/cron-store.mjs";

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-cron-"));
  const jobs = [];
  for (let i = 0; i < 3; i++) {
    jobs.push({
      id: `job${i}`,
      name: `İş ${i}`,
      schedule: { kind: "cron", expr: "0 8 * * *", display: "0 8 * * *" },
      enabled: i !== 2,
      state: i === 0 ? "scheduled" : "paused",
      paused_at: i === 0 ? null : "2026-10-06T09:00:00+03:00",
      next_run_at: "2026-10-07T08:00:00+03:00",
      last_run_at: "2026-10-06T08:03:51+03:00",
      last_status: i === 1 ? "failed" : "ok",
      last_error: i === 1 ? "örnek hata ayrıntısı".repeat(60) : null,
      failure_streak: i === 1 ? 3 : 0,
      deliver: "local",
    });
  }
  fs.writeFileSync(
    path.join(dir, "jobs.json"),
    JSON.stringify({ jobs, updated_at: "2026-10-06T08:03:51+03:00" }),
  );

  const db = new DatabaseSync(path.join(dir, "executions.db"));
  db.exec(`CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL,
    claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
    error TEXT, delivery_outcome TEXT
  )`);
  db.exec(`CREATE TABLE cron_incidents (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL,
    failure_type TEXT NOT NULL DEFAULT 'unknown', first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL, closed_at TEXT, error TEXT NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO executions (id, job_id, status, claimed_at, started_at, finished_at, error, delivery_outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("e1", "job0", "completed", "2026-10-06T08:00:51.803+03:00", "2026-10-06T08:00:52.731+03:00", "2026-10-06T08:03:51.211+03:00", null, "suppressed");
  insert.run("e2", "job1", "failed", "2026-10-05T19:35:13.465+03:00", "2026-10-05T19:35:14.716+03:00", "2026-10-05T19:35:18.487+03:00", "hata metni", "delivered");
  insert.run("e3", "job0", "completed", "2026-10-05T08:00:00.000+03:00", "2026-10-05T08:00:01.000+03:00", "2026-10-05T08:02:00.000+03:00", null, "delivered");
  db.prepare(
    `INSERT INTO cron_incidents (id, job_id, state, failure_type, first_seen_at, last_seen_at, closed_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("i1", "job1", "open", "timeout", "2026-10-05T19:35:14Z", "2026-10-05T19:35:18Z", null, "zaman aşımı");
  db.close();
  return dir;
}

test("cron view: jobs, runs, per-job last execution and incidents", (t) => {
  const dir = makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = {
    jobs: fs.readFileSync(path.join(dir, "jobs.json")),
    db: fs.readFileSync(path.join(dir, "executions.db")),
  };
  const view = readCronView({ dir });
  assert.deepEqual(view.sources, { jobs: true, executions: true, incidents: true });
  assert.equal(view.jobs.length, 3);
  assert.equal(view.jobs[0].name, "İş 0");
  assert.equal(view.jobs[0].schedule, "0 8 * * *");
  assert.equal(view.jobs[2].enabled, false);
  assert.equal(view.jobs[1].lastError.length, 300, "long errors are capped");
  assert.equal(view.runs.length, 3);
  assert.equal(view.runs[0].id, "e1", "newest execution first");
  assert.equal(view.runs[0].durationMs, 178480);
  assert.equal(view.jobs[0].lastExecution.status, "completed");
  assert.equal(view.jobs[0].lastExecution.claimedAt, "2026-10-06T08:00:51.803+03:00");
  assert.equal(view.jobs[1].lastExecution.status, "failed");
  assert.equal(view.incidents.length, 1);
  assert.equal(view.incidents[0].state, "open");
  assert.equal(view.incidents[0].closed, false);
  // Read-only by construction: the source bytes are untouched.
  assert.ok(before.jobs.equals(fs.readFileSync(path.join(dir, "jobs.json"))));
  assert.ok(before.db.equals(fs.readFileSync(path.join(dir, "executions.db"))));
});

test("cron view: caps jobs and runs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-cron-cap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobs = {};
  for (let i = 0; i < CRON_JOB_LIMIT + 10; i++)
    jobs[`j${i}`] = { id: `j${i}`, name: `J${i}`, schedule: { display: "* * * * *" } };
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  const db = new DatabaseSync(path.join(dir, "executions.db"));
  db.exec(`CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL,
    claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
    error TEXT, delivery_outcome TEXT
  )`);
  const insert = db.prepare(
    `INSERT INTO executions (id, job_id, status, claimed_at) VALUES (?, ?, ?, ?)`,
  );
  for (let i = 0; i < CRON_RUN_LIMIT + 5; i++)
    insert.run(`e${i}`, "j0", "completed", `2026-10-06T08:00:${String(i).padStart(2, "0")}.000+03:00`);
  db.close();
  const view = readCronView({ dir });
  assert.equal(view.jobs.length, CRON_JOB_LIMIT);
  assert.equal(view.runs.length, CRON_RUN_LIMIT);
  assert.equal(view.sources.jobs, true);
  assert.equal(view.sources.executions, true);
  assert.equal(view.sources.incidents, false, "missing incidents table degrades");
});

test("cron view: legacy id-keyed map shape still parses", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-cron-map-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "jobs.json"),
    JSON.stringify({ a: { id: "a", name: "A" } }),
  );
  const view = readCronView({ dir });
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].id, "a");
});

test("cron view: missing sources degrade instead of throwing", () => {
  const view = readCronView({ dir: path.join(os.tmpdir(), "agent-panel-cron-nope") });
  assert.deepEqual(view.sources, { jobs: false, executions: false, incidents: false });
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(view.runs, []);
  assert.deepEqual(view.incidents, []);
});


test("cron view: equal claim timestamps choose the same last execution as the runs list", t => {
  const dir = makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "executions.db"));
  db.prepare(`INSERT INTO executions (id, job_id, status, claimed_at) VALUES (?, ?, ?, ?)`)
    .run("zz-tie", "job0", "failed", "2026-10-06T08:00:51.803+03:00");
  // Mirror the existing external index; no production schema change.
  db.exec("CREATE INDEX job_claimed ON executions(job_id, claimed_at DESC, id DESC)");
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT status, claimed_at, finished_at, error, delivery_outcome
    FROM executions WHERE job_id = ? ORDER BY claimed_at DESC, id DESC LIMIT 1`).all("job0");
  assert.ok(plan.some(row => row.detail.includes("USING INDEX job_claimed")));
  db.close();
  const view = readCronView({ dir });
  assert.equal(view.runs[0].id, "zz-tie");
  assert.equal(view.jobs[0].lastExecution.status, view.runs[0].status);
});

test("cron worker coalesces reads and keeps the event loop responsive under a database lock", async t => {
  const dir = makeFixture();
  const db = new DatabaseSync(path.join(dir, "executions.db"));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const read = createCronReader({ dir });
  assert.deepEqual(await read(), readCronView({ dir }), "worker preserves the adapter's read-only result");
  db.exec("BEGIN EXCLUSIVE");
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  const first = read(), second = read();
  assert.equal(first, second, "one worker per in-flight read");
  try { await first; }
  finally { clearInterval(interval); db.exec("ROLLBACK"); }
  assert.ok(ticks >= 5, "SQLite's 750 ms busy wait must not block HTTP/terminal processing");
  assert.deepEqual(await read(), readCronView({ dir }), "a completed worker does not poison subsequent reads");
});
