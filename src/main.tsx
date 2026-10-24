import { t, useI18n, getLocale, messageText, optionalKey, type UiMessage } from "./i18n";
import { LanguageSelect } from "./LanguageSelect";
import { Login } from "./Login";
import { type AuthConfig, type AuthFailure, type LoginGrant } from "./auth-text";
import { clearPrivateStorage } from "./storage";
import { fetchJson, type JsonValidator } from "./revalidation";
import { creationAttempt, startTitle, clearSubmitted, radioKeys } from "./input-state";
import { installDialogFocus } from "./dialog-focus";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { stored, remember } from "./storage";
import { clearTerminalSnapshots } from "./terminal-snapshots";
const TerminalView = React.lazy(() => import("./TerminalView"));
const StructuredView = React.lazy(() => import("./StructuredView"));
const RunsView = React.lazy(() => import("./RunsView"));
// İsteğe bağlı modül: bu iki dosya yoksa (genel dağıtım) giriş de sayfa da hiç görünmez, derleme yine geçer.
type KotaApi = <T>(url: string, method?: string, body?: unknown) => Promise<T>;
const kotaSayfa = import.meta.glob<{ YakSayfasi: React.ComponentType<{ api: KotaApi; onBack?: () => void }> }>("./KotaYakici.tsx");
const kotaDurum = import.meta.glob<{ YakNavDurum: React.ComponentType<{ api: KotaApi }> }>("./yak-status.tsx");
const kotaModuluVar = "./KotaYakici.tsx" in kotaSayfa && "./yak-status.tsx" in kotaDurum;
const YakSayfasi = kotaModuluVar ? React.lazy(() => kotaSayfa["./KotaYakici.tsx"]().then(module => ({ default: module.YakSayfasi }))) : () => null;
const YakNavDurum = kotaModuluVar ? React.lazy(() => kotaDurum["./yak-status.tsx"]().then(module => ({ default: module.YakNavDurum }))) : () => null;
import Palette from "./Palette";
import { mergeSessionList, type SessionList, type SessionOp } from "./live";
import { InboxDialog, remainingLabel, useCountdown, useInbox } from "./Inbox";
import { isPending, isUnread, type Attention } from "./inbox";
import { groupSidebar, isWorking, shortAge, type SidebarWait } from "./sidebar";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Flame,
  Folder,
  History,
  House,
  Layers3,
  LockKeyhole,
  LogOut,
  Monitor,
  MoreHorizontal,
  Moon,
  Pin,
  Plus,
  Radio,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  LoaderCircle,
  ArrowUp,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { UsagePanel } from "./UsagePanel";
import "./defter/tokens.css";
import "./defter/shell.css";
import "./defter/conversation.css";

type Project = {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  path: string;
  displayPath: string;
  kind?: string;
};
type Agent = {
  id: string;
  name: string;
  description: string;
  color: string;
  available: boolean;
};
type Session = {
  id: string;
  title: string;
  projectId: string;
  agentId: string;
  createdAt: string;
  status: "running" | "ended" | "unavailable";
  pid: number | null;
  archived?: boolean;
  pinned?: boolean;
  lastOpenedAt?: string;
  endedAt?: string;
  geometry?: { cols: number; rows: number };
  kind?: "terminal" | "structured";
  connection?: string;
  attention?: Attention | null;
};
type Past = {
  id: string;
  title: string;
  projectId: string;
  agentId: string;
  source: string;
  updatedAt: number;
};
// Panel-owned hide flags and display titles for read-only history records.
type HistoryPrefs = {hidden: string[]; titles: Record<string, string>};
const historyKey = (s: {agentId: string; id: string}) => `${s.agentId}:${s.id}`;
type UiError = UiMessage | UiMessage[];
function errorText(value: UiError) {
  return (Array.isArray(value) ? value : [value]).map(messageText).filter((text, i, all) => all.indexOf(text) === i).join(" ");
}
let csrf = "";
async function api<T>(url: string, method = "GET", body?: unknown, validator?: JsonValidator): Promise<T> {
  const headers: Record<string, string> = {};
  const blob = body instanceof Blob;
  if (method !== "GET") {
    headers["Content-Type"] = blob ? body.type : "application/json";
    headers["X-Panel-CSRF"] = csrf;
  }
  const { response: r, data } = await fetchJson(`/api${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : blob ? body : JSON.stringify(body),
  }, validator);
  if (!r.ok && r.status !== 304) {
    if (r.status === 401 && url !== "/login")
      window.dispatchEvent(new Event("panel-unauthorized"));
    const retryHeader = r.headers.get("Retry-After");
    const retryAfter = data.retryAfter ?? (retryHeader === null ? undefined : Number(retryHeader));
    throw Object.assign(new Error(data.error || ""), { status: r.status, code: data.code, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined });
  }
  return data;
}
function ProjectIcon({ id, size = 18 }: { id: string; size?: number }) {
  return id === "general" ? (
    <TerminalSquare size={size} />
  ) : id === "market-radar" ? (
    <Radar size={size} />
  ) : id === "is-arama" ? (
    <BriefcaseBusiness size={size} />
  ) : (
    <Layers3 size={size} />
  );
}
// Defter işareti: CSS ile çizilen küçük defter (sağ üst köşesi kıvrık).
function ProjectChips({ projects, value, onChange }: { projects: Project[]; value: string; onChange: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      if (expanded) return;
      const limit = row.clientWidth + 1;
      setHidden(Array.from(row.children).filter((c) => (c as HTMLElement).offsetLeft + (c as HTMLElement).offsetWidth > limit).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [projects, expanded]);
  const pick = (id: string, el: HTMLElement) => {
    onChange(id);
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  };
  const showToggle = expanded || hidden > 0;
  return (
    <div className={`project-chips${expanded ? " expanded" : ""}${!expanded && hidden > 0 ? " clipped" : ""}`}>
      <div className="chips-row" role="group" aria-label={t("main.workspace")} ref={rowRef}>
        <button aria-pressed={value === "all"} className={value === "all" ? "chosen" : ""} onClick={(e) => pick("all", e.currentTarget)}>{t("main.all")}</button>
        {projects.map((p) => (
          <button key={p.id} aria-pressed={value === p.id} className={value === p.id ? "chosen" : ""} onClick={(e) => pick(p.id, e.currentTarget)}>{p.name}</button>
        ))}
      </div>
      {showToggle && (
        <button
          type="button"
          className="chips-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? t("main.collapseWorkspaces") : t("main.hiddenWorkspaces", { count: hidden })}
          onClick={() => setExpanded((v) => !v)}
        >
          {!expanded && <span>+{hidden}</span>}
          <ChevronDown size={14} />
        </button>
      )}
    </div>
  );
}

function Logo() {
  return <span className="logo" aria-hidden="true" />;
}
type ThemePref = "system" | "light" | "dark";
function readTheme(): ThemePref {
  const v = stored("panel-theme", "system");
  return v === "light" || v === "dark" ? v : "system";
}
function applyTheme(theme: ThemePref) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
// Sayfa çizilmeden önce uygula ki tema titremesi olmasın.
applyTheme(readTheme());
// Tek düğme: her tıklama sistem → açık → koyu sırasıyla döner.
function ThemeSwitch() {
  useI18n();
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const options: Array<[ThemePref, string, React.ReactNode]> = [
    ["system", t("main.systemTheme"), <Monitor size={16} />],
    ["light", t("main.lightTheme"), <Sun size={16} />],
    ["dark", t("main.darkTheme"), <Moon size={16} />],
  ];
  const at = Math.max(0, options.findIndex(([id]) => id === theme));
  const [, label, icon] = options[at];
  const [next, nextLabel] = options[(at + 1) % options.length];
  return (
    <button
      type="button"
      className="theme-toggle icon-button"
      aria-label={t("main.themeChange", { label, next: nextLabel.toLocaleLowerCase(getLocale()) })}
      title={t("main.themeTitle", { label, next: nextLabel.toLocaleLowerCase(getLocale()) })}
      onClick={() => {
        setTheme(next);
        remember("panel-theme", next);
        applyTheme(next);
      }}
    >
      {icon}
    </button>
  );
}
function AgentMark({ id, small = false }: { id: string; small?: boolean }) {
  return (
    <span className={`agent-mark ${id} ${small ? "small" : ""}`}>
      {id === "hermes" ? (
        <Sparkles size={small ? 12 : 16} />
      ) : id === "codex" ? (
        <Command size={small ? 12 : 16} />
      ) : id === "shell" ? (
        <TerminalSquare size={small ? 12 : 16} />
      ) : (
        <span className="claude-glyph">✳</span>
      )}
    </span>
  );
}
// Structured chat tier labels per agent: dialog badge, footer transport and
// where the conversation record lives.
const CHAT_TIER: Record<string, { badge: string; footer: string; note: string }> = {
  hermes: {
    badge: "ACP · beta",
    footer: "Hermes ACP",
    get note() { return t("main.hermesNote"); },
  },
  codex: {
    badge: "app-server · beta",
    footer: "Codex app-server",
    get note() { return t("main.codexNote"); },
  },
  claude: {
    badge: "stream-json · beta",
    footer: "Claude Code stream-json",
    get note() { return t("main.claudeNote"); },
  },
};
function age(time: string | number) {
  const date = new Date(typeof time === "number" ? time * 1000 : time);
  return new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function SessionActions({session, onAction, onUpdate, onLogout, info}: {session: Session;
  onLogout?: () => void;
  info?: React.ReactNode;
  onAction: (kind: "rename" | "stop" | "delete", session: Session) => void;
  onUpdate: (session: Session, changes: {archived?: boolean; pinned?: boolean}) => void;
}) {
  return <details className="session-actions">
    <summary aria-label={t("main.actionsFor", { title: session.title })} title={t("main.sessionActions")}><MoreHorizontal size={20}/></summary>
    <div className="session-action-menu">
      {info && <div className="session-action-info">{info}</div>}
      <button onClick={() => onAction("rename", session)}>{t("main.rename")}</button>
      <button onClick={() => onUpdate(session, {pinned: !session.pinned})}>{session.pinned ? t("main.unpin") : t("main.pin")}</button>
      <button onClick={() => onUpdate(session, {archived: !session.archived})}>{session.archived ? t("main.unarchive") : t("main.archive")}</button>
      {session.status === "running" && <button onClick={() => onAction("stop", session)}>{t("main.stop")}</button>}
      <button className="delete-action" onClick={() => onAction("delete", session)}>{t("main.delete")}</button>
      {onLogout && <button className="account-logout" onClick={onLogout}>{t("main.logout")}</button>}
    </div>
  </details>;
}

function App() {
  const { language } = useI18n();
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authError, setAuthError] = useState(false);
  useEffect(() => installDialogFocus(), []);
  const [user, setUser] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [rawProjects, setProjects] = useState<Project[]>([]),
    [rawAgents, setAgents] = useState<Agent[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.hash.slice(1)).get("session") || (stored("panel-restore", "true") === "true" ? stored("panel-selected") || null : null)),
    [projectId, setProjectId] = useState("all"),
    [query, setQuery] = useState(""),
    [view, setView] = useState("sessions"),
    [past, setPast] = useState<Past[]>([]),
    [modal, setModal] = useState(false),
    [creating, setCreating] = useState(false),
    [newProject, setNewProject] = useState("general"),
    [newAgent, setNewAgent] = useState("hermes"),
    [newKind, setNewKind] = useState<"terminal" | "structured">("terminal"),
    [structuredAvailable, setStructuredAvailable] = useState(false),
    [structuredCodexAvailable, setStructuredCodexAvailable] = useState(false),
    [structuredClaudeAvailable, setStructuredClaudeAvailable] = useState(false),
    [panelVersion, setPanelVersion] = useState(""),
    [homeUrl, setHomeUrl] = useState<string | null>(null),
    [kotaYakiciAvailable, setKotaYakiciAvailable] = useState(false),
    [title, setTitle] = useState(""),
    [parallel, setParallel] = useState(false),
    [error, setError] = useState<UiError>(""),
    [mobileSession, setMobileSession] = useState(false),
    [action, setAction] = useState<{kind: "rename" | "stop" | "delete"; session: Session} | null>(null),
    [actionBusy, setActionBusy] = useState(false),
    [renameTitle, setRenameTitle] = useState(""),
    [drawerOpen, setDrawerOpen] = useState(false),
    [narrow, setNarrow] = useState(() => window.innerWidth <= 800),
    [listPinned, setListPinned] = useState(() => stored("panel-list-pinned", "true") === "true"),
    [statusFilter, setStatusFilter] = useState("all"),
    [restoreLast, setRestoreLast] = useState(() => stored("panel-restore", "true") === "true"),
    [undoArchive, setUndoArchive] = useState<{id: string; archived: boolean} | null>(null),
    [prefs, setPrefs] = useState<HistoryPrefs>({hidden: [], titles: {}}),
    [historySelection, setHistorySelection] = useState<string[]>([]),
    [showHidden, setShowHidden] = useState(false),
    [renaming, setRenaming] = useState<{key: string; title: string} | null>(null),
    [historyDelete, setHistoryDelete] = useState<Past[] | null>(null),
    [historyDeleteBusy, setHistoryDeleteBusy] = useState(false),
    [historyDeleteError, setHistoryDeleteError] = useState<UiError>(""),
    [hiddenProjects, setHiddenProjects] = useState<string[]>([]),
    [editProjects, setEditProjects] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)");
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // Localize catalog labels at render time; persisted data and IDs stay intact.
  const projects = useMemo(() => rawProjects.map(p => ({
    ...p,
    name: p.id === "general" ? t("main.generalProject") : p.name,
    description: p.description || t("main.discoveredProjectDescription"),
  })), [rawProjects, language]);
  const agents = useMemo(() => rawAgents.map(a => ({ ...a, name: a.id === "shell" ? t("main.shellAgent") : a.name })), [rawAgents, language]);
  // Gizlenen çalışma alanları yalnız seçicilerden kalkar; oturumlar ve klasör olduğu gibi durur.
  const pickable = useMemo(() => projects.filter((p) => !hiddenProjects.includes(p.id)), [projects, hiddenProjects]);
  useEffect(() => {
    if (projectId !== "all" && hiddenProjects.includes(projectId)) setProjectId("all");
  }, [projectId, hiddenProjects]);
  const saveHiddenProjects = (next: string[]) => {
    const before = hiddenProjects;
    setHiddenProjects(next);
    api<{ hidden: string[] }>("/project-prefs", "POST", { hidden: next })
      .then((d) => setHiddenProjects(d.hidden))
      .catch((e) => { setHiddenProjects(before); setError(e); });
  };
  const unauthorized = useCallback(() => {
    csrf = "";
    clearPrivateStorage();
    clearTerminalSnapshots();
    startPending.current = "";
    pendingCreation.current = null;
    setSessions([]);
    setSelected(null);
    setPast([]);
    setTitle("");
    setStartText("");
    setUser(null);
  }, []);
  useEffect(() => {
    api<AuthConfig>("/auth/config")
      .then((config) => { setAuthConfig(config); return api<LoginGrant>("/me"); })
      .then((d) => {
        csrf = d.csrf;
        setUser(d.username);
      })
      .catch((error: AuthFailure) => { if (error.status !== 401) setAuthError(true); })
      .finally(() => setReady(true));
    window.addEventListener("panel-unauthorized", unauthorized);
    return () => window.removeEventListener("panel-unauthorized", unauthorized);
  }, [unauthorized]);
  const liveList = useRef<SessionList<Session>>({ epoch: null, version: 0, items: [] });
  const refresh = useCallback(async () => {
    try {
      const epoch = liveList.current.epoch;
      const snapshot = await api<SessionList<Session> & { mode: string; epoch: string }>("/sessions?versioned=1");
      const result = mergeSessionList(liveList.current, snapshot, epoch === liveList.current.epoch);
      liveList.current = result.state;
      setSessions(result.state.items);
    } catch (e) {
      setError(e as AuthFailure);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    api<{
      projects: Project[];
      agents: Agent[];
      structured?: boolean;
      structuredCodex?: boolean;
      structuredClaude?: boolean;
      version: string;
      homeUrl?: string | null;
      kotaYakici?: boolean;
    }>("/catalog")
      .then((d) => {
        setProjects(d.projects);
        setAgents(d.agents);
        setStructuredAvailable(!!d.structured);
        setStructuredCodexAvailable(!!d.structuredCodex);
        setStructuredClaudeAvailable(!!d.structuredClaude);
        setPanelVersion(d.version);
        setHomeUrl(d.homeUrl || null);
        setKotaYakiciAvailable(kotaModuluVar && !!d.kotaYakici);
      })
      .catch((e) => setError(e));
    api<{ hidden: string[] }>("/project-prefs").then((d) => setHiddenProjects(d.hidden)).catch(() => {});
    refresh();
    // Slow reconciliation only: the live socket below carries changes
    // immediately; this catches anything a dropped socket missed.
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  // Live session list: one snapshot on attach, then incremental patches over
  // the /live socket; on a version gap the client asks for a fresh snapshot.
  useEffect(() => {
    if (!user) return;
    let disposed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;
    async function connect() {
      if (disposed) return;
      try {
        const d = await api<{ ticket: string }>("/live/ticket", "POST", {});
        if (disposed) return;
        const ws = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/live`,
          `panel-ticket.${d.ticket}`,
        );
        socket = ws;
        ws.onopen = () => {
          attempt = 0;
        };
        ws.onmessage = (event) => {
          if (disposed || socket !== ws) return;
          let data: {
            type?: string;
            mode?: string;
            version?: number;
            baseVersion?: number;
            epoch?: string;
            items?: Session[];
            ops?: SessionOp[];
          };
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          if (data.type !== "sessions") return;
          const result = mergeSessionList(liveList.current, data, true);
          if (result.resync) {
            ws.send(JSON.stringify({ type: "resync" }));
            return;
          }
          liveList.current = result.state;
          setSessions(result.state.items);
        };
        ws.onclose = (e) => {
          if (disposed) return;
          socket = null;
          if (e.code === 4001) {
            unauthorized();
            return;
          }
          retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
        };
      } catch {
        if (!disposed) retry = setTimeout(connect, 5000);
      }
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [user, unauthorized]);
  useEffect(() => {
    if (user && view === "history") {
      setHistorySelection([]); setRenaming(null); setShowHidden(false);
      api<Past[]>("/history")
        .then(setPast)
        .catch((e) => setError(e));
      api<HistoryPrefs>("/history-prefs")
        .then(async (saved) => {
          // One-time move of hides kept in this browser before they moved to the server.
          const legacy = (() => { try { const v = JSON.parse(stored("panel-hidden-history", "[]")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } })();
          const missing = legacy.filter((k) => !saved.hidden.includes(k));
          if (missing.length) {
            saved = await api<HistoryPrefs>("/history-prefs/hidden", "POST", {keys: missing, hidden: true});
          }
          remember("panel-hidden-history", "");
          setPrefs(saved);
        })
        .catch((e) => setError(e));
    }
  }, [user, view]);
  useEffect(() => { remember("panel-selected", selected || ""); }, [selected]);
  useEffect(() => { remember("panel-list-pinned", String(listPinned)); }, [listPinned]);
  useEffect(() => { remember("panel-restore", String(restoreLast)); }, [restoreLast]);
  useEffect(() => {
    const back = () => {
      setSelected(new URLSearchParams(location.hash.slice(1)).get("session"));
      setDrawerOpen(false); setView("sessions");
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeModal(); if (!actionBusy) setAction(null); if (!historyDeleteBusy) setHistoryDelete(null); setDrawerOpen(false);
        document.querySelectorAll<HTMLDetailsElement>(".session-actions[open]").forEach(d => d.open = false);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [actionBusy, historyDeleteBusy]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => { document.documentElement.style.setProperty("--panel-height", `${viewport?.height || window.innerHeight}px`); };
    resize(); viewport?.addEventListener("resize", resize); window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [inboxOpen, setInboxOpen] = useState(false);
  const inbox = useInbox(sessions, selected, (id) => {
    const target = sessions.find((x) => x.id === id);
    if (target) { setInboxOpen(false); openSession(target); }
  });
  const inboxNow = useCountdown(inbox.events);
  const [startText, setStartText] = useState(() => stored("panel-start-draft", "", true));
  useEffect(() => { remember("panel-start-draft", startText, true); }, [startText]);
  const [startPick, setStartPick] = useState<{ agent: string; kind: "terminal" | "structured"; project: string }>(() => {
    let saved: Record<string, unknown> = {};
    try { const value = JSON.parse(stored("panel-start", "{}")); if (value && typeof value === "object" && !Array.isArray(value)) saved = value; } catch {}
    return {
      agent: typeof saved.agent === "string" ? saved.agent : "codex",
      kind: saved.kind === "terminal" ? "terminal" : "structured",
      project: typeof saved.project === "string" ? saved.project : "general",
    };
  });
  const [startError, setStartError] = useState<UiError>("");
  const startPending = useRef("");
  // Oturum başlığındaki iki yuva: görünüm (sohbet/terminal) durumunu ve
  // araçlarını buraya taşır (portal); durumları kendi bileşeninde kalır.
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  // Başlık kendi genişliğine göre iki satıra geçer: sabit kenar çubuğu açıkken
  // orta boy ekranda da araçlar sığmazsa (eşik araçların en geniş haline göre).
  const [headingEl, setHeadingEl] = useState<HTMLElement | null>(null);
  const [headCompact, setHeadCompact] = useState(false);
  useEffect(() => {
    if (!headingEl) return;
    const observer = new ResizeObserver(([entry]) => setHeadCompact(entry.contentRect.width < 920));
    observer.observe(headingEl);
    return () => observer.disconnect();
  }, [headingEl]);
  // Kenar çubuğu bölümleri: bekleyen onay/soru ve okunmamış hata "Dikkat"e taşır.
  const sideWaits = useMemo<SidebarWait[]>(() => inbox.events
    .filter((e) => isPending(e) || (e.type === "error" && isUnread(e, inbox.state)))
    .map((e) => ({ sessionId: e.sessionId, type: e.type as SidebarWait["type"], expiresAt: e.expiresAt })), [inbox.events, inbox.state]);
  const sideGroups = groupSidebar(sessions, sideWaits, new Date(), query);
  function sideRow(s: Session, section: "attention" | "pinned" | "open" | "today") {
    const wait = sideWaits.filter((w) => w.sessionId === s.id).sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity))[0];
    const left = wait ? remainingLabel(wait.expiresAt, inboxNow) : null;
    const waitLabel = left && wait?.expiresAt && Date.parse(wait.expiresAt) <= inboxNow ? t("main.expired") : left;
    const unread = inbox.marker(s.id) === "unread";
    const where = s.projectId === "general" ? "Ubuntu" : projects.find((p) => p.id === s.projectId)?.name;
    return (
      <button key={s.id} className={`sidebar-session agent-${s.agentId}${selected === s.id ? " active" : ""}${unread ? " unread" : ""}`} onClick={() => openSession(s)} title={`${s.title} · ${s.kind === "structured" ? t("main.chat") : t("main.terminal")}`}>
        <span className={`side-tab ${s.agentId}`} aria-hidden="true"/>
        <span className="side-main">{s.title}<small>{agents.find((a) => a.id === s.agentId)?.name} · {where}</small></span>
        <span className="side-meta">
          {wait ? <><span className="wait-note">{wait.type === "approval" ? t("main.approvalPending") : wait.type === "question" ? t("main.questionPending") : t("main.error")}</span>{waitLabel && <small>{waitLabel}</small>}</>
            : section === "today" || s.status !== "running" ? <span>{s.status === "unavailable" ? t("main.offline") : t("main.done")}</span>
            : <span className="side-age">{isWorking(s) && <span className="side-pulse" aria-label={t("main.working")}/>}{shortAge(s.createdAt, Date.now())}</span>}
          {unread && <span className="side-unread"><span className="sr-only">{t("main.newActivity")}</span></span>}
        </span>
      </button>
    );
  }
  function openSession(s: Session) {
    setSelected(s.id); setMobileSession(true); setView("sessions"); setDrawerOpen(false);
    if (location.hash !== `#session=${s.id}`) window.history.pushState({panelSession:s.id}, "", `#session=${s.id}`);
    // A stale card (a session deleted in another tab) fails here; refresh so
    // the list corrects itself instead of leaving a dead selection behind.
    api(`/sessions/${s.id}`, "PATCH", {opened:true}).then(refresh).catch(e => { setError(e); refresh(); });
  }
  function closeView() {
    setSelected(null); setMobileSession(false); setDrawerOpen(false);
    window.history.replaceState(null, "", location.pathname + location.search);
  }
  async function changeHidden(keys: string[], hidden: boolean) {
    try {
      setError("");
      setPrefs(await api<HistoryPrefs>("/history-prefs/hidden", "POST", {keys, hidden}));
      setHistorySelection(v => v.filter(k => !keys.includes(k)));
    } catch (e) { setError(e as AuthFailure); }
  }
  // Permanent: the server removes each record from the agent's own store.
  // Records that could not be deleted stay in the dialog with the reason.
  async function performHistoryDelete() {
    if (!historyDelete || historyDeleteBusy) return;
    setHistoryDeleteBusy(true); setHistoryDeleteError("");
    try {
      const out = await api<{results: {key: string; ok: boolean; error?: string}[]; prefs: HistoryPrefs}>(
        "/history/delete", "POST", {items: historyDelete.map(s => ({agentId: s.agentId, id: s.id}))});
      const done = new Set(out.results.filter(r => r.ok).map(r => r.key));
      const failed = out.results.filter(r => !r.ok);
      setPast(v => v.filter(s => !done.has(historyKey(s))));
      setPrefs(out.prefs);
      setHistorySelection(v => v.filter(k => !done.has(k)));
      if (failed.length === 0) setHistoryDelete(null);
      else {
        setHistoryDelete(historyDelete.filter(s => !done.has(historyKey(s))));
        setHistoryDeleteError(failed.map(f => f.error || { key: "main.deleteFailed" }));
      }
    } catch (e) { setHistoryDeleteError(e as AuthFailure); }
    finally { setHistoryDeleteBusy(false); }
  }
  async function saveTitle(key: string, title: string) {
    try {
      setError("");
      setPrefs(await api<HistoryPrefs>("/history-prefs/title", "POST", {key, title}));
      setRenaming(null);
    } catch (e) { setError(e as AuthFailure); }
  }
  function chooseAction(kind: "rename" | "stop" | "delete", s: Session) {
    document.querySelectorAll<HTMLDetailsElement>(".session-actions[open]").forEach(d => d.open = false);
    setError(""); setRenameTitle(s.title); setAction({kind, session:s});
  }
  async function updateSession(s: Session, changes: {archived?: boolean; pinned?: boolean}) {
    try {
      setError(""); await api(`/sessions/${s.id}`, "PATCH", changes);
      if (changes.archived !== undefined) { setUndoArchive({id:s.id, archived:!!s.archived}); if (changes.archived && selected === s.id) closeView(); }
      document.querySelectorAll<HTMLDetailsElement>(".session-actions[open]").forEach(d => d.open = false);
      await refresh();
    } catch (e) { setError(e as AuthFailure); }
  }
  const session = sessions.find((s) => s.id === selected),
    project = projects.find((p) => p.id === session?.projectId),
    agent = agents.find((a) => a.id === session?.agentId);
  const filtered = sessions.filter(s =>
    (statusFilter === "archived" ? s.archived : !s.archived) &&
    (statusFilter === "attention" ? inbox.events.some(e => e.sessionId === s.id && isPending(e)) : statusFilter === "all" || statusFilter === "archived" || (statusFilter === "running" ? s.status === "running" : s.status !== "running")) &&
    (projectId === "all" || s.projectId === projectId) &&
    `${s.title} ${s.agentId} ${projects.find(p => p.id === s.projectId)?.name || ""}`.toLocaleLowerCase(getLocale()).includes(query.toLocaleLowerCase(getLocale()))
  ).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || Date.parse(b.lastOpenedAt || b.createdAt)-Date.parse(a.lastOpenedAt || a.createdAt));
  const hiddenHistory = prefs.hidden,
    hiddenShown = past.filter(s => prefs.hidden.includes(historyKey(s))).length;
  // Normal view hides gizlenenler; the hidden view lists only them, for restoring.
  const history = past.filter(s => hiddenHistory.includes(historyKey(s)) === showHidden &&
    (projectId === "all" || s.projectId === projectId) && (prefs.titles[historyKey(s)] || s.title).toLocaleLowerCase(getLocale()).includes(query.toLocaleLowerCase(getLocale())));
  const busyProject = sessions.some(
    (s) => s.projectId === newProject && s.status === "running",
  );
  // Which agents offer the structured chat tier on this server.
  const chatReady = (agent: string) =>
    agent === "hermes"
      ? structuredAvailable
      : agent === "codex"
        ? structuredCodexAvailable
        : agent === "claude"
          ? structuredClaudeAvailable
          : false;
  function openNew(agentChoice?: string, kind?: "terminal" | "structured") {
    const agent = agentChoice || "codex";
    startPending.current = "";
    setNewAgent(agent);
    setNewKind(kind === "structured" && chatReady(agent) ? "structured" : "terminal");
    setNewProject(
      agentChoice || projectId === "all" || hiddenProjects.includes(projectId) ? "general" : projectId,
    );
    setParallel(false);
    setTitle("");
    setError("");
    setModal(true);
  }
  // Yeni oturum (pencere ve başlangıç kutusu ortak). İlk mesaj varsa oturumun
  // taslağına yazılır; sohbet oturumunda hazır olunca kendiliğinden gönderilir,
  // terminalde mesaj kutusunda bekler (araç açılırken yazılmasın).
  const pendingCreation = useRef<{ signature: string; requestId: string } | null>(null);
  async function createSession(opts: { projectId: string; agentId: string; kind: "terminal" | "structured"; title: string; allowParallel: boolean; firstMessage?: string }, fail: (error: UiError) => void = setError) {
    setCreating(true);
    fail("");
    pendingCreation.current = creationAttempt(pendingCreation.current, opts);
    let s: Session;
    try {
      s = await api<Session>("/sessions", "POST", {
        projectId: opts.projectId,
        agentId: opts.agentId,
        title: opts.title,
        allowParallel: opts.allowParallel,
        requestId: pendingCreation.current.requestId,
        ...(opts.kind === "structured" ? { kind: "structured" } : {}),
      });
    } catch (e) {
      fail(e as AuthFailure);
      setCreating(false);
      return false;
    }
    pendingCreation.current = null;
    // Oturum açıldı: buradan sonra hata olsa da tekrar denemek ikinci oturum açardı.
    if (opts.firstMessage) {
      remember(`panel-draft-${s.id}`, opts.firstMessage, true);
      if (opts.kind === "structured") remember(`panel-autosend-${s.id}`, opts.firstMessage, true);
    }
    try { await refresh(); } catch {}
    openSession(s);
    closeModal();
    setCreating(false);
    return true;
  }
  // Pencere hangi yoldan kapanırsa kapansın bekleyen başlangıç metni taşınmaz.
  function closeModal() { startPending.current = ""; setModal(false); }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const firstMessage = startPending.current;
    if (await createSession({ projectId: newProject, agentId: newAgent, kind: newKind, title, allowParallel: parallel, firstMessage })) {
      startPending.current = "";
      if (firstMessage) setStartText((current) => clearSubmitted(current, firstMessage));
    }
  }
  // Başlangıç kutusu: "Ne yapalım?" Ajan, tür ve proje seçimi hatırlanır; kayıtlı
  // ajan yoksa ya da kullanılamıyorsa ilk hazır ajan seçilir.
  const startAgent = agents.find((a) => a.id === startPick.agent && a.available) ?? agents.find((a) => a.available);
  const startKind: "terminal" | "structured" = startPick.kind === "structured" && startAgent && chatReady(startAgent.id) ? "structured" : "terminal";
  const startProject = pickable.some((p) => p.id === startPick.project) ? startPick.project : "general";
  function openStartOptions() {
    if (!startAgent || creating) return;
    setNewAgent(startAgent.id); setNewKind(startKind); setNewProject(startProject);
    setTitle(startTitle(startText)); setParallel(false); setError("");
    startPending.current = startText; setModal(true);
  }
  function pickStart(change: Partial<typeof startPick>) {
    const next = { ...startPick, ...change };
    setStartPick(next);
    remember("panel-start", JSON.stringify(next));
  }
  async function startFromBox(e: React.FormEvent) {
    e.preventDefault();
    if (creating || !startAgent) return;
    const submittedText = startText;
    const text = submittedText.trim();
    // Sunucu adda kontrol karakteri kabul etmez (sekme dahil); emoji ortadan bölünmez.
    const firstLine = startTitle(text);
    const busy = startKind === "terminal" && sessions.some((s) => s.projectId === startProject && s.status === "running");
    if (busy) {
      // Aynı projede açık oturum var: paralel çalışma onayı pencerede verilir.
      setNewAgent(startAgent.id); setNewKind(startKind); setNewProject(startProject);
      setTitle(firstLine); setParallel(false); setError(""); startPending.current = submittedText; setModal(true);
      return;
    }
    if (await createSession({ projectId: startProject, agentId: startAgent.id, kind: startKind, title: firstLine, allowParallel: false, firstMessage: text }, setStartError))
      setStartText((current) => clearSubmitted(current, submittedText));
  }
  async function performAction(e?: React.FormEvent) {
    e?.preventDefault(); if (!action || actionBusy) return;
    setActionBusy(true); setError("");
    try {
      const id = action.session.id;
      if (action.kind === "rename") await api(`/sessions/${id}`, "PATCH", {title:renameTitle});
      if (action.kind === "stop") await api(`/sessions/${id}/stop`, "POST", {});
      if (action.kind === "delete") {
        await api(`/sessions/${id}`, "DELETE"); remember(`panel-draft-${id}`, "", true); remember(`panel-autosend-${id}`, "", true);
        // Drop it from the list immediately: the overview must never briefly
        // show (or let the user click) a session that no longer exists while
        // the refresh and the live patch are still in flight.
        liveList.current = { ...liveList.current, items: liveList.current.items.filter((s) => s.id !== id) };
        setSessions(liveList.current.items);
        if (selected === id) closeView();
      }
      setAction(null); await refresh();
    } catch (e) { setError(e as AuthFailure); }
    finally { setActionBusy(false); }
  }
  if (!ready)
    return (
      <div className="boot">
        <Logo />
      </div>
    );
  if (authError || !authConfig) return <main className="login-page"><p role="alert">{t("auth.unavailable")}</p><button onClick={() => window.location.reload()}>{t("auth.retry")}</button></main>;
  if (!user) return <Login config={authConfig} submit={(username, password) => api<LoginGrant>("/login", "POST", { username, password })}
    onLogin={(grant) => { csrf = grant.csrf; setUser(grant.username); }} />;
  return (
    <div
      className={`app ${session && view === "sessions" ? `session-open agent-${session.agentId}` : "overview"} ${mobileSession || view === "runs" || view === "yak" ? "show-session" : ""} ${view === "runs" || view === "yak" ? "runs-view" : ""} ${drawerOpen ? "sessions-visible" : ""} ${listPinned ? "list-pinned" : ""}`}
    >
      <aside className="sidebar">
        <div className="brand-row">
          <a className="brand" href="/" aria-label="Agent Panel">
            <Logo />
            <span>agent<span className="brand-muted">panel</span></span>
          </a>
          <button type="button" className="inbox-bell icon-button" onClick={() => setInboxOpen(true)} aria-label={t("main.attention") + (inbox.unread > 0 ? t("main.unreadSuffix", { count: inbox.unread }) : "")} title={t("main.attention")}>
            <Bell size={17} />
            {inbox.unread > 0 && <span className="count attention-count" aria-hidden="true">{inbox.unread}</span>}
          </button>
        </div>
        <label className="sidebar-search"><Search size={15}/><input aria-label={t("main.searchChats")} placeholder={t("main.search")} value={query} onChange={e => setQuery(e.target.value)}/><kbd className="kbd-hint">Ctrl K</kbd></label>
        <button className="sidebar-create" onClick={() => openNew()}><Plus size={17}/>{t("main.newChat")}</button>
        <div className="sidebar-conversations">
          {sideGroups.attention.length > 0 && <div className="side-section attention" role="group" aria-labelledby="side-attention">
            <button type="button" className="side-head" id="side-attention" onClick={() => setInboxOpen(true)} title={t("main.openAttention")}>{t("main.attentionHeading")}<span className="side-count" aria-label={t("main.sessionCount", { count: sideGroups.attention.length })}>{sideGroups.attention.length}</span></button>
            {sideGroups.attention.map(s => sideRow(s, "attention"))}
          </div>}
          {([["pinned", t("main.pinned")], ["open", t("main.open")], ["today", t("main.today")]] as const).map(([key, label]) => sideGroups[key].length > 0 && <div className="side-section" role="group" aria-labelledby={`side-${key}`} key={key}>
            <span className="side-head" id={`side-${key}`}>{label}</span>
            {sideGroups[key].map(s => sideRow(s, key))}
          </div>)}
          {sideGroups.attention.length + sideGroups.pinned.length + sideGroups.open.length + sideGroups.today.length === 0 && <p className="side-empty">{query ? t("main.noMatches") : t("main.noOpenSessions")}</p>}
          {sideGroups.older > 0 && <button type="button" className="side-more" onClick={() => { setView("sessions"); setProjectId("all"); setStatusFilter("ended"); closeView(); }}>{t("main.olderSessions", { count: sideGroups.older })}<ChevronRight size={14}/></button>}
        </div>
        <nav className="nav-group side-nav" aria-label={t("main.pages")}>
          <button
            aria-current={view === "sessions" && projectId === "all" ? "page" : undefined}
            className={
              view === "sessions" && projectId === "all"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() => {
              setView("sessions");
              setProjectId("all");
              closeView();
            }}
          >
            <Layers3 size={17} />
            {t("main.chats")}
            {sessions.filter((s) => s.status === "running").length > 0 && (
              <span className="count">
                {sessions.filter((s) => s.status === "running").length}
              </span>
            )}
          </button>
          <button
            aria-current={view === "history" ? "page" : undefined}
            className={view === "history" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setView("history");
              closeView();
            }}
          >
            <History size={17} />
            {t("main.history")}
          </button>
          <button
            aria-current={view === "runs" ? "page" : undefined}
            className={view === "runs" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setView("runs");
              closeView();
            }}
          >
            <CalendarClock size={17} />
            {t("main.scheduledRuns")}
          </button>
          {kotaYakiciAvailable && <button
            aria-current={view === "yak" ? "page" : undefined}
            className={view === "yak" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setView("yak");
              closeView();
            }}
          >
            <Flame size={17} />
            {t(optionalKey("main.quotaBurner"))}
            <React.Suspense fallback={null}><YakNavDurum api={api} /></React.Suspense>
          </button>}
          <details className="sidebar-projects"><summary className="nav-item"><Folder size={17}/>{t("main.workspaces")}<ChevronDown size={14}/></summary>{pickable.map(p => <button key={p.id} className="nav-item" onClick={() => {setProjectId(p.id); closeView(); setView("sessions");}}><ProjectIcon id={p.id} size={15}/>{p.name}</button>)}</details>
        </nav>
        <div className="sidebar-bottom">
          <UsagePanel />
          <LanguageSelect />
          <div className="sidebar-foot">
            {homeUrl && <a className="home-link" href={homeUrl} title={t("main.backHome")}>
              <ArrowLeft size={16} />
              <span>{t("main.home")}</span>
            </a>}
            <ThemeSwitch />
            <button
              className="logout icon-button"
              aria-label={t("main.logout")}
              title={t("main.logout")}
              onClick={async () => {
                await api("/logout", "POST", {});
                unauthorized();
              }}
            >
              <LogOut size={16} />
            </button>
            {panelVersion && <span className="version">v{panelVersion}</span>}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{t("main.workspace")}</span>
            <ChevronRight size={14} />
            <strong>
              {view === "history"
                ? t("main.history")
                : view === "runs"
                  ? t("main.scheduledRuns")
                  : view === "yak"
                    ? t(optionalKey("main.quotaBurner"))
                    : projectId === "all"
                    ? t("main.chats")
                    : projects.find((p) => p.id === projectId)?.name}
            </strong>
          </div>
          <span className="top-status">
            <ShieldCheck size={14} /> {t("main.privateAccess")}
          </span>
          <span className="mobile-brand">
            <Logo /> <span>agent<span className="brand-muted">panel</span></span>
          </span>
          <button type="button" className="inbox-bell mobile-inbox icon-button" onClick={() => setInboxOpen(true)} aria-label={t("main.attentionCounts", { pending: inbox.events.filter(isPending).length, unread: inbox.unread })}>
            <Bell size={18}/>{(inbox.events.filter(isPending).length || inbox.unread) > 0 && <span className="count attention-count" aria-hidden="true">{inbox.events.filter(isPending).length || inbox.unread}</span>}
          </button>
          {homeUrl && <a className="mobile-home icon-button" href={homeUrl} aria-label={t("main.home")} title={t("main.home")}>
            <House size={16} />
          </a>}
          <button
            className="mobile-logout icon-button"
            aria-label={t("main.logout")}
            onClick={async () => {
              await api("/logout", "POST", {});
              unauthorized();
            }}
          >
            <LogOut size={16} />
          </button>
        </header>
        {!session && view === "sessions" && <section className="overview-intro">
          <div className="intro-text"><span className="intro-date">{new Date().toLocaleDateString(getLocale(), { weekday: "long", day: "numeric", month: "long" })}</span><h1>{(h => h < 6 ? t("main.goodNight") : h < 12 ? t("main.goodMorning") : h < 18 ? t("main.goodDay") : t("main.goodEvening"))(new Date().getHours())}, {user}</h1><p>{sessions.filter(s => s.status === "running" && !s.archived).length > 0 ? t("main.openSessionsHint", { count: sessions.filter(s => s.status === "running" && !s.archived).length }) : t("main.startEmpty")}</p></div>
          <form className="start-box" aria-label={t("main.startTask")} aria-busy={creating || undefined} onSubmit={startFromBox}>
            <textarea rows={2} maxLength={8000} aria-label={t("main.whatNext")} placeholder={startKind === "structured" ? t("main.chatPlaceholder") : t("main.terminalPlaceholder")}
              value={startText} onChange={(e) => { setStartText(e.target.value); setStartError(""); }}
              onKeyDown={(e) => {
                // Enter yalnız metin varken başlatır (yanlışlıkla boş oturum açılmasın); Shift+Enter yeni satır.
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                if (startText.trim()) e.currentTarget.form?.requestSubmit();
              }} />
            {startError && <div role="alert" className="error start-error">{errorText(startError)}</div>}
            <div className="start-bar">
              <div className="start-agents" role="radiogroup" aria-label={t("main.agent")}
                onKeyDown={(e) => radioKeys(e, agents.filter((a) => a.available).map((a) => a.id), startAgent?.id ?? "", (id) => pickStart({ agent: id }))}>
                {agents.map((a) => <button type="button" role="radio" key={a.id} data-id={a.id} aria-checked={startAgent?.id === a.id} aria-label={a.name} disabled={!a.available}
                  tabIndex={startAgent?.id === a.id ? 0 : -1}
                  className={startAgent?.id === a.id ? "chosen" : ""} title={a.available ? a.name : t("main.agentSetup", { name: a.name })} onClick={() => pickStart({ agent: a.id })}>
                  <AgentMark id={a.id} small />{a.name}</button>)}
              </div>
              {startAgent && chatReady(startAgent.id) && <div className="start-kind" role="radiogroup" aria-label={t("main.startKind")}
                onKeyDown={(e) => radioKeys(e, ["structured", "terminal"], startKind, (id) => pickStart({ kind: id as "terminal" | "structured" }))}>
                {([["structured", t("main.chat"), <Sparkles size={13} key="s" />], ["terminal", t("main.terminal"), <TerminalSquare size={13} key="t" />]] as const).map(([id, label, icon]) =>
                  <button type="button" role="radio" key={id} data-id={id} aria-checked={startKind === id} tabIndex={startKind === id ? 0 : -1}
                    className={startKind === id ? "chosen" : ""} onClick={() => pickStart({ kind: id })}>{icon}{label}</button>)}
              </div>}
              <label className="start-project"><Folder size={13} aria-hidden="true" />
                <select aria-label={t("main.project")} value={startProject} onChange={(e) => pickStart({ project: e.target.value })}>
                  {pickable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <button type="button" className="link-btn start-more" disabled={creating || !startAgent} onClick={openStartOptions}>{t("main.moreOptions")}</button>
              <button type="submit" className="start-go" disabled={creating || !startAgent}>
                {creating ? <LoaderCircle size={15} className="chat-spinning" /> : <ArrowUp size={15} />}{t("main.start")}
              </button>
            </div>
            {!startAgent && <p className="start-note" role="status">{t("main.noAgents")}</p>}
          </form>
        </section>}
        {undoArchive && <div className="undo-banner" role="status">{t("main.archiveChanged")}
          <button onClick={async () => {try {await api(`/sessions/${undoArchive.id}`, "PATCH", {archived:undoArchive.archived}); setUndoArchive(null); await refresh();} catch(e) {setError(e as AuthFailure);}}}>{t("main.undo")}</button>
          <button aria-label={t("main.dismiss")} onClick={() => setUndoArchive(null)}><X size={16}/></button>
        </div>}
        {session && error && !action && !modal && <div role="alert" className="error workspace-error">{errorText(error)}</div>}
        <div className="workspace">
          {session && drawerOpen && narrow && <button tabIndex={-1} className="drawer-backdrop" aria-label={t("main.closeSessionList")} onClick={() => setDrawerOpen(false)}/> }
          <section className="session-list" aria-label={t("main.sessionList")} role={session && drawerOpen && narrow ? "dialog" : undefined} aria-modal={session && drawerOpen && narrow ? true : undefined}>
            {session && <div className="drawer-heading"><strong>{t("main.switchSession")}</strong><button onClick={() => setListPinned(v => !v)}>{listPinned ? t("main.unpin") : t("main.pinList")}</button><button data-dialog-close aria-label={t("main.closeSessionList")} onClick={() => setDrawerOpen(false)}><X size={18}/></button></div>}
            <div className="list-heading">
              <div>
                <h1>
                  {view === "history"
                    ? t("main.history")
                    : view === "runs"
                      ? t("main.scheduledRuns")
                      : t("main.yourChats")}
                  <span className="number">
                    {view === "history" ? history.length : filtered.length}
                  </span>
                </h1>
              </div>
            </div>
            <p className="list-subtitle">
              {view === "history"
                ? t("main.historySubtitle")
                : view === "runs"
                  ? t("main.runsSubtitle")
                  : t("main.sessionsSubtitle")}
            </p>
            <label className="search">
              <Search size={16} />
              <input
                data-dialog-initial placeholder={t("main.searchChatsPlaceholder")}
                aria-label={t("main.searchSessions")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="mobile-view-tabs">
              <button
                aria-current={view === "sessions" ? "page" : undefined}
                className={view === "sessions" ? "chosen" : ""}
                onClick={() => setView("sessions")}
              >
                <Layers3 size={14} />
                {t("main.chats")}
              </button>
              <button
                aria-current={view === "history" ? "page" : undefined}
                className={view === "history" ? "chosen" : ""}
                onClick={() => setView("history")}
              >
                <History size={14} />
                {t("main.historyShort")}
              </button>
              <button
                aria-current={view === "runs" ? "page" : undefined}
                className={view === "runs" ? "chosen" : ""}
                onClick={() => {
                  setView("runs");
                  closeView();
                }}
              >
                <CalendarClock size={14} />
                {t("main.runs")}
              </button>
              {kotaYakiciAvailable && <button
                aria-current={view === "yak" ? "page" : undefined}
                className={view === "yak" ? "chosen" : ""}
                onClick={() => {
                  setView("yak");
                  closeView();
                }}
              >
                <Flame size={14} />
                {t(optionalKey("main.quota"))}
              </button>}
            </div>
            <UsagePanel mobile />
            <div className="filter-bar">
            <ProjectChips projects={pickable} value={projectId} onChange={setProjectId} />
            {view === "sessions" && <div className="session-filters" aria-label={t("main.sessionStatus")}>
              {[["all",t("main.all")],["attention",t("main.attention")],["running",t("main.open")],["ended",t("main.ended")],["archived",t("main.archiveFilter")]].map(([id,label]) => <button key={id} aria-pressed={statusFilter === id} className={statusFilter === id ? "chosen" : ""} onClick={() => setStatusFilter(id)}>{label}</button>)}
            </div>}
            </div>
            {view === "history" && (showHidden || hiddenShown > 0) && <button className="text-button" onClick={() => { setShowHidden(v => !v); setHistorySelection([]); }}>{showHidden ? t("main.normalList") : t("main.showHidden", { count: hiddenShown })}</button>}
            {error && !modal && !action && (
              <div role="alert" className="error">
                {errorText(error)}
              </div>
            )}
            <div className="list-section-label">
              {view === "history" ? t("main.savedChats") : t("main.workSessions")}
              <span>
                {view === "history" ? t("main.readOnly") : t("main.tmuxPersistent")}
              </span>
            </div>
            {view === "history" && (
              <div className="bulk-bar" role="toolbar" aria-label={t("main.bulkActions")}>
                <button className="text-button" disabled={!history.length} onClick={() => setHistorySelection(history.map(historyKey))}>{t("main.selectVisible")}</button>
                {historySelection.length > 0 && <>
                  <span>{t("main.selectedRecords", { count: historySelection.length })}</span>
                  <button className="text-button" onClick={() => changeHidden(historySelection, !showHidden)}>{showHidden ? t("main.restoreSelected") : t("main.hideSelected")}</button>
                  <button className="text-button history-delete" onClick={() => { setHistoryDeleteError(""); setHistoryDelete(past.filter(s => historySelection.includes(historyKey(s)))); }}>{t("main.deleteSelected")}</button>
                  <button className="text-button" onClick={() => setHistorySelection([])}>{t("main.clearSelection")}</button>
                </>}
              </div>
            )}
            <div className="cards">
              {view === "history"
                ? history.map((s) => {
                    const key = historyKey(s);
                    const picked = historySelection.includes(key);
                    const shown = prefs.titles[key] || s.title;
                    return (
                    <article className={`history-card ${picked ? "picked" : ""}`} key={key}>
                      <input type="checkbox" className="history-pick" aria-label={t("main.selectTitle", { title: shown })} checked={picked}
                        onChange={() => setHistorySelection(v => picked ? v.filter(k => k !== key) : [...v, key])}/>
                      <AgentMark id={s.agentId} small />
                      <div>
                        {renaming?.key === key ? (
                          <form className="history-rename" onSubmit={e => { e.preventDefault(); saveTitle(key, renaming.title); }}>
                            <input autoFocus maxLength={80} aria-label={t("main.newName")} placeholder={t("main.originalNameHint")} value={renaming.title} onChange={e => setRenaming({key, title: e.target.value})}/>
                            <button className="text-button" type="submit">{t("main.save")}</button>
                            <button className="text-button" type="button" onClick={() => setRenaming(null)}>{t("main.cancel")}</button>
                          </form>
                        ) : <strong title={shown}>{shown}</strong>}
                        <small>
                          {projects.find((p) => p.id === s.projectId)?.name} ·{" "}
                          {s.source} · {age(s.updatedAt)} · <code title={s.id}>{s.id}</code>
                        </small>
                      </div>
                        <div className="history-actions">
                          <button className="text-button" onClick={() => setRenaming({key, title: prefs.titles[key] || s.title})}>{t("main.rename")}</button>
                          <button className="text-button" onClick={() => changeHidden([key], !showHidden)}>{showHidden ? t("main.undo") : t("main.hideInPanel")}</button>
                          <button className="text-button history-delete" onClick={() => { setHistoryDeleteError(""); setHistoryDelete([s]); }}>{t("main.delete")}</button>
                        </div>
                    </article>
                    );
                  })
                : filtered.map((s) => (
                    <article
                      className={`session-card agent-${s.agentId} ${s.status !== "running" ? "is-ended" : ""} ${selected === s.id ? "selected" : ""}`}
                      key={s.id}
                    >
                      <div className="card-top">
                        <span className="card-agent">
                          <AgentMark id={s.agentId} small />
                          <span className="agent-name">
                            {agents.find((a) => a.id === s.agentId)?.name}
                          </span>
                          {s.kind === "structured" && (
                            <span className="kind-chip">{t("main.chatLower")}</span>
                          )}
                        </span>
                        <SessionActions session={s} onAction={chooseAction} onUpdate={updateSession}/>
                        <span className={`session-status ${s.status}`}>
                          <span className={`lamp ${s.agentId} ${s.status === "running" ? "on" : ""}`} aria-hidden="true" />
                          {inbox.events.some(e => e.sessionId === s.id && isPending(e) && e.type === "question") ? t("main.questionPending") : inbox.events.some(e => e.sessionId === s.id && isPending(e)) ? t("main.approvalPending") : s.status === "running"
                            ? t("main.open")
                            : s.status === "ended"
                              ? t("main.ended")
                              : t("main.offline")}
                        </span>
                      </div>
                      <button className="session-card-open" onClick={() => openSession(s)}><h3>{s.pinned && <span className="pin-mark" title={t("main.pinnedBadge")}><Pin size={13} aria-hidden="true"/></span>}{s.title}</h3></button>
                      <p className="card-context">
                        {s.projectId === "general"
                          ? "Ubuntu · ~"
                          : projects.find((p) => p.id === s.projectId)
                              ?.description}
                      </p>
                      <div className="card-bottom">
                        <span>
                          <ProjectIcon id={s.projectId} size={13} />
                          {projects.find((p) => p.id === s.projectId)?.name}
                        </span>
                        <time>{age(s.createdAt)}</time>
                      </div>
                      <button className="card-connect" onClick={() => openSession(s)}>
                        <span>
                          {s.kind === "structured"
                            ? s.status === "running"
                              ? t("main.returnChat")
                              : t("main.viewChat")
                            : s.status === "running"
                              ? t("main.connectSession")
                              : t("main.viewOutput")}
                        </span>
                        <ArrowRight size={15} />
                      </button>
                    </article>
                  ))}
              {(view === "history" ? history : filtered).length === 0 && (
                <div className="list-empty">
                  <span className="empty-icon">
                    <Folder size={25} />
                  </span>
                  <h3>
                    {query
                      ? t("main.noMatchingSession")
                      : view === "history"
                        ? t("main.noSavedChats")
                        : t("main.firstSession")}
                  </h3>
                  <p>
                    {view === "history"
                      ? t("main.historyEmptyHint")
                      : t("main.sessionEmptyHint")}
                  </p>
                  {view !== "history" && !query && (
                    <button className="text-button" onClick={() => openNew()}>
                      {t("main.startChat")} <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="list-bottom">
              <LockKeyhole size={13} />
              {view === "history"
                ? t("main.historyFooter")
                : t("main.sessionFooter")}
              {view === "sessions" && <label className="restore-option"><input type="checkbox" checked={restoreLast} onChange={e => setRestoreLast(e.target.checked)}/> {t("main.restoreLast")}</label>}
            </div>
          </section>
          <section className="session-detail">
            <React.Suspense fallback={<div role="status">{t("main.loadingView")}</div>}>
            {session && view === "sessions" ? (
              <>
                <header className={`detail-heading${headCompact ? " compact" : ""}`} ref={setHeadingEl}>
                  <button
                    className="back-button"
                    aria-label={t("main.backToList")}
                    onClick={closeView}
                  >
                    <ArrowLeft size={19} />
                  </button>
                  <AgentMark id={session.agentId} small />
                  <div className="heading-title">
                    <h2>{session.title}</h2>
                    <div className="heading-meta">
                      <span className="heading-kind">
                        {session.kind === "structured"
                          ? session.status === "running"
                            ? t("main.chat")
                            : t("main.chatRecord")
                          : session.status === "running"
                            ? t("main.terminal")
                            : t("main.lastOutput")}
                      </span>
                      <span className={`heading-agent agent-${session.agentId}`}>{agent?.name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="heading-project">{project?.name}</span>
                      <span className="heading-status" ref={setStatusSlot} />
                    </div>
                  </div>
                  <div className="heading-tools" ref={setToolsSlot} />
                  <button type="button" className="inbox-bell mobile-inbox icon-button" onClick={() => setInboxOpen(true)} aria-label={t("main.attentionCounts", { pending: inbox.events.filter(isPending).length, unread: inbox.unread })}>
            <Bell size={18}/>{(inbox.events.filter(isPending).length || inbox.unread) > 0 && <span className="count attention-count" aria-hidden="true">{inbox.events.filter(isPending).length || inbox.unread}</span>}
          </button>
                  <button className="session-switcher" aria-label={t("main.sessions")} title={t("main.sessions")} aria-expanded={drawerOpen || listPinned} onClick={() => {if (window.innerWidth > 800) setListPinned(v => !v); else setDrawerOpen(v => !v);}}><Layers3 size={16}/><span>{t("main.sessions")}</span>{inbox.events.some(e => e.sessionId !== selected && (isPending(e) || !inbox.state.seen.includes(e.id))) && <span className="switcher-dot" aria-label={t("main.sessionNeedsAttention")}/>}</button>
                  <button className="heading-new icon-button" aria-label={t("main.newSessionLegacy")} title={t("main.newSession")} onClick={() => openNew()}><Plus size={18}/></button>
                  <SessionActions session={session} onAction={chooseAction} onUpdate={updateSession} onLogout={async () => {await api("/logout", "POST", {}); unauthorized();}}
                    info={<>
                      <span title={project?.displayPath}><Folder size={13} />{project?.displayPath}</span>
                      <span><Radio size={12} />{session.kind === "structured" ? CHAT_TIER[session.agentId]?.footer ?? "Hermes ACP" : "tmux"}</span>
                    </>}/>
                </header>
                {session.kind === "structured" ? (
                  <StructuredView
                    key={session.id}
                    session={session}
                    onUnauthorized={unauthorized}
                    request={api}
                    slots={{ status: statusSlot, tools: toolsSlot }}
                  />
                ) : (
                  <TerminalView
                    key={session.id}
                    session={session}
                    onUnauthorized={unauthorized}
                    request={api}
                    slots={{ status: statusSlot, tools: toolsSlot }}
                  />
                )}
              </>
            ) : view === "yak" && kotaYakiciAvailable ? (
              <YakSayfasi
                api={api}
                onBack={() => {
                  setView("sessions");
                  closeView();
                }}
              />
            ) : view === "runs" ? (
              <RunsView
                request={api}
                onBack={() => {
                  setView("sessions");
                  closeView();
                }}
              />
            ) : (
              <div className="welcome">
                <span className="welcome-mark"><Layers3 size={22}/></span>
                <h2>{view === "history" ? t("main.savedChats") : t("main.readyToWork")}</h2>
                <p>{view === "history" ? t("main.externalHistory") : t("main.chooseChat")}</p>
                <button className="primary" onClick={() => openNew()}><Plus size={17}/>{t("main.newChat")}</button>
              </div>
            )}
            </React.Suspense>
          </section>
        </div>
      </main>
      {inboxOpen && <InboxDialog inbox={inbox} now={inboxNow} onOpen={(id) => { const target = sessions.find((x) => x.id === id); if (target) { setInboxOpen(false); openSession(target); } }} onClose={() => setInboxOpen(false)} />}
      {paletteOpen && (
        <Palette
          sessions={sessions.filter((x) => !x.archived).map((x) => ({ id: x.id, title: x.title, agentId: x.agentId, status: x.status, kind: x.kind, projectName: projects.find((p) => p.id === x.projectId)?.name }))}
          agentName={(id) => agents.find((a) => a.id === id)?.name ?? id}
          actions={[
            { id: "new", label: t("main.newChat"), icon: "new", run: () => openNew() },
            { id: "history", label: t("main.history"), icon: "history", run: () => { setView("history"); closeView(); } },
            { id: "runs", label: t("main.scheduledRuns"), icon: "runs", run: () => { setView("runs"); closeView(); } },
            ...(kotaYakiciAvailable ? [{ id: "yak", label: t(optionalKey("main.quotaBurner")), icon: "runs" as const, run: () => { setView("yak"); closeView(); } }] : []),
          ]}
          onOpen={(id) => { const target = sessions.find((x) => x.id === id); if (target) openSession(target); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {modal && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creating) closeModal();
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
            onSubmit={create}
          >
            <button
              type="button"
              className="modal-close icon-button"
              aria-label={t("main.close")}
              onClick={closeModal}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">{t("main.nextIdea")}</span>
            <h2 id="new-title">{t("main.newSession")}</h2>
            <p>{t("main.chooseWorkspace")}</p>
            <div className="project-pick-head">
              <label htmlFor="new-project">{t("main.startWorkspace")}</label>
              <button type="button" className="link-btn" onClick={() => setEditProjects((v) => !v)}>
                {editProjects ? t("main.done") : t("main.editList")}
              </button>
            </div>
            {editProjects ? (
              <div className="project-edit" role="group" aria-label={t("main.visibleWorkspaces")}>
                <small>{t("main.workspaceVisibility")}</small>
                {projects.map((p) => (
                  <label key={p.id} className="project-edit-row">
                    <input
                      type="checkbox"
                      disabled={p.id === "general"}
                      checked={!hiddenProjects.includes(p.id)}
                      onChange={(e) => {
                        const next = e.target.checked ? hiddenProjects.filter((x) => x !== p.id) : [...hiddenProjects, p.id];
                        saveHiddenProjects(next);
                        if (!e.target.checked && newProject === p.id) setNewProject("general");
                      }}
                    />
                    {p.name}
                  </label>
                ))}
                <div className="project-edit-actions">
                  <button type="button" className="link-btn" onClick={() => saveHiddenProjects([])}>{t("main.showAll")}</button>
                  <button type="button" className="link-btn" onClick={() => saveHiddenProjects(projects.filter((p) => p.id !== "general").map((p) => p.id))}>{t("main.hideAll")}</button>
                </div>
              </div>
            ) : (
              <select
                id="new-project"
                value={newProject}
                onChange={(e) => {
                  setNewProject(e.target.value);
                  setParallel(false);
                }}
              >
                {pickable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <div
              className={`workspace-preview ${newProject === "general" ? "general" : ""}`}
            >
              <ProjectIcon id={newProject} size={20} />
              <div>
                <strong>
                  {projects.find((p) => p.id === newProject)?.name}
                </strong>
                <p>
                  {newProject === "general"
                    ? t("main.ubuntuHint")
                    : projects.find((p) => p.id === newProject)?.description}
                </p>
              </div>
              <code>
                {projects.find((p) => p.id === newProject)?.displayPath}
              </code>
            </div>
            <label>{t("main.agentLegacy")}</label>
            <div className="agent-options" role="radiogroup" aria-label={t("main.agentLegacy")} onKeyDown={event => radioKeys(event, agents.filter(a => a.available).map(a => a.id), newAgent, id => { setNewAgent(id); if (!chatReady(id)) setNewKind("terminal"); })}>
              {agents.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  disabled={!a.available}
                  role="radio" aria-checked={newAgent === a.id} tabIndex={newAgent === a.id ? 0 : -1} data-id={a.id} aria-label={a.name}
                  className={newAgent === a.id ? "chosen" : ""}
                  onClick={() => {
                    setNewAgent(a.id);
                    if (!chatReady(a.id)) setNewKind("terminal");
                  }}
                >
                  <AgentMark id={a.id} />
                  <strong>{a.name}</strong>
                  <small>{a.available ? t("main.ready") : t("main.setupRequired")}</small>
                  {newAgent === a.id && (
                    <Check size={14} className="option-check" />
                  )}
                </button>
              ))}
            </div>
            {chatReady(newAgent) && (
              <>
                <label>{t("main.workKind")}</label>
                <div className="kind-options" role="radiogroup" aria-label={t("main.workKind")} onKeyDown={event => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "terminal" : event.key === "End" ? "structured" : newKind === "terminal" ? "structured" : "terminal";
                  setNewKind(next);
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next === "terminal" ? 0 : 1]?.focus();
                }}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={newKind === "terminal"}
                    tabIndex={newKind === "terminal" ? 0 : -1}
                    className={newKind === "terminal" ? "chosen" : ""}
                    onClick={() => setNewKind("terminal")}
                  >
                    <TerminalSquare size={15} />
                    {t("main.terminal")}
                    <small>{t("main.tmuxNote")}</small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={newKind === "structured"}
                    tabIndex={newKind === "structured" ? 0 : -1}
                    className={newKind === "structured" ? "chosen" : ""}
                    onClick={() => setNewKind("structured")}
                  >
                    <Sparkles size={15} />
                    {t("main.chat")}
                    <small>{CHAT_TIER[newAgent]?.badge ?? "beta"}</small>
                  </button>
                </div>
              </>
            )}
            <label>
              <span className="label-text">{t("main.sessionName")} <span>{t("main.optional")}</span></span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                placeholder={t("main.titlePlaceholder")}
              />
            </label>
            {busyProject && (
              <label className="parallel-warning">
                <input
                  type="checkbox"
                  checked={parallel}
                  onChange={(e) => setParallel(e.target.checked)}
                />
                <span>
                  {t("main.parallelWarning")}
                </span>
              </label>
            )}
            {error && (
              <div role="alert" className="error">
                {errorText(error)}
              </div>
            )}
            <button
              className="primary full"
              disabled={
                creating || (busyProject && !parallel)
              }
            >
              {creating ? t("main.openingSession") : t("main.startSession")}
              <ArrowRight size={17} />
            </button>
            <div className="modal-note">
              <LockKeyhole size={13} />{" "}
              {newKind === "structured" && CHAT_TIER[newAgent]
                ? CHAT_TIER[newAgent].note
                : t("main.persistentNote")}
            </div>
          </form>
        </div>
      )}
      {historyDelete && (
        <div className="modal-overlay">
          <form className="modal confirm" onSubmit={e => { e.preventDefault(); performHistoryDelete(); }} role="dialog" aria-modal="true" aria-labelledby="history-delete-title">
            <h2 id="history-delete-title">{historyDelete.length > 1 ? t("main.deleteRecords", { count: historyDelete.length }) : t("main.deleteRecord")}</h2>
            <p className="action-target">{historyDelete.length === 1 ? (prefs.titles[historyKey(historyDelete[0])] || historyDelete[0].title) : historyDelete.slice(0, 3).map(s => prefs.titles[historyKey(s)] || s.title).join(" · ") + (historyDelete.length > 3 ? ` · +${historyDelete.length - 3}` : "")}</p>
            <p>{t("main.deleteHistoryWarning")}</p>
            {historyDeleteError && <div className="error" role="alert">{errorText(historyDeleteError)}</div>}
            <div className="confirm-actions"><button type="button" className="secondary" disabled={historyDeleteBusy} onClick={() => setHistoryDelete(null)}>{t("main.cancelAction")}</button>
              <button className="danger" disabled={historyDeleteBusy}>{historyDeleteBusy ? t("main.deleting") : t("main.deletePermanently")}</button></div>
          </form>
        </div>
      )}
      {action && (
        <div className="modal-overlay">
          <form className="modal confirm" onSubmit={performAction} role="dialog" aria-modal="true" aria-labelledby="action-title">
            <h2 id="action-title">{action.kind === "rename" ? t("main.renameSession") : action.kind === "stop" ? t("main.confirmStop") : t("main.confirmDelete")}</h2>
            <p className="action-target">{action.session.title}</p>
            {action.kind === "rename" ? <label>{t("main.sessionNameLabel")}<input autoFocus maxLength={80} value={renameTitle} onChange={e => setRenameTitle(e.target.value)} required/></label> :
              <p>
                {action.kind === "stop"
                  ? action.session.kind === "structured"
                    ? t("main.stopChatWarning")
                    : t("main.stopTerminalWarning")
                  : t("main.deleteSessionWarning", { running: action.session.status === "running" ? t("main.stopRunningWarning") : "" })}
              </p>}
            {error && <div className="error" role="alert">{errorText(error)}</div>}
            <div className="confirm-actions"><button type="button" className="secondary" disabled={actionBusy} onClick={() => setAction(null)}>{t("main.cancelAction")}</button>
              <button className={action.kind === "rename" ? "primary" : "danger"} disabled={actionBusy || (action.kind === "rename" && !renameTitle.trim())}>{actionBusy ? t("main.processing") : action.kind === "rename" ? t("main.save") : action.kind === "stop" ? t("main.stop") : t("main.delete")}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
