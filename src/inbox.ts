import { t } from "./i18n";

// "Müdahale bekleyen işler" helpers: turns the `attention` field the server
// puts on every chat session into stable inbox events, and decides which are
// unread / worth a browser notification. Pure data code (no JSX, no DOM) so it
// is unit-testable under plain Node as well as imported by the panel.
export type AttentionApproval = { id: string; kind: "approval" | "question"; title: string; expiresAt: string | null };
export type Attention = {
  approvals?: AttentionApproval[];
  turn?: { seq: number; stopReason: string; at: string | null; failed?: boolean } | null;
  error?: { seq: number; text: string; at: string | null } | null;
};
export type InboxSession = { id: string; title: string; archived?: boolean; attention?: Attention | null };
export type InboxType = "approval" | "question" | "done" | "error";
export type InboxEvent = {
  // Stable across reconnects/reloads: session id + approval id / event seq.
  id: string;
  sessionId: string;
  sessionTitle: string;
  type: InboxType;
  title: string;
  at: string | null;
  expiresAt: string | null;
};
export type SeenState = { seen: string[]; notified: string[] };

export const typeLabel = (type: InboxType) => t(`inbox.type.${type}` as const);
// Pending approvals/questions are actionable until answered or expired.
export const isPending = (e: InboxEvent) => e.type === "approval" || e.type === "question";
const MAX_IDS = 400;

export function extractEvents(sessions: InboxSession[]): InboxEvent[] {
  const out: InboxEvent[] = [];
  for (const s of sessions) {
    const a = s.attention;
    if (!a || s.archived) continue;
    const base = { sessionId: s.id, sessionTitle: s.title };
    for (const p of a.approvals ?? [])
      out.push({ ...base, id: `${s.id}:approval:${p.id}`, type: p.kind === "question" ? "question" : "approval", title: p.title, at: null, expiresAt: p.expiresAt ?? null });
    if (a.turn && !a.turn.failed)
      out.push({ ...base, id: `${s.id}:turn:${a.turn.seq}`, type: "done", title: "", at: a.turn.at, expiresAt: null });
    if (a.error)
      out.push({ ...base, id: `${s.id}:error:${a.error.seq}`, type: "error", title: a.error.text, at: a.error.at, expiresAt: null });
  }
  return out;
}

const cap = (ids: string[]) => (ids.length > MAX_IDS ? ids.slice(ids.length - MAX_IDS) : ids);

export function parseSeen(raw: string | null | undefined): SeenState | null {
  try {
    const v = JSON.parse(raw ?? "");
    if (!v || !Array.isArray(v.seen) || !Array.isArray(v.notified)) return null;
    return { seen: v.seen.filter((x: unknown) => typeof x === "string"), notified: v.notified.filter((x: unknown) => typeof x === "string") };
  } catch {
    return null;
  }
}

// First run on this browser: finished results and errors that are already
// there count as seen and notified, so an old backlog never floods the inbox
// or notifications. Pending approvals stay live: they are still actionable.
export function baseline(events: InboxEvent[]): SeenState {
  const ids = events.filter((e) => !isPending(e)).map((e) => e.id);
  return { seen: cap(ids), notified: cap(ids) };
}

export function isUnread(e: InboxEvent, state: SeenState) {
  return !state.seen.includes(e.id);
}
export function unreadCount(events: InboxEvent[], state: SeenState) {
  const seen = new Set(state.seen);
  return events.filter((e) => !seen.has(e.id)).length;
}
export function markSeen(state: SeenState, ids: string[]): SeenState {
  const have = new Set(state.seen);
  const add = ids.filter((id) => !have.has(id));
  return add.length ? { ...state, seen: cap([...state.seen, ...add]) } : state;
}
// Events of one session (opening it, or viewing it while it happens).
export const idsOfSession = (events: InboxEvent[], sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId).map((e) => e.id);

// Which events deserve a browser notification now: not yet notified, not for
// the session being looked at while the tab is visible. Returns the events and
// the next state (every considered event is recorded so it never fires twice,
// including after a WebSocket reconnect or a reload).
export function planNotifications(
  events: InboxEvent[],
  state: SeenState,
  view: { sessionId: string | null; visible: boolean },
): { toNotify: InboxEvent[]; next: SeenState } {
  const notified = new Set(state.notified);
  const fresh = events.filter((e) => !notified.has(e.id));
  if (!fresh.length) return { toNotify: [], next: state };
  const watching = (e: InboxEvent) => view.visible && view.sessionId === e.sessionId;
  return {
    toNotify: fresh.filter((e) => !watching(e)),
    next: { ...state, notified: cap([...state.notified, ...fresh.map((e) => e.id)]) },
  };
}

// "4:32" style countdown; null when there is no deadline.
export function remainingLabel(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return t("inbox.expired");
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Sidebar marker for one session: waiting for the user beats unread result.
export function sessionMarker(sessionId: string, events: InboxEvent[], state: SeenState): "wait" | "unread" | null {
  const mine = events.filter((e) => e.sessionId === sessionId);
  if (mine.some(isPending)) return "wait";
  return mine.some((e) => isUnread(e, state)) ? "unread" : null;
}
