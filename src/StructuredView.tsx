import { getLocale, formatPercent, messageText, t, useI18n, type UiMessage, type Message } from "./i18n";
import { deadlineNotice, turnNotice, latestTurnOutcome } from "./ux-state";
import { closeSuggestions } from "./input-state";
import { copyText } from "./clipboard";
import { sessionStorageFailed, storageWarning } from "./storage";
import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  ChevronDown,
  Copy,
  LoaderCircle,
  ShieldCheck,
  X,
  Check,
  Clock,
  FileDiff,
  FileText,
  Globe,
  Hammer,
  ListChecks,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  TerminalSquare,
} from "lucide-react";
import { stored, remember } from "./storage";
import { inSlot, type HeaderSlots } from "./header-slots";
import { retainDiffs } from "./diff";
import ChangesPanel from "./ChangesPanel";
import { QuestionCard, type Question, type QuestionAnswers } from "./QuestionCard";
import { renderMarkdown } from "./markdown";
import { insertCommentBlock, collectChanges, type InlineComment } from "./changes";
import { retainChatEvents } from "./chat-events";

// Structured (ACP) chat: the panel sends prompts to a `hermes acp` child and
// renders its event stream — messages, thoughts, tool calls, a task plan,
// context usage and license: approval requests — as a conversation. Viewers
// dedupe by event seq because live events may overlap the initial snapshot.

type Request = <T>(url: string, method?: string, body?: unknown) => Promise<T>;
type Ev = { seq: number; t?: string; kind: string; [key: string]: unknown };
type ChatItem =
  | { type: "user"; key: number; text: string }
  | { type: "assistant"; key: number; id: string | null; text: string }
  | { type: "thought"; key: number; id: string | null; text: string }
  | { type: "tool"; key: number; tool: ToolItem }
  | { type: "notice"; key: number; text?: string; stopReason?: unknown; status?: string }
  | { type: "error"; key: number; text: string };
type ToolItem = {
  id: string;
  title?: string;
  kind?: string | null;
  status?: string | null;
  content?: unknown[] | null;
  rawInput?: { command?: string; description?: string } | null;
  locations?: unknown[] | null;
};
type Approval = {
  requestId: string;
  seq?: number;
  requestedAt?: string;
  decidedAt?: string;
  status: string;
  toolCall?: { title?: string; toolCallId?: string; rawInput?: { command?: string } | null } | null;
  options: Array<{ optionId: string; kind: string; name: string }>;
  expiresAt?: string;
  optionId?: string;
  questions?: Question[];
  truncated?: boolean;
};
type SessionState = {
  status?: string;
  title?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  settingsChanging?: boolean;
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> } | null;
  usage?: { used: number; size: number } | null;
  pendingApprovalCount?: number;
  lastError?: string | null;
};
type ModelState = {
  currentModelId: string;
  currentReasoningEffort?: string | null;
  availableModels: Array<{ modelId: string; name: string; description?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>; defaultReasoningEffort?: string | null }>;
} | null;

const STATUS_TEXT = {
  starting: "chat.statusStarting",
  resuming: "chat.statusResuming",
  idle: "chat.statusIdle",
  running: "chat.statusRunning",
  attention: "chat.statusAttention",
  offline: "chat.statusOffline",
  ended: "chat.statusEnded",
} as const;
const AGENT_NAME: Record<string, string> = { codex: "Codex", claude: "Claude", hermes: "Hermes" };
// Tur süresi: "0:42", "12:05", "1:02:10".
function elapsedText(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
// Tur süresi kendi bileşeninde sayılır; her saniye bütün sohbet yeniden çizilmez.
// Yalnız tur sürerken çizilir; başlangıç son kullanıcı mesajı (12 saatten eskiyse,
// örneğin kullanıcı mesajı olmadan başlayan turda, bileşenin açıldığı an).
function RunTimer({ turnStart }: { turnStart: number | null }) {
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = turnStart && turnStart <= mountedAt.current && mountedAt.current - turnStart < 12 * 3600_000 ? turnStart : mountedAt.current;
  return <span className="composer-run-time" aria-hidden="true">· {elapsedText(now - start)}</span>;
}
const TOOL_STATUS = {
  pending: "chat.toolPending",
  in_progress: "chat.toolRunning",
  completed: "chat.toolCompleted",
  failed: "chat.toolFailed",
} as const;

function compactTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

// Context gauge: fill percentage with threshold tiers, plus the last turn's
// token count when the agent reported one.
function ContextGauge({
  usage,
  lastTurn,
}: {
  usage: { used: number; size: number };
  lastTurn: number | null;
}) {
  useI18n();
  const percent = Math.min(100, Math.max(0, Math.round((usage.used / usage.size) * 100)));
  const tier = percent <= 30 ? "low" : percent <= 60 ? "mid" : percent <= 80 ? "high" : "critical";
  return (
    <span
      className={`ctx-gauge ${tier}`}
      title={t("chat.contextTitle", { used: usage.used, size: usage.size, percent, lastTurn: lastTurn ? t("chat.lastTurn", { count: lastTurn }) : "" })}
    >
      {t("chat.contextLabel")}
      <span className="ctx-bar" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </span>
      <span className="ctx-pct">{formatPercent(percent)}</span>
      {typeof lastTurn === "number" && lastTurn > 0 && (
        <span className="ctx-turn">{t("chat.lastTurnShort", { count: compactTokens(lastTurn) })}</span>
      )}
    </span>
  );
}

function toolIcon(kind?: string | null) {
  switch (kind) {
    case "read":
      return <FileText size={13} />;
    case "edit":
      return <FileText size={13} />;
    case "execute":
      return <TerminalSquare size={13} />;
    case "search":
      return <Search size={13} />;
    case "fetch":
      return <Globe size={13} />;
    default:
      return <Hammer size={13} />;
  }
}

function foldEvents(events: Ev[], previous: ChatItem[] = []): ChatItem[] {
  const items = previous.slice();
  const assistants = new Map<string, Extract<ChatItem, { type: "assistant" }>>();
  const thoughts = new Map<string, Extract<ChatItem, { type: "thought" }>>();
  const tools = new Map<string, Extract<ChatItem, { type: "tool" }>>();
  // Only the open turn can receive message/tool updates. Completed turns keep
  // their object identities so memoized rows never parse Markdown again.
  for (let i = items.length - 1; i >= 0; i--) {
    const node = items[i];
    if (node.type === "user") break;
    if (node.type === "assistant" && node.id && !assistants.has(node.id)) assistants.set(node.id, node);
    if (node.type === "thought" && node.id && !thoughts.has(node.id)) thoughts.set(node.id, node);
    if (node.type === "tool" && !tools.has(node.tool.id)) tools.set(node.tool.id, node);
  }
  const positions = new Map<ChatItem, number>();
  for (let i = items.length - 1; i >= 0 && items[i].type !== "user"; i--) positions.set(items[i], i);
  function replace(old: ChatItem, next: ChatItem) {
    const index = positions.get(old)!;
    items[index] = next; positions.delete(old); positions.set(next, index);
  }
  function push(node: ChatItem) { positions.set(node, items.length); items.push(node); }
  for (const ev of events) {
    if (ev.kind === "user") {
      assistants.clear();
      thoughts.clear();
      tools.clear();
      push({ type: "user", key: ev.seq, text: String(ev.text ?? "") });
    } else if (ev.kind === "assistant") {
      const id = typeof ev.id === "string" ? ev.id : null;
      if (id) {
        let node = assistants.get(id);
        if (!node) {
          node = { type: "assistant", key: ev.seq, id, text: "" };
          assistants.set(id, node);
          push(node);
        }
        const next = { ...node, text: node.text + String(ev.text ?? "") };
        replace(node, next);
        assistants.set(id, next);
      } else {
        push({ type: "assistant", key: ev.seq, id: null, text: String(ev.text ?? "") });
      }
    } else if (ev.kind === "thought") {
      const id = typeof ev.id === "string" ? ev.id : null;
      if (id) {
        let node = thoughts.get(id);
        if (!node) {
          node = { type: "thought", key: ev.seq, id, text: "" };
          thoughts.set(id, node);
          push(node);
        }
        const next = { ...node, text: node.text + String(ev.text ?? "") };
        replace(node, next);
        thoughts.set(id, next);
      } else {
        push({ type: "thought", key: ev.seq, id: null, text: String(ev.text ?? "") });
      }
    } else if (ev.kind === "tool") {
      const id = String(ev.id ?? "");
      if (!id) continue;
      let node = tools.get(id);
      if (ev.app === "start") {
        const data = (ev.data ?? {}) as Partial<ToolItem>;
        node = {
          type: "tool",
          key: ev.seq,
          tool: {
            id,
            title: data.title,
            kind: data.kind,
            status: data.status ?? "pending",
            content: data.content ?? null,
            rawInput: data.rawInput ?? null,
            locations: data.locations ?? null,
          },
        };
        tools.set(id, node);
        push(node);
      } else if (ev.patch && typeof ev.patch === "object") {
        if (!node) {
          node = { type: "tool", key: ev.seq, tool: { id, title: "chat.previousTool", content: null } };
          tools.set(id, node); push(node);
        }
        const next = { ...node, tool: { ...node.tool, ...ev.patch as Partial<ToolItem> } };
        replace(node, next); tools.set(id, next);
      }
    } else if (ev.kind === "status" && typeof ev.detail === "string" && ev.detail) {
      push({ type: "notice", key: ev.seq, text: ev.detail, status: String(ev.status ?? "") });
    } else if (ev.kind === "turn") {
      push({ type: "notice", key: ev.seq, stopReason: ev.stopReason });
    } else if (ev.kind === "error") {
      push({ type: "error", key: ev.seq, text: String(ev.text ?? "") });
    }
  }
  return items;
}

function foldApprovals(events: Ev[], ended = false, previous: Approval[] = []): Approval[] {
  const map = new Map(previous.map(approval => [approval.requestId, approval]));
  for (const ev of events) {
    if (ev.kind !== "approval") continue;
    const requestId = String(ev.requestId ?? "");
    if (!requestId) continue;
    const current: Approval = { ...(map.get(requestId) ?? { requestId, status: "requested", options: [] }) };
    if (ev.status === "requested") {
      current.seq = ev.seq;
      current.requestedAt = ev.t;
      current.status = "requested";
      current.truncated = ev.truncated === true;
      current.toolCall = (ev.toolCall ?? null) as Approval["toolCall"];
      current.options = (ev.options ?? []) as Approval["options"];
      current.questions = Array.isArray(ev.questions) ? ev.questions as Question[] : undefined;
      current.expiresAt = typeof ev.expiresAt === "string" ? ev.expiresAt : undefined;
    } else if (ev.status === "decided") {
      current.status = "decided";
      current.optionId = String(ev.optionId ?? "");
      current.decidedAt = ev.t;
    } else {
      current.status = String(ev.status ?? "expired");
      current.decidedAt = ev.t;
    }
    map.set(requestId, current);
  }
  return [...map.values()].map((approval) =>
    ended && approval.status === "requested" ? { ...approval, status: "expired" } : approval,
  );
}

// Place results beside their tool in the same turn; missing tools fall back to
// request order. Tool ids may be reused in later turns.
function approvalTimeline(items: ChatItem[], approvals: Approval[]) {
  const rows: Array<{ position: number; item: ChatItem } | { position: number; approval: Approval }> = items.map(item => ({ position: item.key, item }));
  for (const approval of approvals) {
    if (approval.status === "requested") continue;
    const seq = approval.seq ?? 0;
    const start = items.slice().reverse().find(item => item.type === "user" && item.key <= seq)?.key ?? 0;
    const end = items.find(item => item.type === "user" && item.key > seq)?.key ?? Infinity;
    const tool = approval.toolCall?.toolCallId && items.slice().reverse().find(item => item.type === "tool" && item.tool.id === approval.toolCall?.toolCallId && item.key >= start && item.key < end);
    rows.push({ position: (tool ? tool.key : seq) + 0.5, approval });
  }
  return rows.sort((a, b) => a.position - b.position);
}

function approvalDecision(approval: Approval): string {
  if (approval.status === "expired") return t("chat.approvalExpired");
  if (approval.questions?.length) return approval.optionId === "__deny" ? t("chat.questionDeclined") : t("chat.questionAnswered");
  const option = approval.options.find(option => option.optionId === approval.optionId);
  if (option?.kind === "allow_once") return t("chat.allowedOnce");
  if (option?.kind === "allow_always") return t("chat.allowedSession");
  if (option?.kind.startsWith("reject") || approval.optionId === "__deny") return t("chat.rejected");
  return t("chat.decisionMissing");
}

function ApprovalResult({ approval, onRetry }: { approval: Approval; onRetry: () => void }) {
  const time = approval.decidedAt || approval.requestedAt;
  const command = approval.toolCall?.rawInput?.command || approval.toolCall?.title;
  return <div className="chat-notice approval-result" role="status">
    <strong>{approvalDecision(approval)}</strong>
    {!approval.questions?.length && command && <pre className="tool-command">{command.slice(0, 500)}{command.length > 500 ? t("chat.commandSummary") : ""}</pre>}
    {time && Number.isFinite(Date.parse(time)) && <span>{approval.decidedAt ? t("chat.decisionTime") : t("chat.requestTime")}<time dateTime={time}>{new Date(time).toLocaleString(getLocale())}</time></span>}
    {approval.status === "expired" && !approval.questions?.length && <button type="button" onClick={onRetry}>{t("chat.retryRequest")}</button>}
  </div>;
}

function ApprovalCard({
  approval,
  busy,
  onAnswer,
}: {
  approval: Approval;
  busy: boolean;
  onAnswer: (requestId: string, optionId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (approval.status !== "requested") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval.status]);
  const expires = approval.expiresAt ? Date.parse(approval.expiresAt) : 0;
  const remain = expires ? Math.max(0, Math.round((expires - now) / 1000)) : null;
  return (
    <div className={`approval-card ${approval.status}`}>
      <p className="sr-only" role="status" aria-atomic="true">{deadlineNotice(remain)}</p>
      <span className="approval-icon" aria-hidden="true">{approval.toolCall?.rawInput?.command ? <TerminalSquare size={16} /> : <ShieldAlert size={16} />}</span>
      <div className="approval-body">
        <div className="approval-head" role="alert">
          <span>{t("chat.approvalNeeded")}</span>
          <strong>{approval.toolCall?.title || t("chat.toolCall")}</strong>
        </div>
        {approval.toolCall?.rawInput?.command && (
          <pre className="tool-command">$ {approval.toolCall.rawInput.command}</pre>
        )}
        {approval.truncated && <p className="approval-note">{t("chat.commandTruncated")}</p>}
        {approval.status === "requested" ? (
          remain !== null && (
            <div className="approval-note">
              <Clock size={11} aria-hidden="true" /><span aria-hidden="true">{t("chat.autoRejectCountdown", { time: `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}` })}</span><span className="sr-only">{t("chat.autoReject")}</span>
            </div>
          )
        ) : (
          <div className="approval-note">
            {approval.status === "decided"
              ? t("chat.approvalRecorded", { optionId: approval.optionId ?? "" })
              : t("chat.autoRejected")}
          </div>
        )}
      </div>
      {approval.status === "requested" && (
        <div className="approval-actions">
          {approval.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              disabled={busy || remain === 0}
              className={option.kind.startsWith("allow") ? "approval-allow" : "approval-deny"}
              onClick={() => onAnswer(approval.requestId, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  useI18n();
  label ??= t("chat.copy");
  const [result, setResult] = useState<"copied" | "failed" | "">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button type="button" className="chat-copy" aria-label={label} title={label} onClick={async () => {
    setResult(await copyText(text) ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(""), 2400);
  }}>{result === "copied" ? <Check size={13} /> : <Copy size={13} />}<span aria-live="polite">{result ? t(result === "copied" ? "chat.copied" : "chat.copyFailed") : t("chat.copy")}</span></button>;
}

function itemText(item: ChatItem): string {
  if (item.type === "notice") return item.text ?? turnNotice(item.stopReason);
  if (item.type !== "tool") return item.text;
  const title = item.tool.title === "chat.previousTool" ? t("chat.previousTool") : item.tool.title;
  return [title, item.tool.rawInput?.command, JSON.stringify(item.tool.content ?? [])].filter(Boolean).join("\n");
}

function ToolCard({ tool, awaiting = false }: { tool: ToolItem; awaiting?: boolean }) {
  useI18n();
  const content = Array.isArray(tool.content) ? tool.content : [];
  const blocks: React.ReactNode[] = [];
  content.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    const item = block as { type?: string; content?: { type?: string; text?: string }; path?: string; oldText?: string; newText?: string; terminalId?: string };
    if (item.type === "content" && item.content?.type === "text" && typeof item.content.text === "string")
      blocks.push(
        <pre key={index} className="tool-text">
          {item.content.text}
        </pre>,
      );
    else if (item.type === "diff")
      blocks.push(
        <div key={index} className="tool-diff">
          {item.path && <code>{item.path}</code>}
          <strong>{t("chat.before")}</strong><pre className="diff-old">{item.oldText || t("chat.noPreviousContent")}</pre>
          <strong>{t("chat.after")}</strong><pre className="diff-new">{item.newText || t("chat.contentDeleted")}</pre>
        </div>,
      );
    else if (item.type === "terminal")
      blocks.push(
        <pre key={index} className="tool-text">
          {t("chat.terminalId", { id: item.terminalId ?? "" })}
        </pre>,
      );
  });
  return (
    <div className={`tool-card ${awaiting ? "awaiting" : tool.status ?? "pending"}`}>
      <div className="tool-head">
        <span className="tool-icon">{toolIcon(tool.kind)}</span>
        <strong>{tool.title === "chat.previousTool" ? t("chat.previousTool") : tool.title || tool.id}</strong>
        <span className={`tool-status ${awaiting ? "awaiting" : tool.status ?? "pending"}`}>
          {awaiting ? t("chat.statusAttention") : tool.status && Object.hasOwn(TOOL_STATUS, tool.status) ? t(TOOL_STATUS[tool.status as keyof typeof TOOL_STATUS]) : tool.status ?? ""}
        </span>
      </div>
      {(blocks.length > 0 || tool.rawInput?.command) && (
        <details className="tool-details" open={tool.status === "failed"}>
          <summary>{t("chat.commandOutput")} {blocks.length > 0 && <span>{t("chat.recordCount", { count: blocks.length })}</span>}</summary>
          {tool.rawInput?.command && <pre className="tool-command">$ {tool.rawInput.command}</pre>}
          {blocks}
          <CopyButton text={[tool.rawInput?.command, ...content.map((block) => {
            const item = block as { content?: { text?: string }; oldText?: string; newText?: string };
            return item?.content?.text ?? [item?.oldText, item?.newText].filter(Boolean).join("\n");
          })].filter(Boolean).join("\n")} label={t("chat.copyToolRecord")} />
        </details>
      )}
    </div>
  );
}

export default function StructuredView({
  session,
  onUnauthorized,
  request,
  slots,
}: {
  session: { id: string; status: string; connection?: string; agentId?: string };
  onUnauthorized: () => void;
  request: Request;
  slots?: HeaderSlots;
}) {
  useI18n();
  const draftKey = `panel-draft-${session.id}`;
  const [draft, setDraft] = useState(() => stored(draftKey, "", true));
  const [history, setHistory] = useState(() => ({ events: [] as Ev[], items: [] as ChatItem[], approvals: [] as Approval[],
    tools: [] as ChatItem[], plan: null as Array<{ content: string; status: string }> | null,
    commands: null as Array<{ name: string; description?: string }> | null }));
  const { events, items, plan, commands } = history;
  const [connection, setConnection] = useState<string>(session.connection || "starting");
  const [state, setState] = useState<SessionState>({});
  const [models, setModels] = useState<ModelState>(null);
  const [error, setError] = useState<UiMessage>("");
  const [connectionError, setConnectionError] = useState<UiMessage>("");
  const [reconnecting, setReconnecting] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hitIndex, setHitIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<{ requestId: string; failure: Error } | null>(null);
  const [busySwitch, setBusySwitch] = useState(false);
  useLayoutEffect(() => {
    if (composerRef.current) {
      composerRef.current.style.height = "auto";
      composerRef.current.style.height = `${Math.min(Math.max(100, window.innerHeight * 0.28), composerRef.current.scrollHeight)}px`;
    }
  }, [draft]);
  const [stick, setStick] = useState(true);
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNote, setChangesNote] = useState<Message | "">("");
  const commentsKey = `panel-comments-${session.id}`;
  const [comments, setComments] = useState<InlineComment[]>(() => {
    try {
      const value = JSON.parse(stored(commentsKey, "[]", true));
      return Array.isArray(value)
        ? (value.filter((item) => item && typeof item === "object") as InlineComment[]).slice(-200)
        : [];
    } catch {
      return [];
    }
  });
  const [mention, setMention] = useState<{
    open: boolean;
    query: string;
    start: number;
    items: string[];
    active: number;
  }>({ open: false, query: "", start: 0, items: [], active: 0 });
  const mentionToken = useRef(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  follow.current = stick && !(searchOpen && query.trim());
  const seqRef = useRef(0);
  const [historyIncomplete, setHistoryIncomplete] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  useEffect(() => {
    remember(draftKey, draft, true);
  }, [draft, draftKey]);
  useEffect(() => {
    remember(commentsKey, JSON.stringify(comments), true);
  }, [comments, commentsKey]);
  const merge = useCallback((incoming: Ev[]) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    setHistory((previous) => {
      const fresh = incoming
        .filter((event) => Number.isInteger(event?.seq) && event.seq > seqRef.current)
        .sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) return previous;
      seqRef.current = fresh[fresh.length - 1].seq;
      const next = [...previous.events, ...fresh];
      const kept = retainChatEvents(next);
      if (kept.truncated) queueMicrotask(() => setHistoryIncomplete(true));
      // A retention cut requires a rebuild from the retained tail. Ordinary
      // streaming applies only the fresh events to the existing projection.
      const batch = (kept.truncated ? kept.events : fresh) as Ev[];
      const items = foldEvents(batch, kept.truncated ? [] : previous.items);
      const approvals = batch.some(event => event.kind === "approval") || kept.truncated
        ? foldApprovals(batch, false, kept.truncated ? [] : previous.approvals) : previous.approvals;
      let plan = kept.truncated ? null : previous.plan, commands = kept.truncated ? null : previous.commands;
      for (const event of batch) {
        if (event.kind === "plan") plan = Array.isArray(event.entries) ? event.entries as typeof plan : null;
        if (event.kind === "commands") commands = Array.isArray(event.commands) ? event.commands as typeof commands : null;
      }
      const tools = kept.truncated || batch.some(event => event.kind === "tool")
        ? items.filter(item => item.type === "tool") : previous.tools;
      return { events: kept.events as Ev[], items, approvals, tools, plan, commands };
    });
  }, []);
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let terminal = session.status === "ended";
    async function connect() {
      if (disposed) return;
      try {
        const d = await request<{ ticket: string }>(
          `/sessions/${session.id}/ticket`,
          "POST",
          {},
        );
        if (disposed) return;
        const after = seqRef.current;
        const ws = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/structured?id=${session.id}&after=${after}`,
          `panel-ticket.${d.ticket}`,
        );
        socket.current = ws;
        ws.onopen = () => {
          attempt = 0;
        };
        ws.onmessage = (e) => {
          if (disposed) return;
          let data: {
            type?: string;
            event?: Ev;
            events?: Ev[];
            truncated?: boolean;
            state?: SessionState;
            models?: ModelState;
          };
          try {
            data = JSON.parse(e.data);
          } catch {
            return;
          }
          if ((data.type === "hello" || data.type === "state") && "models" in data) setModels(data.models ?? null);
          if (data.type === "hello") {
            setConnectionError("");
            setConnection(data.state?.status ?? "starting");
            setState((previous) => ({ ...previous, ...(data.state ?? {}) }));
            if (data.state?.status === "ended") terminal = true;
          } else if (data.type === "events" && data.events) {
            if (data.truncated) setHistoryIncomplete(true);
            merge(data.events);
          } else if (data.type === "event" && data.event) {
            merge([data.event]);
          } else if (data.type === "state" && data.state) {
            if (data.state.status === "ended") terminal = true;
            setConnection(data.state.status ?? "starting");
            setState((previous) => ({ ...previous, ...data.state }));
          }
        };
        ws.onclose = (e) => {
          if (disposed) return;
          if (e.reason) setConnectionError({ reason: e.reason });
          if (e.code === 4001) {
            onUnauthorized();
            return;
          }
          if (e.code === 4004) {
            setConnection("ended");
            return;
          }
          if (!terminal) {
            setConnection((previous) => (previous === "ended" ? previous : "offline"));
            retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
          }
        };
      } catch (err) {
        if (!disposed && !terminal) {
          setConnection("offline");
          setConnectionError(err as Error);
          retry = setTimeout(connect, 5000);
        }
      }
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, [session.id, session.status, request, onUnauthorized, merge]);
  useEffect(() => {
    if (stick && !(searchOpen && query.trim()) && streamRef.current)
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [events, stick, searchOpen, query]);
  const hits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(getLocale());
    return searchOpen && needle ? items.filter((item) => itemText(item).toLocaleLowerCase(getLocale()).includes(needle)).map((item) => item.key) : [];
  }, [items, query, searchOpen, getLocale()]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const currentHit = hits.length ? hits[hitIndex % hits.length] : undefined;
  useEffect(() => { setHitIndex(0); }, [query]);
  useEffect(() => {
    if (currentHit === undefined) return;
    setStick(false);
    const element = streamRef.current?.querySelector<HTMLElement>(`[data-chat-key="${currentHit}"]`);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.querySelectorAll("details").forEach((detail) => { detail.open = true; });
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentHit]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const ended = session.status === "ended" || connection === "ended";
  const approvals = useMemo(() => ended ? history.approvals.map(approval => approval.status === "requested"
    ? { ...approval, status: "expired" } : approval) : history.approvals, [history.approvals, ended]);
  const timeline = useMemo(() => approvalTimeline(items, approvals), [items, approvals]);
  const changes = useMemo(() => collectChanges(history.tools), [history.tools]);
  // Başlıktaki özet: farklı dosya sayısı ve toplam satır farkı. Fark her akış
  // olayında yeniden hesaplanmasın diye parça başına önbellekte tutulur; çok
  // büyük fark sayılmaz ve ipucunda belirtilir.
  const diffCache = useRef(new Map());
  const diffs = useMemo(() => retainDiffs(diffCache.current, changes), [changes]);
  const changeStats = useMemo(() => {
    let added = 0, removed = 0, skipped = 0;
    for (const result of diffs.values()) {
      if (result.tooLarge) skipped++;
      else { added += result.added; removed += result.removed; }
    }
    return { files: new Set(changes.map(file => file.path)).size, added, removed, skipped };
  }, [changes, diffs]);
  const lastTurn = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.kind !== "turn") continue;
      const reported = event.usage as
        | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
        | null
        | undefined;
      if (!reported) return null;
      if (typeof reported.totalTokens === "number") return reported.totalTokens;
      if (typeof reported.inputTokens === "number" || typeof reported.outputTokens === "number")
        return (reported.inputTokens ?? 0) + (reported.outputTokens ?? 0);
      return null;
    }
    return null;
  }, [events]);
  const usage = state.usage ?? null;
  const outcome = useMemo(() => latestTurnOutcome(events), [events]);
  const retryRequest = () => {
    setDraft(current => (current ? current + "\n\n" : "") + t("chat.retryExpiredDraft"));
    composerRef.current?.focus();
  };
  const pendingApprovals = useMemo(() => approvals.filter((approval) => approval.status === "requested"), [approvals]);
  const running = connection === "running" || connection === "attention";
  // Onay bekleyen komutlar: önce araç kimliği (ACP, Claude, Codex onay olayında
  // taşır); kimlik yoksa aynı komutu taşıyan, son kullanıcı mesajından sonra
  // başlamış ve bitmemiş araç. Sorular araç satırına bağlanmaz.
  const awaitingToolIds = useMemo(() => {
    const ids = new Set<string>();
    const decisions = pendingApprovals.filter((approval) => !approval.questions?.length);
    if (!decisions.length) return ids;
    let lastUser = -1;
    items.forEach((item, index) => { if (item.type === "user") lastUser = index; });
    const open = items.slice(lastUser + 1).flatMap((item) => item.type === "tool" && item.tool.status !== "completed" && item.tool.status !== "failed" ? [item.tool] : []);
    for (const approval of decisions) {
      const id = approval.toolCall?.toolCallId;
      const command = approval.toolCall?.rawInput?.command;
      const match = id ? open.find((tool) => tool.id === id) : command ? open.find((tool) => tool.rawInput?.command === command && !ids.has(tool.id)) : undefined;
      if (match) ids.add(match.id);
    }
    return ids;
  }, [pendingApprovals, items]);
  // Tur süresinin başlangıcı (RunTimer): son kullanıcı mesajının zamanı.
  const turnStart = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "user") return Date.parse(events[i].t ?? "") || null;
    return null;
  }, [events]);
  // Gönder ⇄ Durdur değişince odak kaybolmasın; Gönder'e basıldıktan hemen sonra
  // aynı yere düşen ikinci tıklama (çift tıklama / dokunma) turu durdurmasın.
  const runFocus = useRef(false);
  const sendClickedAt = useRef(0);
  const [stopping, setStopping] = useState(false);
  useLayoutEffect(() => {
    if (!running) setStopping(false);
    if (runFocus.current && (document.activeElement === document.body || !document.activeElement)) composerRef.current?.focus();
    runFocus.current = false;
  }, [running]);
  const agentName = AGENT_NAME[session.agentId ?? ""] ?? "Ajan";
  const currentModel = state.model ?? models?.currentModelId ?? "";
  const modelInfo = models?.availableModels.find((model) => model.modelId === currentModel);
  const efforts = modelInfo?.supportedReasoningEfforts ?? [];
  const currentEffort = state.reasoningEffort !== undefined ? state.reasoningEffort ?? "" : models?.currentReasoningEffort ?? modelInfo?.defaultReasoningEffort ?? "";
  const currentMode = state.modes?.availableModes.find((mode) => mode.id === state.modes?.currentModeId);
  const ready = connection === "idle";
  const settingsBusy = busySwitch || Boolean(state.settingsChanging);
  const sendBlocked = ended || sending || running || !ready || settingsBusy;
  const draftBytes = new TextEncoder().encode(draft.replace(/\r\n?/g, "\n")).length;
  const sendHint = ended ? t("chat.readOnlyHint") : sending ? t("chat.sending") : running
    ? t("chat.runningHint")
    : !ready ? t("chat.notReadyHint")
    : settingsBusy ? t("chat.applyingSelection") : t("chat.sendKeysHint");
  function openSearch() { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
  async function reconnect() {
    setReconnecting(true);
    setError("");
    try { await request(`/sessions/${session.id}/connect`, "POST", {}); }
    catch (err) { setError(err as Error); }
    finally { setReconnecting(false); }
  }
  function insertComments(selected: InlineComment[]) {
    if (!selected.length) return;
    const next = insertCommentBlock(draft, selected);
    if (next === null) {
      setChangesNote({ key: "chat.commentGroupTooLarge" });
      return;
    }
    setDraft(next);
    setChangesNote({ key: "chat.commentsAdded", params: { count: selected.length } });
    setTimeout(() => setChangesNote(""), 4000);
  }
  // "@" mention picker: a trigger is a caret-preceded @ (start of input or
  // after whitespace) followed by a whitespace-free query; suggestions come
  // from the session's project via the bounded files endpoint.
  function closeMention() { setMention(closeSuggestions(mentionToken, mentionTimer)); }
  useEffect(() => () => { closeSuggestions(mentionToken, mentionTimer); }, []);
  function onDraftChange(value: string, caret: number) {
    setDraft(value);
    const before = value.slice(0, caret);
    const match = /(^|[\s(])@([^\s@]{0,80})$/.exec(before);
    if (!match) {
      closeMention();
      return;
    }
    const query = match[2];
    const start = caret - query.length - 1;
    setMention((current) => ({ ...current, open: true, query, start, active: 0 }));
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    const token = ++mentionToken.current;
    mentionTimer.current = setTimeout(async () => {
      try {
        const data = await request<{ files: string[] }>(
          `/sessions/${session.id}/files?q=${encodeURIComponent(query)}`,
        );
        if (mentionToken.current !== token) return;
        setMention((current) => ({ ...current, items: (data.files || []).slice(0, 8), active: 0 }));
      } catch {
        if (mentionToken.current === token) setMention((current) => ({ ...current, items: [] }));
      }
    }, 140);
  }
  function selectMention(path: string) {
    const element = composerRef.current;
    const caret = element?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mention.start)}@${path} ${draft.slice(caret)}`;
    setDraft(next);
    closeMention();
    requestAnimationFrame(() => {
      const position = mention.start + path.length + 2;
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  }
  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.open && mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((current) => ({ ...current, active: (current.active + 1) % current.items.length }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((current) => ({
          ...current,
          active: (current.active - 1 + current.items.length) % current.items.length,
        }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mention.items[mention.active]);
        return;
      }
    }
    if (e.key === "Escape" && mention.open) {
      closeMention();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }
  // Başlangıç kutusundan gelen ilk mesaj: gönderim mümkün olunca bir kez gider.
  // Yalnız taslak hâlâ o mesajsa; kullanıcı taslağı değiştirdiyse gönderilmez.
  useEffect(() => {
    const first = stored(`panel-autosend-${session.id}`, "", true);
    if (!first) return;
    if (ended || draft !== first) { remember(`panel-autosend-${session.id}`, "", true); return; }
    if (!ready || sendBlocked) return;
    remember(`panel-autosend-${session.id}`, "", true);
    void submit();
  }, [ready, sendBlocked, ended, draft]);
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (sendBlocked || !draft.trim()) return;
    const submittedDraft = draft;
    const text = draft.replace(/\r\n?/g, "\n");
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      setError({ key: "terminal.unsupportedControlCharacter" });
      return;
    }
    if (text.length > 8000 || new TextEncoder().encode(text).length > 16000) {
      setError({ key: "chat.messageTooLong" });
      return;
    }
    setSending(true);
    setError("");
    try {
      await request(`/sessions/${session.id}/prompt`, "POST", { text });
      closeMention();
      setDraft((current) => current === submittedDraft ? "" : current);
      setStick(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSending(false);
    }
  }
  async function cancel() {
    setError("");
    try {
      const result = await request<{ cancelled: boolean }>(`/sessions/${session.id}/cancel`, "POST", {});
      if (!result.cancelled) {
        setError({ key: "chat.stopFailed" });
        setStopping(false);
      }
    } catch (err) {
      setError(err as Error);
      setStopping(false);
    }
  }
  async function answer(requestId: string, optionId: string) {
    setAnswering(requestId);
    setError("");
    try {
      await request(`/sessions/${session.id}/approvals/${requestId}`, "POST", { optionId });
    } catch (err) {
      setError(err as Error);
    } finally {
      setAnswering(null);
    }
  }
  async function answerQuestion(requestId: string, answers?: QuestionAnswers) {
    setAnswering(requestId);
    setQuestionError(null);
    try {
      await request(`/sessions/${session.id}/approvals/${requestId}`, "POST", { optionId: answers ? "__answer" : "__deny", ...(answers ? { answers } : {}) });
    } catch (err) {
      setQuestionError({ requestId, failure: err as Error });
      throw err;
    } finally { setAnswering(null); }
  }
  async function changeModel(modelId: string, reasoningEffort?: string) {
    setBusySwitch(true);
    setError("");
    try {
      await request(`/sessions/${session.id}/model`, "POST", { modelId, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) });

    } catch (err) {
      setError(err as Error);
    } finally {
      setBusySwitch(false);
    }
  }
  async function changeMode(modeId: string) {
    setBusySwitch(true);
    setError("");
    try {
      await request(`/sessions/${session.id}/mode`, "POST", { modeId });

    } catch (err) {
      setError(err as Error);
    } finally {
      setBusySwitch(false);
    }
  }
  return (
    <div className={`chat-section ${changesOpen && changes.length > 0 ? "with-changes" : ""}`} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); openSearch(); }
    }}>
      {inSlot(
        <span className="caption-main" role="status">
          <span className={`live-dot ${connection === "idle" ? "" : connection === "running" || connection === "attention" ? "working" : "offline"}`} />
          <span className="caption-status">{t(STATUS_TEXT[connection as keyof typeof STATUS_TEXT] ?? STATUS_TEXT.starting)}</span>
          {usage && usage.size > 0 && (
            <>
              <span className="caption-divider" aria-hidden="true" />
              <ContextGauge usage={usage} lastTurn={lastTurn} />
            </>
          )}
          {currentModel && (
            <>
              <span className="caption-divider" aria-hidden="true" />
              <span className="caption-model">{currentModel.replace(/^[^:]+:/, "")}</span>
            </>
          )}
        </span>,
        slots?.status,
      )}
      {inSlot(
        <span className="chat-caption-actions">
          {changes.length > 0 && (
            <button
              className={`text-button changes-toggle ${changesOpen ? "open" : ""}`}
              aria-expanded={changesOpen}
              title={t("chat.changes")}
              onClick={() => setChangesOpen((value) => !value)}
            >
              <FileDiff size={14} /><span className="sr-only">{t("chat.changesAria")}</span>
              <span className="changes-label">{changeStats.files}<span className="changes-word">{t("chat.filesChanged")}</span></span>
              {changeStats.added + changeStats.removed > 0 && <span className="changes-sum" title={changeStats.skipped ? t("chat.skippedLargeChanges", { count: changeStats.skipped }) : undefined}><span className="stat-add">+{changeStats.added}</span> <span className="stat-del">−{changeStats.removed}</span></span>}
            </button>
          )}
          {connection === "offline" && !ended && (
            <button
              className="text-button"
              onClick={reconnect}
              disabled={reconnecting}
            >
              <RefreshCw size={13} /> {t("chat.connect")}
            </button>
          )}
          <button className={`text-button chat-search-toggle ${searchOpen ? "open" : ""}`} aria-label={t("chat.search")} title={t("chat.searchShortcut")} aria-expanded={searchOpen} onClick={() => searchOpen ? setSearchOpen(false) : openSearch()}><Search size={14} /><span>{t("chat.searchButton")}</span></button>
        </span>,
        slots?.tools,
      )}
      {searchOpen && <div className="chat-search" role="search" aria-label={t("chat.search")}>
        <Search size={15} />
        <input ref={searchRef} aria-label={t("chat.searchInput")} placeholder={t("chat.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") { setSearchOpen(false); composerRef.current?.focus(); }
          if (event.key === "Enter" && hits.length) { event.preventDefault(); setHitIndex((index) => (index + (event.shiftKey ? hits.length - 1 : 1)) % hits.length); }
        }} />
        <span className="chat-search-count" role="status">{query.trim() ? hits.length ? `${hitIndex % hits.length + 1} / ${hits.length}` : t("chat.noResults") : ""}</span>
        <button type="button" disabled={!hits.length} aria-label={t("chat.previousResult")} onClick={() => setHitIndex((index) => (index + hits.length - 1) % hits.length)}><ChevronUp size={16} /></button>
        <button type="button" disabled={!hits.length} aria-label={t("chat.nextResult")} onClick={() => setHitIndex((index) => (index + 1) % hits.length)}><ChevronDown size={16} /></button>
        <button type="button" aria-label={t("chat.closeSearch")} onClick={() => { setSearchOpen(false); composerRef.current?.focus(); }}><X size={16} /></button>
      </div>}
      {changesOpen && changes.length > 0 && (
        <ChangesPanel
          files={changes} diffs={diffs}
          comments={comments}
          onCommentsChange={setComments}
          onInsert={insertComments}
          onClose={() => setChangesOpen(false)}
        />
      )}
      {changesNote && (
        <div className="chat-hint" role="status">
          {messageText(changesNote)}
        </div>
      )}
      {connection === "offline" && !ended && (
        <div className="chat-connection-note" role="status"><RefreshCw size={14} /><span>{t("chat.disconnected")}{(connectionError || state.lastError) && <small>{connectionError ? messageText(connectionError) : state.lastError}</small>}</span></div>
      )}
      {sessionStorageFailed() && <div role="status" className="chat-notice">{storageWarning()}</div>}
      {error && (
        <div role="alert" className="error chat-error">
          {messageText(error)}
        </div>
      )}
      {historyIncomplete && <p className="chat-hint" role="status">{t("chat.historyIncomplete")}</p>}
      <div className="chat-stream" role="region" aria-label={t("chat.messages")} ref={streamRef} onScroll={() => {
        const el = streamRef.current;
        if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}>
        {items.length === 0 && !ended && (
          <div className="chat-empty">
            <span className="chat-empty-mark"><Sparkles size={18} /></span>
            <strong>{t("chat.newChat")}</strong>
            <p>
              {t("chat.emptyHelp")}
            </p>
            <div className="chat-starters">{[t("chat.starterReview"), t("chat.starterRun"), t("chat.starterInspect")].map((text) => <button key={text} type="button" onClick={() => { setDraft(text); composerRef.current?.focus(); }}>{text}<ArrowUp size={14} /></button>)}</div>
          </div>
        )}
        {ended && (
          <div className="chat-notice">
            {t("chat.endedNotice")}
          </div>
        )}
        {timeline.map(row => "approval" in row ? <ApprovalResult key={`result-${row.approval.requestId}`} approval={row.approval} onRetry={retryRequest} /> : <ChatRow key={row.item.key} item={row.item} root={streamRef} follow={follow}
          initial={false} hit={hitSet.has(row.item.key)} current={currentHit === row.item.key}
          awaiting={row.item.type === "tool" && awaitingToolIds.has(row.item.tool.id)} />)}
      </div>
      {!stick && (
        <button
          className="chat-jump"
          onClick={() => {
            setStick(true);
            if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} /> {t("chat.jumpLatest")}
        </button>
      )}
      <div className="chat-controls" role="region" aria-label={t("chat.planAndComposer")} tabIndex={0}>
      {plan && plan.length > 0 && (
        <div className="plan-panel">
          <div className="plan-head">
            <ListChecks size={14} /> <span>{t("chat.taskPlan")}</span>
            <span className="plan-count num">
              {plan.filter((entry) => entry.status === "completed").length}/{plan.length}
            </span>
          </div>
          <ul>
            {plan.map((entry, index) => (
              <li key={index} className={entry.status}>
                {entry.status === "completed" ? <Check size={12} /> : <span className="plan-dot" />}
                <span>{entry.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{outcome ? turnNotice(outcome.stopReason) : ""}</div>
      {approvals.filter(approval => approval.status === "requested" || (approval.questions?.length && approval.status === "expired")).map((approval) => approval.questions?.length ? (
        <QuestionCard onRetry={retryRequest} key={approval.requestId} questions={approval.questions} status={approval.status} expiresAt={approval.expiresAt} busy={answering === approval.requestId} error={questionError?.requestId === approval.requestId ? messageText(questionError.failure) : null} onAnswer={(answers) => answerQuestion(approval.requestId, answers)} onReject={() => answerQuestion(approval.requestId)} />
      ) : (
        <ApprovalCard
          key={approval.requestId}
          approval={approval}
          busy={answering === approval.requestId}
          onAnswer={answer}
        />
      ))}
      <div className="chat-compose" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMention();
      }}>
        {mention.open && (mention.items.length > 0 || mention.query.length > 0) && (
          <div id={`mention-list-${session.id}`} className="mention-menu" role="listbox" aria-label={t("chat.fileSuggestions")}>
            {mention.items.length === 0 && <div className="mention-empty">{t("chat.noMatchingFiles")}</div>}
            {mention.items.map((file, index) => (
              <button
                key={file}
                type="button"
                role="option"
                id={`mention-option-${session.id}-${index}`}
                aria-selected={index === mention.active}
                className={`mention-item ${index === mention.active ? "active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMention(file)}
              >
                {file}
              </button>
            ))}
          </div>
        )}
        <form className="composer" onSubmit={submit}>
          <textarea
            rows={2}
            aria-label={t("chat.writeMessage")}
            aria-expanded={mention.open}
            aria-controls={mention.open ? `mention-list-${session.id}` : undefined}
            aria-activedescendant={mention.open && mention.items[mention.active] ? `mention-option-${session.id}-${mention.active}` : undefined}
            ref={composerRef}
            placeholder={
              ended ? t("chat.endedPlaceholder") : sending ? t("chat.sending") : t("chat.messagePlaceholder")
            }
            value={draft}
            disabled={ended}
            aria-describedby="chat-composer-hint"
            onChange={(e) => onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="composer-bar">
            {(models || state.modes) && (
              <div className="chat-toolbar">
                {models && models.availableModels?.length > 0 && (
                  <label className="chat-select">
                    <span className="chat-control-label">{t("chat.model")}</span>
                    <select
                      aria-label={t("chat.model")}
                      value={currentModel}
                      disabled={settingsBusy || running || !ready || ended}
                      onChange={(e) => changeModel(e.target.value)}
                    >
                      {models.availableModels.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                          {model.name || model.modelId}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {efforts.length > 0 && <label className="chat-select chat-effort"><span className="chat-control-label">{t("chat.reasoning")}</span><select aria-label={t("chat.reasoningEffort")} value={currentEffort} disabled={settingsBusy || running || !ready || ended} onChange={(event) => changeModel(currentModel, event.target.value)}>
                  {!currentEffort && <option value="" disabled>{t("chat.default")}</option>}
                  {efforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{({ minimal: t("chat.effortMinimal"), low: t("chat.effortLow"), medium: t("chat.effortMedium"), high: t("chat.effortHigh"), xhigh: t("chat.effortXhigh"), max: t("chat.effortMax") } as Record<string, string>)[option.reasoningEffort] || option.reasoningEffort}</option>)}
                </select></label>}
                {state.modes && (
                  <label className="chat-select chat-permissions">
                    <span className="chat-control-label"><ShieldCheck size={12} /> {t("chat.permissions")}</span>
                    <select
                      aria-label={t("chat.permissions")}
                      value={state.modes.currentModeId}
                      disabled={settingsBusy || running || !ready || ended}
                      onChange={(e) => changeMode(e.target.value)}
                    >
                      {state.modes.availableModes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

              </div>
            )}
            {running && !ended ? (
              <span className="composer-run">
                <span className="composer-run-note">
                  <span className="live-dot working" aria-hidden="true" />
                  <span>{agentName} {stopping ? t("chat.stopping") : connection === "attention" ? t("chat.waitingApproval") : t("chat.agentRunning")}</span>
                  <RunTimer turnStart={turnStart} />
                </span>
                <button type="button" className="composer-stop" disabled={stopping} title={t("chat.stopTurn")}
                  onFocus={() => { runFocus.current = true; }} onBlur={(event) => { if (event.relatedTarget) runFocus.current = false; }}
                  onClick={() => {
                    if (Date.now() - sendClickedAt.current < 350) return;
                    runFocus.current = true;
                    setStopping(true);
                    void cancel();
                  }}><Square size={11} /><span>{t("chat.stop")}</span></button>
              </span>
            ) : (
              <button className="composer-send" disabled={sendBlocked || !draft.trim() || (draftBytes > 16000 || draft.length > 8000)} aria-label={t("chat.send")} title={sendBlocked ? sendHint : t("chat.sendMessage")}
                onFocus={() => { runFocus.current = true; }} onBlur={(event) => { if (event.relatedTarget) runFocus.current = false; }} onClick={() => { runFocus.current = true; sendClickedAt.current = Date.now(); }}>
                {sending ? <LoaderCircle className="chat-spinning" size={17} /> : <ArrowUp size={17} />}<span>{t("chat.send")}</span>
              </button>
            )}
          </div>
          {state.modes && <div className="chat-permission-note" role="status"><ShieldCheck size={13} /><span><strong>{currentMode?.name || t("chat.permissions")}</strong>{currentMode?.description ? ` · ${currentMode.description}` : ` · ${t("chat.modeApplied")}`}{running && t("chat.modeChangeAfterTurn")}</span></div>}
        </form>
        <div className="composer-note" id="chat-composer-hint" role="status">
          <span>{sendHint}</span>
          {(draftBytes > 14000 || draft.length > 7200) && <span className={draftBytes > 16000 || draft.length > 8000 ? "chat-byte-limit" : ""}>{draft.length.toLocaleString(getLocale())} / {(8000).toLocaleString(getLocale())} {t("chat.characters")} · {draftBytes.toLocaleString(getLocale())} / {(16000).toLocaleString(getLocale())} {t("chat.bytes")}{draftBytes > 16000 || draft.length > 8000 ? t("chat.shortenDraft") : ""}</span>}
        </div>
        {commands && commands.length > 0 && !running && (
          <div className="composer-note chat-commands">
            <>
              {t("chat.commands")}
              {commands.slice(0, 6).map((command) => (
                <button
                  key={command.name}
                  type="button"
                  className="cmd-chip"
                  title={command.description}
                  onClick={() => setDraft((current) => (current ? current : `/${command.name} `))}
                >
                  /{command.name}
                </button>
              ))}
            </>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// Keep measured space for offscreen rows; only nearby rows build Markdown/tools.
const ChatRow = React.memo(function ChatRow({ item, hit, current, awaiting, root, follow, initial }: {
  item: ChatItem; hit: boolean; current: boolean; awaiting: boolean;
  root: React.RefObject<HTMLDivElement | null>; follow: React.RefObject<boolean>; initial: boolean;
}) {
  useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(initial);
  const height = useRef(96);
  const detailsOpen = useRef<boolean[] | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) {
        // Preserve keyboard focus and expanded tool/thought cards while their
        // heavy contents are temporarily outside the viewport.
        if (el.contains(document.activeElement)) return;
        const details = [...el.querySelectorAll("details")];
        if (details.length) detailsOpen.current = details.map(detail => detail.open);
      }
      setVisible(entry.isIntersecting);
    }, {
      root: root.current, rootMargin: "800px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !(visible || current)) return;
    if (detailsOpen.current) el.querySelectorAll("details").forEach((detail, index) => {
      detail.open = detailsOpen.current?.[index] ?? detail.open;
    });
    detailsOpen.current = null;
    const measure = () => {
      height.current = el.getBoundingClientRect().height || height.current;
      if (follow.current && root.current) root.current.scrollTop = root.current.scrollHeight;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, current, item, follow, root]);
  function content() {
    switch (item.type) {
      case "user":
        return (
          <div className={`chat-msg user ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`} data-chat-key={item.key} key={item.key}>
            <div className="msg-body">{item.text}</div>
            <div className="chat-msg-actions"><CopyButton text={item.text} label={t("chat.copyMessage")} /></div>
          </div>
        );
      case "assistant":
        return (
          <div className={`chat-msg assistant ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`} data-chat-key={item.key} key={item.key}>
            <div className="chat-author"><Sparkles size={12} /> {t("chat.assistant")}</div>
            <div className="msg-body">{renderMarkdown(item.text)}</div>
            <div className="chat-msg-actions"><CopyButton text={item.text} label={t("chat.copyAnswer")} /></div>
          </div>
        );
      case "thought":
        return (
          <details className={`chat-msg thought ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`} data-chat-key={item.key} key={item.key}>
            <summary>{t("chat.thought")}</summary>
            <div className="msg-body">{item.text}</div>
          </details>
        );
      case "tool":
        return <div key={item.key} data-chat-key={item.key} className={`chat-tool-wrap ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`}><ToolCard tool={item.tool} awaiting={awaiting} /></div>;
      case "notice":
        return (
          <div key={item.key} data-chat-key={item.key} className={`chat-notice subtle ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`}>
            {itemText(item)}
          </div>
        );
      case "error":
        return (
          <div key={item.key} data-chat-key={item.key} className={`chat-notice error-note ${hit ? "chat-hit" : ""} ${current ? "chat-hit-current" : ""}`}>
            {item.text}
          </div>
        );
    }
  }
  return <div ref={host} data-chat-key={item.key} style={visible || current ? undefined : { height: height.current }}>
    {(visible || current) && content()}
  </div>;
});
