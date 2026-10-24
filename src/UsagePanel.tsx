import { getLocale, formatPercent, t, useI18n } from "./i18n";
import React, { useEffect, useId, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";

type Win = { usedPercent: number; resetsAt: number | null; stale: boolean } | null;
type Source = { available: boolean; plan?: string | null; fiveHour?: Win; weekly?: Win; updatedAt?: number };
type Usage = { codex: Source; claude: Source };

const REFRESH_MS = 60_000;

function resetText(win: NonNullable<Win>, now: number): string {
  if (!win.resetsAt) return "";
  const mins = Math.max(0, Math.round((win.resetsAt * 1000 - now) / 60000));
  if (mins < 60) return `${mins} ${t("usage.minuteShort")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t("usage.hourShort")} ${mins % 60} ${t("usage.minuteShort")}`;
  return `${Math.floor(hours / 24)} ${t("usage.dayShort", { count: Math.floor(hours / 24) })} ${hours % 24} ${t("usage.hourShort")}`;
}

// Weekly row: time left and the reset moment.
function weeklyText(win: NonNullable<Win>, now: number): string {
  if (!win.resetsAt) return "";
  const when = new Intl.DateTimeFormat(getLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(win.resetsAt * 1000));
  return `${resetText(win, now)} ${t("usage.later")} · ${when}`;
}

const WEEK_MS = 7 * 86400000;
const DAY_MS = 86400000;

// Even-pacing budget: the week is 7 equal days that start at the reset hour.
export function weeklyPace(win: NonNullable<Win>, now: number) {
  if (!win.resetsAt) return null;
  const start = win.resetsAt * 1000 - WEEK_MS;
  const elapsed = Math.min(Math.max(now - start, 0), WEEK_MS);
  const dayIdx = Math.min(Math.floor(elapsed / DAY_MS), 6);
  const target = (elapsed / WEEK_MS) * 100;
  const dayEnd = ((dayIdx + 1) / 7) * 100;
  return { target, dayEnd, today: dayEnd - win.usedPercent };
}

function paceText(win: NonNullable<Win>, now: number): string {
  const p = weeklyPace(win, now);
  if (!p) return "";
  const nowLeft = Math.round(100 - p.target);
  const endLeft = Math.round(100 - p.dayEnd);
  const full = p.today <= 0.5 ? t("usage.todaySpent") : "";
  return `${full}${t("usage.remainingPace", { now: nowLeft, end: endLeft })}`;
}

function ageText(updatedAt: number | undefined, now: number): string {
  if (!updatedAt) return "";
  const mins = Math.max(0, Math.round((now - updatedAt) / 60000));
  if (mins < 1) return t("usage.now");
  if (mins < 60) return t("usage.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  return hours < 48 ? t("usage.hoursAgo", { count: hours }) : t("usage.daysAgo", { count: Math.round(hours / 24) });
}

function Row({ label, win, now, weekly, detay }: { label: string; win: Win; now: number; weekly?: boolean; detay: boolean }) {
  if (!win) return null;
  const used = Math.round(win.usedPercent);
  const left = 100 - used;
  const tone = used >= 90 ? "hot" : used >= 70 ? "warm" : "";
  return (
    <span className="usage-row" title={t("usage.rowTitle", { label, used, reset: win.resetsAt ? ` · ${resetText(win, now)} ${t("usage.resetAfter")}` : "" })}>
      <span className="usage-label">{label}</span>
      <span className={`usage-bar ${tone}`} role="meter" aria-label={t("usage.remainingLabel", { label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}>
        <i style={{ width: `${left}%` }} />
      </span>
      <span className="usage-left">{formatPercent(left)}</span>
      {detay && <small>{weekly ? weeklyText(win, now) : `${resetText(win, now)} ${t("usage.later")}`}</small>}
      {detay && weekly && win.resetsAt && <small className="usage-pace">{paceText(win, now)}</small>}
    </span>
  );
}

// Kompakt: ad solda, iki ince çubuk sağda. Ayrıntı: plan, yaş, sıfırlanma ve tempo.
function Block({ id, name, src, now, detay }: { id: string; name: string; src: Source; now: number; detay: boolean }) {
  const rows = src.available ? (
    <>
      {(src.fiveHour?.stale || src.weekly?.stale) && <small className="usage-empty">{t("usage.stale")}</small>}
      <Row label={detay ? `5 ${t("usage.hours")}` : `5 ${t("usage.hourShort")}`} win={src.fiveHour ?? null} now={now} detay={detay} />
      <Row label={t("usage.weekly")} win={src.weekly ?? null} now={now} weekly detay={detay} />
    </>
  ) : (
    <small className="usage-empty" title={id === "claude" ? t("usage.claudeWaiting") : t("usage.noData")}>
      {detay ? (id === "claude" ? t("usage.claudeWaiting") : t("usage.noData")) : "—"}
    </small>
  );
  // Kompakt tek satır: 5 saatlik pencere çubukta, haftalık kalan yanında sayı.
  if (!detay) {
    const week = src.available && src.weekly ? 100 - Math.round(src.weekly.usedPercent) : null;
    const stale = src.available && (src.fiveHour?.stale || src.weekly?.stale);
    return (
      <span className={`usage-block kompakt agent-${id}`}>
        <b className="usage-name">{name}</b>
        <span className="usage-rows">
          {src.available ? <Row label={`5 ${t("usage.hourShort")}`} win={src.fiveHour ?? null} now={now} detay={false} /> : rows}
        </span>
        {week !== null && <span className="usage-week" title={t("usage.weekRemaining", { left: week })}>{t("usage.week", { left: week })}</span>}
        {stale && <span className="usage-stale" title={t("usage.staleTitle")}>{t("usage.old")}</span>}
      </span>
    );
  }
  return (
    <span className={`usage-block agent-${id}`}>
      <span className="usage-head">
        <span className="lamp on" aria-hidden="true" />
        <b>{name}</b>
        {src.plan && <em>{src.plan}</em>}
        {src.available && <small>{ageText(src.updatedAt, now)}</small>}
      </span>
      {rows}
    </span>
  );
}

const DETAY_KEY = "panel-usage-detail";
function readDetay(): boolean {
  try {
    return localStorage.getItem(DETAY_KEY) === "1";
  } catch {
    return false;
  }
}

// Ekran okuyucu özeti: düğmenin adı sabit kalır, rakamlar açıklama olarak okunur.
function summary(name: string, src: Source): string {
  if (!src.available) return t("usage.noDataSummary", { name });
  const left = (w: Win | undefined) => (w ? formatPercent(100 - Math.round(w.usedPercent)) : t("usage.unknown"));
  const stale = src.fiveHour?.stale || src.weekly?.stale ? t("usage.staleSummary") : "";
  return `${name}: 5 ${t("usage.hours")} ${left(src.fiveHour)}, ${t("usage.weekly").toLocaleLowerCase(getLocale())} ${left(src.weekly)} ${t("usage.remaining")}${stale}`;
}

// Collapsed mobile summary: 5-hour remaining per agent.
function short(src: Source): string {
  const w = src.available ? src.fiveHour : null;
  return w ? formatPercent(100 - Math.round(w.usedPercent)) : "—";
}

export function UsagePanel({ mobile = false }: { mobile?: boolean }) {
  useI18n();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [detay, setDetay] = useState(readDetay);
  const descId = useId();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/usage");
        if (!r.ok) throw new Error();
        if (alive) {
          setUsage(await r.json());
          setNow(Date.now());
          setError(false);
        }
      } catch { if (alive) setError(true); }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [retry]);
  if (!usage) return <p role="status">{t(error ? "usage.retryError" : "usage.loading")}{error && <button type="button" onClick={() => setRetry(value => value + 1)}>{t("usage.retry")}</button>}</p>;
  if (mobile)
    return (
      <details className="mobile-usage">
        <summary>
          <Gauge size={15} aria-hidden="true" />
          <span>{t("usage.title")}</span>
          <span className="mobile-usage-short agent-codex">Codex {short(usage.codex)}</span>
          <span className="mobile-usage-short agent-claude">Claude {short(usage.claude)}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <section className="usage-panel detay" aria-label={t("usage.limits")}>
          {error && <p role="status">{t("usage.retryError")} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("usage.retry")}</button></p>}
          <Block id="codex" name="Codex" src={usage.codex} now={now} detay />
          <Block id="claude" name="Claude" src={usage.claude} now={now} detay />
        </section>
      </details>
    );
  const toggle = () => {
    const next = !detay;
    setDetay(next);
    try {
      localStorage.setItem(DETAY_KEY, next ? "1" : "0");
    } catch {}
  };
  return (
    <>
    {error && <p role="status">{t("usage.retryError")} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("usage.retry")}</button></p>}
    <span id={descId} className="sr-only">{summary("Codex", usage.codex)}. {summary("Claude", usage.claude)}.</span>
    <button type="button" className={`usage-panel ${detay ? "detay" : "kompakt"}`} aria-label={t("usage.limits")} aria-describedby={descId} aria-expanded={detay}
      title={detay ? t("usage.hideDetails") : t("usage.showDetails")} onClick={toggle}>
      <Block id="codex" name="Codex" src={usage.codex} now={now} detay={detay} />
      <Block id="claude" name="Claude" src={usage.claude} now={now} detay={detay} />
    </button>
    </>
  );
}
