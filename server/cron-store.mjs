// Read-only view of the Hermes cron runtime for the panel's "Koşular" page.
// The panel never writes: jobs.json is parsed as text, executions.db is
// opened with a read-only SQLite handle (node:sqlite, no new dependency) and
// every query is a bounded SELECT. Missing or locked sources degrade the
// view instead of failing it; nothing here touches cron definitions,
// delivery state or the scheduler.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as sqlite from "node:sqlite";
const Database = sqlite.Database ?? sqlite.DatabaseSync;

export const CRON_JOB_LIMIT = 50;
export const CRON_RUN_LIMIT = 30;
export const CRON_INCIDENT_LIMIT = 20;
const ERROR_CAP = 300;

export function resolveCronDir(env = process.env) {
  if (typeof env.PANEL_CRON_DIR === "string" && env.PANEL_CRON_DIR.trim())
    return env.PANEL_CRON_DIR.trim();
  return path.join(os.homedir(), ".hermes", "cron");
}

function capText(value, cap = ERROR_CAP) {
  if (typeof value !== "string" || !value.trim()) return null;
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? oneLine.slice(0, cap - 1) + "…" : oneLine;
}

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function readCronView({ dir }) {
  const out = {
    jobs: [],
    runs: [],
    incidents: [],
    sources: { jobs: false, executions: false, incidents: false },
  };

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
    // Hermes writes { jobs: [ ... ] }; older/hand-made shapes may be a bare
    // array, an id-keyed map under jobs, or an id-keyed map at the top level.
    const source = raw && typeof raw === "object" ? raw : {};
    const list = Array.isArray(source)
      ? source
      : Array.isArray(source.jobs)
        ? source.jobs
        : Object.values(
            source.jobs && typeof source.jobs === "object" ? source.jobs : source,
          );
    out.sources.jobs = true;
    out.jobs = list
      .filter((job) => job && typeof job === "object" && job.id)
      .slice(0, CRON_JOB_LIMIT)
      .map((job) => ({
        id: String(job.id),
        name: capText(job.name, 120) ?? String(job.id),
        schedule:
          capText(job.schedule?.display ?? null, 60) ??
          capText(job.schedule?.expr ?? null, 60) ??
          (typeof job.schedule === "string" ? capText(job.schedule, 60) : null),
        enabled: job.enabled !== false && !job.paused_at,
        state: typeof job.state === "string" ? job.state : null,
        nextRunAt: typeof job.next_run_at === "string" ? job.next_run_at : null,
        lastRunAt: typeof job.last_run_at === "string" ? job.last_run_at : null,
        lastStatus: typeof job.last_status === "string" ? job.last_status : null,
        lastError: capText(job.last_error),
        failureStreak: Number.isInteger(job.failure_streak) ? job.failure_streak : 0,
        deliver: capText(job.deliver, 80),
      }));
  } catch {
    /* jobs.json missing or unreadable: the page still renders what it can. */
  }

  let db = null;
  try {
    db = new Database(path.join(dir, "executions.db"), { readOnly: true });
    out.sources.executions = true;
    try {
      db.exec("PRAGMA busy_timeout = 750");
    } catch {
      /* PRAGMA is a nicety; the read below still runs. */
    }
    const runs = db
      .prepare(
        `SELECT id, job_id, status, claimed_at, started_at, finished_at, error, delivery_outcome
         FROM executions ORDER BY claimed_at DESC, id DESC LIMIT ?`,
      )
      .all(CRON_RUN_LIMIT);
    out.runs = runs.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      status: String(row.status),
      claimedAt: row.claimed_at ?? null,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      error: capText(row.error),
      deliveryOutcome: typeof row.delivery_outcome === "string" ? row.delivery_outcome : null,
      durationMs: durationMs(row.started_at, row.finished_at),
    }));
    // Bind at most the displayed 50 jobs. Selecting an id with the same
    // ordering as the runs list resolves equal claimed_at values consistently.
    const latest = db.prepare(`SELECT status, claimed_at, finished_at, error, delivery_outcome
      FROM executions WHERE job_id = ? ORDER BY claimed_at DESC, id DESC LIMIT 1`);
    for (const job of out.jobs) {
      const last = latest.get(job.id) ?? null;
      job.lastExecution = last
        ? {
            status: String(last.status),
            claimedAt: last.claimed_at ?? null,
            finishedAt: last.finished_at ?? null,
            error: capText(last.error),
            deliveryOutcome:
              typeof last.delivery_outcome === "string" ? last.delivery_outcome : null,
          }
        : null;
    }
    try {
      const incidents = db
        .prepare(
          `SELECT id, job_id, state, failure_type, first_seen_at, last_seen_at, closed_at, error
           FROM cron_incidents ORDER BY last_seen_at DESC LIMIT ?`,
        )
        .all(CRON_INCIDENT_LIMIT);
      out.sources.incidents = true;
      out.incidents = incidents.map((row) => ({
        id: String(row.id),
        jobId: String(row.job_id),
        state: typeof row.state === "string" ? row.state : null,
        failureType: typeof row.failure_type === "string" ? row.failure_type : null,
        firstSeenAt: row.first_seen_at ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        closed: !!row.closed_at,
        error: capText(row.error),
      }));
    } catch {
      /* Older databases may not carry the incidents table. */
    }
  } catch {
    /* No executions database (or it is locked): degrade quietly. */
  } finally {
    try {
      db?.close();
    } catch {}
  }

  return out;
}
