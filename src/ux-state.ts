import { t } from "./i18n";

// Keep UI decisions independent of rendering so every surface uses the same truth.
export function canCloseSettings(busy: boolean, dirty: boolean, confirm: () => boolean) {
  return !busy && (!dirty || confirm());
}

export function deadlineNotice(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds > 60) return "";
  if (seconds <= 0) return t("ux.deadlineExpired");
  return seconds <= 20 ? t("ux.deadline20") : t("ux.deadline60");
}

export function turnNotice(reason: unknown) {
  if (reason === "end_turn" || reason === "completed") return t("ux.turnReady");
  if (reason === "cancelled" || reason === "interrupted") return t("ux.turnStopped");
  return t("ux.turnFailed");
}

export type QuotaWindow = { usedPercent: number; stale?: boolean; resetsAt?: number | null };
export function quotaReading(win: QuotaWindow, now: number) {
  const stale = !!win.stale || (!!win.resetsAt && win.resetsAt * 1000 <= now);
  return stale ? { remaining: null, label: t("ux.staleQuota") }
    : { remaining: Math.min(100, Math.max(0, 100 - Math.round(win.usedPercent))), label: t("ux.currentQuota") };
}

export function quotaAge(updatedAt: number | undefined, now: number) {
  if (!updatedAt || !Number.isFinite(updatedAt)) return t("ux.readingUnknown");
  return t("ux.lastRead", { minutes: Math.max(0, Math.floor((now - updatedAt) / 60000)) });
}

export function latestTurnOutcome(events: { seq: number; kind: string; stopReason?: unknown }[]) {
  let outcome: { seq: number; stopReason: unknown } | null = null;
  for (const event of events) {
    if (event.kind === "user") outcome = null;
    if (event.kind === "turn") outcome = { seq: event.seq, stopReason: event.stopReason };
    if (event.kind === "error") outcome = { seq: event.seq, stopReason: "error" };
  }
  return outcome;
}
