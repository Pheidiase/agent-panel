import { getLocale, messageText, useI18n, type TranslationKey } from "./i18n";
// "Zamanlanmış koşular": read-only view of the Hermes cron runtime — jobs
// with their last run, the newest executions and open incidents. The server
// endpoint reads (never writes) jobs.json and executions.db; this page only
// renders, and polls every 30 s while open.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, RefreshCw, TriangleAlert } from "lucide-react";

type CronRun = {
  id: string;
  jobId: string;
  status: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  deliveryOutcome: string | null;
  durationMs: number | null;
};
type CronJob = {
  id: string;
  name: string;
  schedule: string | null;
  enabled: boolean;
  state: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureStreak: number;
  deliver: string | null;
  lastExecution: {
    status: string;
    claimedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    deliveryOutcome: string | null;
  } | null;
};
type CronIncident = {
  id: string;
  jobId: string;
  state: string | null;
  failureType: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  closed: boolean;
  error: string | null;
};
type CronData = {
  jobs: CronJob[];
  runs: CronRun[];
  incidents: CronIncident[];
  sources: { jobs: boolean; executions: boolean; incidents: boolean };
};

const INCIDENT_STATE_LABEL: Record<string, TranslationKey> = { open: "runs.incidentOpen", closed: "runs.closed", resolved: "runs.resolved" };

const STATUS_LABEL: Record<string, TranslationKey> = {
  completed: "runs.completed",
  ok: "runs.success",
  failed: "runs.failed",
  running: "runs.running",
  claimed: "runs.started",
  unknown: "runs.unknown",
};

function fmt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(getLocale(), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} sn`;
  return `${Math.round(ms / 60_000)} dk`;
}

export default function RunsView({
  request,
  onBack,
}: {
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<CronData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const value = (await request("/cron")) as CronData;
      setData(value);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }, [request]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const runsFor = (jobId: string) =>
    (data?.runs ?? []).filter((run) => run.jobId === jobId).slice(0, 5);
  const selected = data?.jobs.find((job) => job.id === expanded) ?? data?.jobs[0] ?? null;
  const openIncidents = (data?.incidents ?? []).filter((incident) => !incident.closed);

  return (
    <div className="runs-page">
      <div className="runs-head">
        <div className="runs-title">
          {onBack && (
            <button
              className="back-button"
              aria-label={t("runs.backToSessions")}
              onClick={onBack}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <span className="eyebrow">{t("runs.cron")}</span>
            <h2>{t("runs.scheduledRuns")}</h2>
            <p className="runs-sub">
              {t("runs.readOnly")}
            </p>
          </div>
        </div>
        <button className="text-button" onClick={load} disabled={busy}>
          <RefreshCw size={14} /> {busy ? t("runs.refreshing") : t("runs.refresh")}
        </button>
      </div>
      {error && (
        <div role="alert" className="error">
          {messageText(error)}
        </div>
      )}
      {!data && !error && <p className="runs-sub">{t("runs.loading")}</p>}
      {data && (
        <>
          {openIncidents.length > 0 && (
            <div className="runs-incidents">
              <strong>
                <TriangleAlert size={14} /> {t("runs.openIncidents")}
              </strong>
              {openIncidents.map((incident) => (
                <div key={incident.id} className="run-incident">
                <span className="run-chip failed">{incident.state ? t(INCIDENT_STATE_LABEL[incident.state] ?? "runs.incident") : t("runs.incident")}</span>
                  <span className="run-name">
                    {data.jobs.find((job) => job.id === incident.jobId)?.name ??
                      incident.jobId}
                  </span>
                  <span className="run-meta">{fmt(incident.lastSeenAt)}</span>
                  {incident.error && <p className="run-error">{incident.error}</p>}
                </div>
              ))}
            </div>
          )}
          <div className={`runs-split ${expanded ? "has-detail" : ""}`}>
            <div className="runs-list" role="list">
              {data.jobs.map((job) => {
                const last = job.lastExecution;
                const status = last?.status ?? job.lastStatus;
                const isOpen = selected?.id === job.id;
                const lastRun = runsFor(job.id)[0];
                return (
                  <div key={job.id} role="listitem" className={`run-row ${isOpen ? "open" : ""}`}>
                    <button
                      className="run-row-head"
                      onClick={() => setExpanded(job.id)}
                      aria-expanded={isOpen}
                    >
                      <span className="run-row-main">
                        <span className="run-name">{job.name}</span>
                        <span className="run-meta">{job.schedule ?? "—"}</span>
                        <span className="run-meta">
                          {last?.finishedAt
                            ? t("runs.lastAt", { time: fmt(last.finishedAt) })
                            : job.lastRunAt
                              ? t("runs.lastAt", { time: fmt(job.lastRunAt) })
                              : t("runs.neverRun")}
                        </span>
                      </span>
                      <span
                        className={`run-chip ${status === "failed" ? "failed" : status ? "ok" : ""}`}
                      >
                        {status ? t(STATUS_LABEL[status] ?? "runs.unknown") : t(job.enabled ? "runs.waiting" : "runs.closed")}
                      </span>
                      <span className="run-duration">{duration(lastRun?.durationMs ?? null)}</span>
                    </button>
                  </div>
                );
              })}
              {data.jobs.length === 0 && (
                <p className="runs-sub">{t("runs.noJobs")}</p>
              )}
            </div>
            {selected && (
              <section className="run-detail" aria-label={t("runs.detail", { name: selected.name })}>
                <button className="text-button runs-back" onClick={() => setExpanded(null)}>
                  <ArrowLeft size={14} /> {t("runs.backToList")}
                </button>
                <h3>{selected.name}</h3>
                <dl className="run-meta-table">
                  <dt>{t("runs.schedule")}</dt>
                  <dd>{selected.schedule ?? "—"}</dd>
                  <dt>{t("runs.lastRun")}</dt>
                  <dd>{fmt(selected.lastExecution?.finishedAt ?? selected.lastRunAt)}</dd>
                  <dt>{t("runs.nextRun")}</dt>
                  <dd>{fmt(selected.nextRunAt)}</dd>
                  <dt>{t("runs.delivery")}</dt>
                  <dd>{selected.deliver ?? "—"}</dd>
                  <dt>{t("runs.status")}</dt>
                  <dd>{t(selected.enabled ? "runs.incidentOpen" : "runs.closed")}</dd>
                </dl>
                {(selected.lastError || selected.lastExecution?.error) && (
                  <p className="run-error">{selected.lastError ?? selected.lastExecution?.error}</p>
                )}
                {selected.failureStreak > 1 && (
                  <p className="run-error">{t("runs.failureStreak", { count: selected.failureStreak })}</p>
                )}
                <h4>{t("runs.recentRuns")}</h4>
                {runsFor(selected.id).length === 0 && (
                  <p className="run-meta">{t("runs.noRuns")}</p>
                )}
                {runsFor(selected.id).map((run) => (
                  <div key={run.id} className="run-line">
                    <span className={`run-chip ${run.status === "failed" ? "failed" : "ok"}`}>
                      {STATUS_LABEL[run.status] ?? run.status}
                    </span>
                    <span className="run-meta">
                      {fmt(run.startedAt ?? run.claimedAt)} {duration(run.durationMs)}
                      {run.deliveryOutcome ? ` · ${t("runs.delivery")}: ${run.deliveryOutcome}` : ""}
                    </span>
                    {run.error && <p className="run-error">{run.error}</p>}
                  </div>
                ))}
              </section>
            )}
          </div>
          <p className="runs-sources">
            {t("runs.sources")}: jobs.json {data.sources.jobs ? "✓" : t("runs.unreadable")} · executions.db{" "}
            {data.sources.executions ? "✓" : t("runs.unreadable")} · {t("runs.incidents")} {data.sources.incidents ? "✓" : t("runs.unreadable")}
          </p>
        </>
      )}
    </div>
  );
}
