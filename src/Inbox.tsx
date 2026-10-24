import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, Check, X } from "lucide-react";
import { stored, remember } from "./storage";
import { t, useI18n, type TranslationKey } from "./i18n";
import {
  baseline,
  extractEvents,
  idsOfSession,
  isPending,
  isUnread,
  markSeen,
  parseSeen,
  planNotifications,
  remainingLabel,
  sessionMarker,
  unreadCount,
  type InboxEvent,
  type InboxSession,
  type SeenState,
} from "./inbox";

const SEEN_KEY = "panel-inbox-seen";
const NOTIFY_KEY = "panel-inbox-notify";
const supportsNotifications = () => typeof Notification !== "undefined";
const typeLabel = (type: InboxEvent["type"]) => t(`inbox.type.${type}` as TranslationKey);

// Keeps the inbox state for the signed-in viewer. Events come from the live
// session list (`attention` field), so a WebSocket reconnect or a reload simply
// re-derives the same events with the same ids; the seen/notified id sets live
// in localStorage and make that idempotent.
export function useInbox(sessions: InboxSession[], selected: string | null, onOpen: (sessionId: string) => void) {
  const events = useMemo(() => extractEvents(sessions), [sessions]);
  const [state, setState] = useState<SeenState>(() => parseSeen(stored(SEEN_KEY)) ?? { seen: [], notified: [] });
  const [initialised, setInitialised] = useState(() => parseSeen(stored(SEEN_KEY)) !== null);
  const [notify, setNotify] = useState(() => stored(NOTIFY_KEY) === "on" && supportsNotifications() && Notification.permission === "granted");
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const stateRef = useRef(state);
  stateRef.current = state;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const commit = useCallback((next: SeenState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    remember(SEEN_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // One decision pass per list/selection change.
  useEffect(() => {
    if (!sessions.length) return; // list not loaded yet
    let current = stateRef.current;
    if (!initialised) {
      current = baseline(events);
      setInitialised(true);
    }
    // The session being looked at while the tab is visible is read as it happens.
    if (visible && selected) current = markSeen(current, idsOfSession(events, selected));
    // Events are recorded as notified even while notifications are off, so
    // turning them on later does not replay the backlog.
    const plan = planNotifications(events, current, { sessionId: selected, visible });
    current = plan.next;
    if (notify && supportsNotifications() && Notification.permission === "granted")
      for (const e of plan.toNotify) showNotification(e, (id) => openRef.current(id));
    commit(current);
  }, [events, selected, visible, notify, initialised, sessions.length, commit]);

  const markAllSeen = useCallback(() => commit(markSeen(stateRef.current, events.map((e) => e.id))), [events, commit]);
  const markSessionSeen = useCallback((sessionId: string) => commit(markSeen(stateRef.current, idsOfSession(events, sessionId))), [events, commit]);

  // Permission is requested only here, from the user's click on the toggle.
  const toggleNotify = useCallback(async () => {
    if (!supportsNotifications()) return;
    if (notify) {
      remember(NOTIFY_KEY, "off");
      setNotify(false);
      return;
    }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") {
      remember(NOTIFY_KEY, "on");
      setNotify(true);
    }
  }, [notify]);

  return {
    events,
    state,
    unread: unreadCount(events, state),
    pending: events.filter(isPending).length,
    marker: (id: string) => sessionMarker(id, events, state),
    notify,
    notifyDenied: supportsNotifications() && Notification.permission === "denied",
    notifySupported: supportsNotifications(),
    toggleNotify,
    markAllSeen,
    markSessionSeen,
  };
}

function showNotification(e: InboxEvent, open: (sessionId: string) => void) {
  try {
    const body = e.title ? `${e.sessionTitle}: ${e.title}` : e.sessionTitle;
    // `tag` makes the browser replace, not stack, a repeat of the same event.
    const n = new Notification(typeLabel(e.type), { body, tag: e.id });
    n.onclick = () => {
      window.focus();
      open(e.sessionId);
      n.close();
    };
  } catch {
    /* Some mobile browsers only allow notifications through a service worker. */
  }
}

// Seconds-resolution clock, only running while something has a deadline.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function useCountdown(events: InboxEvent[]) {
  return useNow(events.some((e) => e.expiresAt));
}
export { remainingLabel };

export function InboxDialog({
  inbox,
  now,
  onOpen,
  onClose,
}: {
  inbox: ReturnType<typeof useInbox>;
  now: number;
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const items = [...inbox.events].sort(
    (a, b) => Number(isPending(b)) - Number(isPending(a)) || (b.at ?? "").localeCompare(a.at ?? ""),
  );
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal inbox-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-title">
        <button type="button" className="modal-close icon-button" aria-label={t("inbox.close")} onClick={onClose}><X size={18} /></button>
        <h2 id="inbox-title">{t("inbox.title")}</h2>
        <div className="inbox-tools">
          {inbox.notifySupported && (
            <button type="button" className={`inbox-notify ${inbox.notify ? "on" : ""}`} onClick={inbox.toggleNotify} aria-pressed={inbox.notify} disabled={inbox.notifyDenied}>
              {inbox.notify ? <Bell size={15} /> : <BellOff size={15} />}
              {inbox.notifyDenied ? t("inbox.notificationsBlocked") : inbox.notify ? t("inbox.notificationsOn") : t("inbox.enableNotifications")}
            </button>
          )}
          {inbox.unread > 0 && <button type="button" className="inbox-readall" onClick={inbox.markAllSeen}><Check size={15} />{t("inbox.markAllRead")}</button>}
        </div>
        {items.length === 0 ? (
          <p className="inbox-empty">{t("inbox.empty")}</p>
        ) : (
          <ul className="inbox-list">
            {items.map((e) => {
              const left = remainingLabel(e.expiresAt, now);
              return (
                <li key={e.id}>
                  <button type="button" className={`inbox-item ${e.type} ${isUnread(e, inbox.state) ? "unread" : ""}`} onClick={() => onOpen(e.sessionId)}>
                    <span className="inbox-type">{typeLabel(e.type)}</span>
                    <strong>{e.sessionTitle}</strong>
                    {e.title && <small>{e.title}</small>}
                    {left && <span className="inbox-left" title={t("inbox.timeUntilAutoReject")}>{left}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
