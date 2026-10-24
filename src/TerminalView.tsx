import { LanguageSelect } from "./LanguageSelect";
import { getLocale, messageText, useI18n, type TranslationKey, type UiMessage } from "./i18n";
import { stored, remember, sessionStorageFailed, storageWarning } from "./storage";
import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, History, ImagePlus, RotateCcw, TerminalSquare, Search, Settings2, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { characterRect, visibleAnchor, locateAnchor } from "./reader";
import ConvReader, { entryText, type ConvEntry, type Conversation } from "./ConvReader";
import { retainConversation } from "./convblocks";
import { TerminalOutputBuffer } from "./terminal-output";
import { bindTerminalMouseCoordinates } from "./terminal-mouse";
import { TERM_THEME, renderStyled, type Styled } from "./ansi";
import { updateBacklog } from "./backlog";
import BacklogLines from "./BacklogLines";
import type { JsonValidator } from "./revalidation";
import { DEFAULT_PREFS, FONT_RANGE, PREFS_KEY, computeScale, loadPrefs, normalizePrefs, serializePrefs, type TermPrefs } from "./termprefs";

import { snapshots, snapshotEpoch } from "./terminal-snapshots";
import { inSlot, type HeaderSlots } from "./header-slots";

type Request = <T>(url: string, method?: string, body?: unknown, validator?: JsonValidator) => Promise<T>;
type Scrollback = { text: string; alternate?: boolean } & Styled;
type Geometry = { cols: number; rows: number };
// The pane size is a property of the session, not of the browser window. These
// presets are the only way to change it; a viewer can never rewrap the pane.
const PRESETS: Array<Geometry & { id: string; label: TranslationKey }> = [
  { id: "mobil", label: "terminal.presetMobile", cols: 80, rows: 30 },
  { id: "standart", label: "terminal.presetStandard", cols: 120, rows: 34 },
  { id: "genis", label: "terminal.presetWide", cols: 160, rows: 42 },
  { id: "cok-genis", label: "terminal.presetExtraWide", cols: 200, rows: 50 },
];
const DEFAULT_GEOMETRY: Geometry = { cols: 120, rows: 34 };
const measureCanvas = document.createElement("canvas");
const TERM_FONT = '"Geist Mono Variable", ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", "Segoe UI Symbol", "Noto Sans Symbols 2", monospace';
export default function TerminalView({ session, onUnauthorized, request, slots }: {
  session: {id: string; status: string; agentId?: string; geometry?: Geometry}; onUnauthorized: () => void; request: Request; slots?: HeaderSlots;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null), scaled = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const host = useRef<HTMLDivElement>(null), socket = useRef<WebSocket | null>(null), term = useRef<Terminal | null>(null);
  const reader = useRef<HTMLPreElement>(null), reading = useRef(false), pending = useRef<{id: string; text: string} | null>(null);
  const draftKey = `panel-draft-${session.id}`;
  const [draft, setDraft] = useState(() => stored(draftKey, "", true));
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    if (composer.current) {
      composer.current.style.height = "auto";
      composer.current.style.height = `${Math.min(160, composer.current.scrollHeight)}px`;
    }
  }, [draft]);
  const [status, setStatus] = useState<TranslationKey>("terminal.statusConnecting"), [writer, setWriter] = useState(false);
  const [error, setError] = useState<UiMessage>(""), [notice, setNotice] = useState<UiMessage>(""), [sending, setSending] = useState(false);
  // Keystrokes go to the terminal while its input has focus, and to the composer otherwise.
  const [termFocused, setTermFocused] = useState(false);
  const cached = snapshots.get(session.id);
  const [readMode, setReadMode] = useState(session.status !== "running" || !!cached), [output, setOutput] = useState(cached?.text || "");
  const [styled, setStyled] = useState<Styled>(cached?.styled || {});
  const outputRef = useRef(output); outputRef.current = output; reading.current = readMode;
  const styledRef = useRef(styled); styledRef.current = styled;
  const [searchOpen, setSearchOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [keysOpen, setKeysOpen] = useState(false);
  const skipSearchJump = useRef(false);
  const [search, setSearch] = useState(""), [matchIndex, setMatchIndex] = useState(0);
  const [loading, setLoading] = useState(false), [newOutput, setNewOutput] = useState(false);
  const [conv, setConv] = useState<Conversation | null>(null), [readTab, setReadTab] = useState<"sohbet" | "ham">("sohbet");
  const convRef = useRef<HTMLDivElement>(null), convFirst = useRef(true), convAtBottom = useRef(true);
  const [prefs, setPrefs] = useState<TermPrefs>(() => loadPrefs(key => stored(key)));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const { fontSize } = prefs;
  const patchPrefs = useCallback((patch: Partial<TermPrefs>) => setPrefs(current => normalizePrefs({ ...current, ...patch })), []);
  const geometryChanging = useRef(false);
  const [geometryBusy, setGeometryBusy] = useState(false);
  const [geometry, setGeometry] = useState<Geometry>(() => session.geometry || DEFAULT_GEOMETRY);
  const loadInFlight = useRef(false), touchY = useRef(0), mounted = useRef(true);
  // Seamless live scrollback: the lines tmux has already scrolled off the pane
  // sit directly above the live terminal in the same scrolling frame, so the
  // wheel moves into history without switching to the reader.
  const backlog = useRef<HTMLPreElement>(null), pinned = useRef(true), backlogDirty = useRef(true), backlogBusy = useRef(false), alternate = useRef(false);
  const scrollbackValidator = useRef<JsonValidator<Scrollback>>({});
  const [scrollback, setScrollback] = useState(() => updateBacklog(undefined, "", {}));
  const [awayFromLive, setAwayFromLive] = useState(false);
  // A pane much wider than the screen scales to unreadable text; offer the reader.
  const [tiny, setTiny] = useState(false), [tinyOff, setTinyOff] = useState(() => stored("panel-tiny-hint") === "off");
  useEffect(() => { draftRef.current = draft; remember(draftKey, draft, true); }, [draft, draftKey]);
  // Size the terminal to the session geometry and scale it to the available
  // width. Scaling never touches the PTY, so nothing rewraps while reading.
  // The callbacks stay identity-stable so toggling fit never reconnects the socket.
  const syncView = useCallback(() => {
    const hostEl = host.current, frameEl = frame.current, scaledEl = scaled.current;
    const screenEl = hostEl?.querySelector<HTMLElement>(".xterm-screen");
    if (!hostEl || !frameEl || !scaledEl || !screenEl) return;
    const width = screenEl.offsetWidth, height = screenEl.offsetHeight;
    if (!width || !height) return;
    const style = getComputedStyle(frameEl);
    const available = Math.max(80, frameEl.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    const availableH = Math.max(80, frameEl.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
    const { fit, maxScale } = prefsRef.current;
    const scale = computeScale({ fit, fitHeight: window.innerWidth > 800, maxScale, width, height, availW: available, availH: availableH });
    hostEl.style.width = `${width}px`;
    hostEl.style.height = `${height}px`;
    hostEl.style.transform = `scale(${scale})`;
    setTiny(scale < 0.62);
    // The backlog uses the terminal's own cell grid: same font, cell height as
    // line height, and letter spacing that turns the glyph advance into the cell width.
    const terminal = term.current, backEl = backlog.current;
    let backH = 0;
    if (terminal && backEl && prefsRef.current.liveScrollback) {
      const cellW = width / terminal.cols, cellH = height / terminal.rows, fontSize = terminal.options.fontSize || 13;
      const ctx = measureCanvas.getContext("2d");
      if (ctx) { ctx.font = `${fontSize}px ${TERM_FONT}`; backEl.style.letterSpacing = `${cellW - ctx.measureText("M".repeat(40)).width / 40}px`; }
      backEl.style.fontSize = `${fontSize}px`;
      backEl.style.lineHeight = `${cellH}px`;
      backEl.style.setProperty("--cell-h", `${cellH}px`);
      backEl.style.setProperty("--cell-w", `${cellW}px`);
      backEl.style.width = `${width}px`;
      backEl.style.transform = `scale(${scale})`;
      backH = backEl.firstChild ? backEl.offsetHeight : 0;
    }
    hostEl.style.top = `${Math.round(backH * scale)}px`;
    scaledEl.style.width = `${Math.round(width * scale)}px`;
    scaledEl.style.height = `${Math.round((backH + height) * scale)}px`;
    if (pinned.current) frameEl.scrollTop = frameEl.scrollHeight;
  }, []);
  const syncSoon = useCallback(() => {
    requestAnimationFrame(() => { syncView(); setTimeout(syncView, 60); });
  }, [syncView]);
  const loadScrollback = useCallback(async () => {
    if (backlogBusy.current || session.status !== "running" || !prefsRef.current.liveScrollback) return;
    backlogBusy.current = true; backlogDirty.current = false;
    try {
      const before = scrollbackValidator.current.data;
      const r = await request<Scrollback>(`/sessions/${session.id}/scrollback`, "GET", undefined, scrollbackValidator.current);
      if (!mounted.current) return;
      alternate.current = !!r.alternate;
      if (r !== before) setScrollback(current => updateBacklog(current, r.text, r));
    } catch { /* The live terminal keeps working without its backlog. */ }
    finally { backlogBusy.current = false; }
  }, [request, session.id, session.status]);
  // Re-measure after every backlog change; a viewer at the bottom stays on the
  // live screen, one reading above keeps their scroll position.
  useLayoutEffect(() => { syncView(); }, [scrollback, syncView]);
  // Output moves lines into tmux history; refresh the backlog shortly after.
  useEffect(() => {
    if (session.status !== "running") return;
    const timer = setInterval(() => { if (backlogDirty.current && !document.hidden && !reading.current) void loadScrollback(); }, 1500);
    return () => clearInterval(timer);
  }, [session.status, loadScrollback]);
  const backlogNodes = useMemo(() => <BacklogLines document={scrollback}/>, [scrollback]);
  function toLive() {
    const el = frame.current;
    pinned.current = true; setAwayFromLive(false);
    if (el) el.scrollTop = el.scrollHeight;
    term.current?.focus();
  }
  // Claude Code and Codex terminals have a conversation log; others (and
  // ambiguous matches) answer `available: false` and keep the raw output.
  // A background refresh keeps what is shown when the log is briefly unreadable.
  const loadConversation = useCallback(async (background = false) => {
    if (session.agentId && session.agentId !== "claude" && session.agentId !== "codex") return;
    try {
      const r = await request<{ available: boolean; entries?: ConvEntry[]; partial?: boolean }>(`/sessions/${session.id}/conversation`);
      if (!mounted.current) return;
      const next = r.available && r.entries?.length ? { entries: r.entries, partial: !!r.partial } : null;
      if (background && !next) return;
      setConv(current => retainConversation(current, next));
    } catch { if (mounted.current && !background) setConv(null); }
  }, [request, session.id, session.agentId]);
  // Keyboard paging for whichever reader surface is showing; PageDown/End at
  // the very bottom hands control back to the live terminal.
  const pageScroll = useRef<(key: string) => void>(() => {});
  pageScroll.current = (key: string) => {
    const el = showConv ? convRef.current : reader.current;
    if (!el) return;
    const page = Math.max(40, el.clientHeight - 40);
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 4;
    if (key === "PageUp") el.scrollTop -= page;
    else if (key === "Home") el.scrollTop = 0;
    else if (atBottom) live();
    else if (key === "End") el.scrollTop = el.scrollHeight;
    else el.scrollTop += page;
  };
  const readHistory = useCallback(async (fromWheel = false) => {
    if (loadInFlight.current) return;
    loadInFlight.current = true; setLoading(true); setError("");
    // Freeze the viewport while fetching; a live redraw cannot move the
    // immutable snapshot, and refreshes never replace it without an anchor.
    const previous = outputRef.current;
    const liveTerm = term.current;
    const viewport = liveTerm?.buffer.active;
    let visibleLine = "";
    let visibleRow = 0;
    if (!reading.current && viewport && liveTerm) {
      for (let row = 0; row < liveTerm.rows; row++) {
        const line = viewport.getLine(viewport.viewportY + row)?.translateToString(true).trim();
        if (line && line.length > 8) { visibleLine = line; visibleRow = row; break; }
      }
    }
    try {
      const result = await request<{text: string; saved: boolean; source?: string} & Styled>(`/sessions/${session.id}/output`);
      if (!mounted.current) return;
      // The user may keep scrolling while the request is in flight. Capture
      // the current position only now, never pull them back to request time.
      const anchor = reading.current && reader.current && previous
        ? visibleAnchor(reader.current, previous) : null;
      const oldTop = reader.current?.scrollTop || 0;
      const at = anchor ? locateAnchor(result.text, anchor) : null;
      if (anchor && result.text !== previous && at === null) {
        setNotice({ key: "terminal.historyAnchorLost" });
        return;
      }
      skipSearchJump.current = result.text !== previous;
      setOutput(result.text); setStyled({ styles: result.styles, runs: result.runs }); setReadMode(true); reading.current = true; setNewOutput(false);
      void loadConversation();
      requestAnimationFrame(() => {
        if (!reader.current) return;
        if (anchor && at !== null) {
          reader.current.scrollTop = oldTop;
          const rect = characterRect(reader.current, at);
          if (rect) reader.current.scrollTop += rect.top - reader.current.getBoundingClientRect().top - anchor.pixel;
        } else if (anchor) {
          reader.current.scrollTop = oldTop;
        } else {
          const liveAt = visibleLine ? result.text.lastIndexOf(visibleLine) : -1;
          reader.current.scrollTop = 0;
          const rect = liveAt >= 0 ? characterRect(reader.current, liveAt) : null;
          const lineHeight = parseFloat(getComputedStyle(reader.current).lineHeight);
          reader.current.scrollTop = rect
            ? rect.top - reader.current.getBoundingClientRect().top - visibleRow * lineHeight
            : reader.current.scrollHeight - reader.current.clientHeight;
          if (fromWheel) reader.current.scrollTop -= lineHeight * 3;
        }
      });
    } catch (e) { if (mounted.current) setError(e as Error); }
    finally { loadInFlight.current = false; if (mounted.current) setLoading(false); }
  }, [request, session.id, loadConversation]);
  const matches = useMemo(() => {
    if (!search.trim()) return [];
    const haystack = output.toLocaleLowerCase(getLocale()), needle = search.toLocaleLowerCase(getLocale()), found: number[] = [];
    let offset = 0;
    while (found.length < 2000) { const index = haystack.indexOf(needle, offset); if (index < 0) break; found.push(index); offset = index + needle.length; }
    return found;
  }, [output, search, getLocale()]);
  const showConv = readMode && !!conv && readTab === "sohbet";
  const convMatches = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(getLocale());
    if (!showConv || !needle || !conv) return [] as number[];
    return conv.entries.flatMap((e, i) => (entryText(e).toLocaleLowerCase(getLocale()).includes(needle) ? [i] : []));
  }, [conv, search, showConv, getLocale()]);
  const matchCount = showConv ? convMatches.length : matches.length;
  useEffect(() => { setMatchIndex(0); }, [search, readTab]);
  useEffect(() => {
    if (skipSearchJump.current) { skipSearchJump.current = false; return; }
    if (showConv) {
      if (search && convMatches.length) convRef.current?.querySelector(".conv-current")?.scrollIntoView({block:"center"});
      return;
    }
    if (search && matches.length) reader.current?.querySelector(`mark[data-match="${matchIndex % matches.length}"]`)?.scrollIntoView({block:"center"});
  }, [search, matches, matchIndex, showConv, convMatches]);
  // The log opens at its newest message. Later refreshes keep the reading
  // position, except a reader already at the bottom follows new messages.
  useLayoutEffect(() => {
    const el = convRef.current;
    if (showConv && el && (convFirst.current || convAtBottom.current)) { el.scrollTop = el.scrollHeight; convFirst.current = false; convAtBottom.current = true; }
    if (!showConv) convFirst.current = true;
  }, [showConv, conv]);
  // While the chat view is open on a running session it follows the agent:
  // the log is re-read every few seconds, only after new terminal output.
  const outputSeen = useRef(false);
  useEffect(() => {
    if (!showConv || session.status !== "running") return;
    const timer = setInterval(() => {
      if (!outputSeen.current || document.hidden) return;
      outputSeen.current = false;
      void loadConversation(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [showConv, session.status, loadConversation]);
  // Colour runs and search marks share one pass; the text nodes always add up
  // to the plain output, so anchors and offsets ignore the colouring.
  const highlighted = useMemo(() => {
    if (!output) return t("terminal.noSavedOutput");
    if (!matches.length && !styled.runs?.length) return output;
    return renderStyled(output, styled, matches, search.length, matches.length ? matchIndex % matches.length : -1);
  }, [output, styled, matches, matchIndex, search, t]);
  const liveRef = useRef<() => void>(() => {});
  liveRef.current = () => live();
  const toLiveRef = useRef<() => void>(() => {});
  toLiveRef.current = () => toLive();
  // Reader keys while it has focus: Esc back to live, "/" opens search.
  function readerKeys(e: React.KeyboardEvent) {
    if (!readMode || e.ctrlKey || e.altKey || e.metaKey || (e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "Escape" && session.status === "running") { e.preventDefault(); live(); }
    else if (e.key === "/") { e.preventDefault(); setSearchOpen(true); }
  }
  function live() {
    setReadMode(false); reading.current = false; setNewOutput(false); snapshots.delete(session.id);
    pinned.current = true; setAwayFromLive(false); backlogDirty.current = true;
    requestAnimationFrame(() => { term.current?.scrollToBottom(); term.current?.focus(); syncView(); });
  }
  useEffect(() => {
    mounted.current = true;
    const epoch = snapshotEpoch;
    const saved = snapshots.get(session.id);
    if (saved && reader.current) reader.current.scrollTop = saved.top;
    return () => {
      mounted.current = false;
      if (epoch === snapshotEpoch && reading.current && outputRef.current) {
        snapshots.delete(session.id);
        snapshots.set(session.id, {text: outputRef.current, styled: styledRef.current, top: reader.current?.scrollTop ?? snapshots.get(session.id)?.top ?? 0});
        if (snapshots.size > 6) snapshots.delete(snapshots.keys().next().value!);
      }
    };
  }, []);
  useEffect(() => {
    if (session.status !== "running") { setWriter(false); setStatus("terminal.statusEnded"); readHistory(); }
  }, [session.status, readHistory]);
  // Coming back to a session whose reader was already open (cached snapshot)
  // must show the chat view as well, not only the raw snapshot.
  useEffect(() => { if (reading.current && session.status === "running") void loadConversation(); }, []);
  useEffect(() => {
    let disposed = false, retry: ReturnType<typeof setTimeout> | undefined, attempt = 0;
    const geometry = session.geometry || DEFAULT_GEOMETRY;
    const terminal = new Terminal({
      screenReaderMode: true,
      fontFamily: TERM_FONT, fontSize: prefsRef.current.fontSize, lineHeight: prefsRef.current.lineHeight, cursorStyle: prefsRef.current.cursor,
      cursorBlink: true, scrollback: prefsRef.current.liveScrollback ? 0 : 5000, convertEol: false,
      cols: geometry.cols, rows: geometry.rows,
      theme: TERM_THEME, allowProposedApi: true,
    });
    // tmux measures wide characters with current Unicode tables; xterm's
    // default (Unicode 6) disagrees on symbols agent TUIs use, which shifts
    // borders and the cursor. Links open in a new tab, never in the panel.
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      event.preventDefault(); window.open(uri, "_blank", "noopener,noreferrer");
    }));
    terminal.open(host.current!); term.current = terminal;
    const disposeMouseCoordinates = bindTerminalMouseCoordinates(terminal.element!, host.current!.querySelector<HTMLElement>(".xterm-screen")!);
    const termInput = terminal.textarea;
    const onTermFocus = () => setTermFocused(true), onTermBlur = () => setTermFocused(false);
    termInput?.addEventListener("focus", onTermFocus); termInput?.addEventListener("blur", onTermBlur);
    syncSoon();
    // Geist Mono must be loaded before xterm measures a cell; re-assigning the
    // family after load forces a re-measure, then the usual scale sync runs.
    document.fonts?.load(`13px ${TERM_FONT.split(",")[0]}`).then(() => document.fonts.ready).then(() => {
      if (disposed || term.current !== terminal) return;
      terminal.options.fontFamily = TERM_FONT;
      syncSoon();
    }).catch(() => {});
    const send = (data: unknown) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(data)); };
    const observer = new ResizeObserver(() => syncSoon()); observer.observe(frame.current!);
    const outputBuffer = new TerminalOutputBuffer(data => terminal.write(data));
    // Focus and mouse reports (tmux asks for focus events) are not typing; a
    // click on backlog text blurs the terminal and must not jump to live.
    const input = terminal.onData(data => {
      if (reading.current) return;
      if (!/^\x1b\[(?:[IO]$|<|M)/.test(data)) {
        outputBuffer.input();
        if (!pinned.current) toLiveRef.current();
      }
      send({type: "input", data});
    });
    // The wheel scrolls the frame (backlog + live screen) like a terminal's
    // own scrollback; the reader is only opened explicitly.
    terminal.attachCustomWheelEventHandler(e => {
      // Off, or a full-screen program without tmux history: the reader, as before.
      if (!prefsRef.current.liveScrollback || (alternate.current && pinned.current)) {
        if (e.deltaY < 0) { readHistory(true); return false; }
        return true;
      }
      const el = frame.current;
      if (!el) return false;
      if (e.deltaY < 0 && pinned.current) void loadScrollback();
      const unit = e.deltaMode === 1 ? (el.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect().height || 400) / terminal.rows : e.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollTop += e.deltaY * unit;
      e.preventDefault();
      return false;
    });
    // Live terminal: plain PageUp/PageDown go to the TUI (Codex/Claude scroll
    // themselves). Only Shift+PageUp opens the reader. Inside the reader the
    // paging keys work regardless of focus, because the terminal swallows input.
    terminal.attachCustomKeyEventHandler(e => {
      if (e.type !== "keydown" || e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key;
      if (!reading.current) {
        if (k === "PageUp" && e.shiftKey) {
          void readHistory(true).then(() => requestAnimationFrame(() => requestAnimationFrame(() => pageScroll.current("PageUp"))));
          return false;
        }
        return true;
      }
      if (k === "PageUp" || k === "PageDown" || k === "Home" || k === "End") { pageScroll.current(k); return false; }
      if (k === "Escape" && session.status === "running") { liveRef.current(); return false; }
      return true;
    });
    async function connect() {
      if (disposed || session.status !== "running") return;
      setStatus(attempt ? "terminal.statusReconnecting" : "terminal.statusConnecting"); setWriter(false);
      try {
        const d = await request<{ticket: string}>(`/sessions/${session.id}/ticket`, "POST", {});
        if (disposed) return;
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/terminal`, `panel-ticket.${d.ticket}`);
        socket.current = ws;
        ws.onopen = () => {
          if (disposed) { ws.close(); return; }
          attempt = 0; setStatus("terminal.statusConnected"); terminal.reset(); syncSoon(); backlogDirty.current = true; void loadScrollback();
        };
        ws.onmessage = e => {
          if (disposed) return;
          const data = JSON.parse(e.data);
          if (data.type === "output" && typeof data.data === "string") {
            outputBuffer.push(data.data);
            backlogDirty.current = true;
            if (reading.current) { setNewOutput(true); outputSeen.current = true; }
          }
          if (data.type === "geometry" && Number.isInteger(data.cols) && Number.isInteger(data.rows)) {
            // The server is authoritative: adopt its size, never request our own.
            const next = { cols: data.cols, rows: data.rows };
            setGeometry(current => current.cols === next.cols && current.rows === next.rows ? current : next);
            if (terminal.cols !== next.cols || terminal.rows !== next.rows) terminal.resize(next.cols, next.rows);
            syncSoon();
          }
          if (data.type === "role") { setWriter(data.writer); terminal.options.disableStdin = !data.writer; if (data.writer) syncSoon(); }
          if (data.type === "input-accepted" && pending.current?.id === data.requestId) {
            const sent = pending.current!.text; pending.current = null; setSending(false); setError("");
            setDraft(current => current === sent ? "" : current); setNotice({ key: "terminal.delivered" });
          }
          if (data.type === "input-rejected" && pending.current?.id === data.requestId) {
            pending.current = null; setSending(false); setError({ key: "terminal.otherWindowControl" });
          }
          if (data.type === "detached") setStatus("terminal.statusDetached");
        };
        ws.onclose = e => {
          if (disposed) return;
          setWriter(false);
          if (e.reason) setError({ reason: e.reason });
          if (pending.current) { pending.current = null; setSending(false); setError({ key: "terminal.uncertainDelivery" }); }
          if (e.code === 4001) { onUnauthorized(); return; }
          if (e.code === 4004) { setStatus("terminal.statusEnded"); readHistory(); return; }
          setStatus("terminal.statusDisconnected"); retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
        };
        ws.onerror = () => { if (!disposed) setStatus("terminal.statusReconnecting"); };
      } catch (e) {
        if (!disposed) { setError(e as Error); setStatus("terminal.statusUnavailable"); retry = setTimeout(connect, 5000); }
      }
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); disposeMouseCoordinates(); outputBuffer.dispose(); observer.disconnect(); input.dispose(); termInput?.removeEventListener("focus", onTermFocus); termInput?.removeEventListener("blur", onTermBlur); setTermFocused(false); socket.current?.close(); socket.current = null; term.current = null; terminal.dispose(); };
    // Font changes re-render the existing terminal; they must not reconnect it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.status, onUnauthorized, request, readHistory, syncSoon, loadScrollback]);
  useEffect(() => {
    const terminal = term.current;
    if (terminal) {
      terminal.options.fontSize = prefs.fontSize; terminal.options.lineHeight = prefs.lineHeight; terminal.options.cursorStyle = prefs.cursor;
    }
    remember(PREFS_KEY, serializePrefs(prefs));
    syncSoon();
  }, [prefs, syncSoon]);
  useEffect(() => { syncSoon(); }, [prefs.density, prefs.composer, prefs.showStatus, prefs.showHints, prefs.showComposer, syncSoon]);
  useEffect(() => {
    if (term.current) term.current.options.scrollback = prefs.liveScrollback ? 0 : 5000;
    pinned.current = true; setAwayFromLive(false);
    if (prefs.liveScrollback) { backlogDirty.current = true; void loadScrollback(); }
    syncSoon();
  }, [prefs.liveScrollback, loadScrollback, syncSoon]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [settingsOpen]);
  async function changeGeometry(id: string) {
    if (geometryChanging.current) return;
    const preset = PRESETS.find(p => p.id === id);
    if (!preset) return;
    setError("");
    const next = { cols: preset.cols, rows: preset.rows };
    geometryChanging.current = true; setGeometryBusy(true);
    try {
      await request(`/sessions/${session.id}/geometry`, "POST", next);
      setGeometry(next);
      if (term.current) { term.current.resize(next.cols, next.rows); syncSoon(); }
    } catch (e) { setError(e as Error); }
    finally { geometryChanging.current = false; setGeometryBusy(false); }
  }
  useEffect(() => {
    if (!sending) return;
    const timeout = setTimeout(() => { pending.current = null; setSending(false); setError({ key: "terminal.deliveryUnconfirmed" }); }, 8000);
    return () => clearTimeout(timeout);
  }, [sending]);
  const canWrite = writer && status === "terminal.statusConnected";
  const presetId = PRESETS.find(p => p.cols === geometry.cols && p.rows === geometry.rows)?.id || "ozel";
  function write(data: string) {
    if (canWrite && !reading.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({type: "input", data}));
  }
  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    if (!canWrite || socket.current?.readyState !== WebSocket.OPEN) { setError({ key: "terminal.connectionNotReady" }); return; }
    const text = draft.replace(/\r\n?/g, "\n");
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) { setError({ key: "terminal.unsupportedControlCharacter" }); return; }
    if (text.includes("\n") && !term.current?.modes.bracketedPasteMode) {
      setError({ key: "terminal.multilinePasteUnsupported" }); return;
    }
    const data = (term.current?.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text) + "\r";
    if (data.length > 16384 || new TextEncoder().encode(data).length > 24000) { setError({ key: "terminal.messageTooLong" }); return; }
    const id = crypto.randomUUID(); pending.current = {id, text: draft}; setSending(true); setNotice(""); setError("");
    socket.current.send(JSON.stringify({type: "input", data, requestId: id}));
  }
  async function copy() {
    const text = window.getSelection()?.toString() || term.current?.getSelection();
    if (!text) { setNotice({ key: "terminal.selectTextToCopy" }); return; }
    try { await navigator.clipboard.writeText(text); setNotice({ key: "terminal.selectionCopied" }); }
    catch { setNotice({ key: "terminal.clipboardDenied" }); }
  }
  const fileInput = useRef<HTMLInputElement>(null);
  // Images go to the panel's private upload folder; the agent reads them by
  // path, so the path is appended to the draft for the user to review.
  async function attachImages(files: File[]) {
    const images = files.filter(f => f.type.startsWith("image/"));
    if (!images.length) return;
    setNotice({ key: "terminal.uploadingImage" });
    try {
      for (const f of images) {
        const { path } = await request<{path: string}>("/uploads", "POST", f);
        setDraft(d => `${d}${d && !/\s$/.test(d) ? " " : ""}${path} `);
      }
      setNotice(""); composer.current?.focus();
    } catch (e) { setNotice(e as Error); }
  }
  const hint = prefs.sendKey === "enter" ? t("terminal.sendEnterHint") : t("terminal.sendCtrlEnterHint");
  const noteText = sending ? t("terminal.sending") : notice ? messageText(notice) : termFocused && canWrite ? t("terminal.terminalFocused") : prefs.showHints ? hint : "";
  const statusLabel = t(status);
  const roleLabel = writer ? t("terminal.controlOwner") : t("terminal.watchMode");
  const statusText = `${statusLabel} · ${roleLabel} · ${geometry.cols}×${geometry.rows}`;
  return <div className={`terminal-section density-${prefs.density} composer-${prefs.composer}`}>
    {inSlot(
      <span className={`terminal-caption${prefs.showStatus && prefs.density !== "focus" ? "" : " status-quiet"}`} role="status" aria-label={statusText} title={statusText}>
        <span className={`live-dot ${status === "terminal.statusConnected" ? "" : "offline"}`} /><span className="status-text"><span className="caption-status">{statusLabel}</span>{writer ? <span className="sr-only">{t("terminal.controlOwner")}</span> : <><span className="caption-divider" aria-hidden="true"/>{t("terminal.watchMode")}</>}</span>
      </span>,
      slots?.status,
    )}
    {inSlot(
      <div className="reading-toolbar">
        {!writer && status === "terminal.statusConnected" && <button className="take-control" onClick={() => socket.current?.send(JSON.stringify({type:"control"}))}>{t("terminal.takeControl")}</button>}
        <span className="view-switch" role="group" aria-label={t("terminal.mode")}>
          <button type="button" aria-pressed={!readMode} className={readMode ? "" : "chosen"} disabled={session.status !== "running"} onClick={live} title={t("terminal.returnLive")}><span className="live-dot" aria-hidden="true"/>{t("terminal.live")}</button>
          <button type="button" aria-pressed={readMode} className={readMode ? "chosen" : ""} onClick={() => readHistory()} disabled={loading}
            aria-label={t(loading ? "terminal.loading" : readMode ? "terminal.refreshHistory" : "terminal.readHistory")} title={t(readMode ? "terminal.refreshHistory" : "terminal.readHistory")}><History size={15}/>{loading ? t("terminal.loading") : t("terminal.history")}</button>
        </span>
        {readMode && conv && <span className="read-tabs" role="group" aria-label={t("terminal.historyView")}>
          <button type="button" className={readTab === "sohbet" ? "chosen" : ""} aria-pressed={readTab === "sohbet"} onClick={() => setReadTab("sohbet")}>{t("terminal.chat")}</button>
          <button type="button" className={readTab === "ham" ? "chosen" : ""} aria-pressed={readTab === "ham"} onClick={() => setReadTab("ham")}>{t("terminal.rawOutput")}</button>
        </span>}
        <button aria-label={t("terminal.openOutputSearch")} aria-expanded={searchOpen} onClick={() => {setSearchOpen(v => !v); if (!reading.current) readHistory();}}><Search size={15}/></button>
        <button aria-label={t("terminal.viewSettings")} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(v => !v)}><Settings2 size={15}/></button>
        <button onClick={copy} title={t("terminal.copySelection")} aria-label={t("terminal.copySelection")}><Copy size={15}/></button>
        {settingsOpen && <TerminalSettings prefs={prefs} patch={patchPrefs} reset={() => setPrefs(DEFAULT_PREFS)} close={() => setSettingsOpen(false)}
          presetId={presetId} geometry={geometry} canResize={session.status === "running" && !geometryBusy} changeGeometry={changeGeometry}/>}
      </div>,
      slots?.tools,
    )}
    {sessionStorageFailed() && <div role="status" className="terminal-error">{storageWarning()}</div>}
    {error && <div role="alert" className="error terminal-error">{messageText(error)}</div>}
    {searchOpen && <div className="history-search">
      <Search size={15}/><input autoFocus aria-label={t("terminal.searchOutput")} placeholder={t("terminal.searchOutputPlaceholder")} value={search} onChange={e => setSearch(e.target.value)}/>
      <span>{search ? matchCount ? `${matchIndex % matchCount+1} / ${matchCount}${matchCount === 2000 ? "+" : ""}` : t("terminal.noMatch") : ""}</span>
      <button aria-label={t("terminal.previousMatch")} disabled={!matchCount} onClick={() => setMatchIndex(v => (v-1+matchCount) % matchCount)}><ArrowUp size={15}/></button>
      <button aria-label={t("terminal.nextMatch")} disabled={!matchCount} onClick={() => setMatchIndex(v => (v+1) % matchCount)}><ArrowDown size={15}/></button>
      <button aria-label={t("terminal.closeSearch")} onClick={() => {setSearchOpen(false); setSearch("");}}><X size={15}/></button>
    </div>}
    <div className={`terminal-stage${showConv && conv ? " showing-conv" : ""}`} onKeyDown={readerKeys} onTouchStart={e => {touchY.current=e.touches[0].clientY;}} onTouchMove={e => { if (reading.current || e.touches[0].clientY-touchY.current <= 25) return; if (!prefs.liveScrollback || alternate.current) readHistory(true); else if (pinned.current) void loadScrollback(); }}>
      <div className="terminal-frame" ref={frame} onScroll={() => {
        const el = frame.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 4;
        if (atBottom !== pinned.current) { pinned.current = atBottom; setAwayFromLive(!atBottom); }
      }}>
        <div className="terminal-scaled" ref={scaled}>
          <pre className={`live-backlog ${readMode ? "reading-hidden" : ""}`} aria-label={t("terminal.previousLines")} ref={backlog} style={{fontFamily: TERM_FONT}}>{prefs.liveScrollback ? backlogNodes : null}</pre>
          <div className={`terminal-host ${readMode ? "reading-hidden" : ""}`} ref={host}/>
        </div>
      </div>
      {showConv && conv && <ConvReader conv={conv} hits={convMatches} current={convMatches.length ? matchIndex % convMatches.length : -1} scrollRef={convRef}
        onScroll={() => { const el = convRef.current; if (el) convAtBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40; }}/>}
      {readMode && <pre className={`history-reader${showConv ? " tab-hidden" : ""}`} aria-hidden={showConv || undefined} tabIndex={showConv ? -1 : 0} role="region" aria-label={t("terminal.historyLabel")} ref={reader} style={{fontSize}} onScroll={() => { if (reading.current) snapshots.set(session.id, {text: outputRef.current, styled: styledRef.current, top: reader.current?.scrollTop || 0}); }}>{highlighted}</pre>}
      {tiny && !tinyOff && !readMode && <div className="tiny-hint" role="note">
        <span>{t("terminal.tinyText")}</span>
        <button type="button" onClick={() => readHistory()}>{session.agentId === "claude" || session.agentId === "codex" ? t("terminal.readAsChat") : t("terminal.readHistory")}</button>
        <button type="button" aria-label={t("terminal.hideHint")} onClick={() => { setTinyOff(true); remember("panel-tiny-hint", "off"); }}><X size={14}/></button>
      </div>}
      {!readMode && awayFromLive && session.status === "running" && <button className="reader-jump" onClick={toLive} title={t("terminal.goToLiveScreen")}><ArrowDown size={14}/>{t("terminal.goToLive")}</button>}
      {readMode && session.status === "running" && <button className="reader-jump" onClick={live} title={t("terminal.returnLiveEsc")}><ArrowDown size={14}/>{newOutput ? t("terminal.newOutputReturnLive") : t("terminal.returnLiveButton")}</button>}
    </div>
    <div className="terminal-tools">
      <button className="terminal-keys-toggle" aria-expanded={keysOpen} onClick={() => setKeysOpen(v => !v)}><TerminalSquare size={14}/>{t("terminal.keyButtonsLabel")}</button>
      <div className={`key-tools ${keysOpen ? "keys-open" : ""}`}>
        {[{label:"Esc", value:"\x1b"},{label:"Tab",value:"\t"},{label:"Enter",value:"\r",name:t("terminal.sendEnterToTerminal")},{label:<ArrowUp size={14}/>,value:"\x1b[A", name:t("terminal.upArrow")},{label:<ArrowDown size={14}/>,value:"\x1b[B",name:t("terminal.downArrow")},{label:<ArrowLeft size={14}/>,value:"\x1b[D",name:t("terminal.leftArrow")},{label:<ArrowRight size={14}/>,value:"\x1b[C",name:t("terminal.rightArrow")},{label:"PgUp",value:"\x1b[5~",name:t("terminal.sendPageUp")},{label:"PgDn",value:"\x1b[6~",name:t("terminal.sendPageDown")},{label:"Ctrl+T",value:"\x14",name:t("terminal.sendCtrlT")},{label:"Ctrl+C",value:"\x03",name:t("terminal.sendCtrlC")}].map((key,i) => <button key={i} disabled={!canWrite || readMode} aria-label={key.name} onClick={() => write(key.value)}>{key.label}</button>)}
        <button disabled={!canWrite} onClick={live} title={t("terminal.focusTerminal")} aria-label={t("terminal.focusTerminal")}><TerminalSquare size={14}/></button>
      </div>
      {prefs.showComposer && <form className="composer" onSubmit={submit}>
        <textarea ref={composer} rows={prefs.composer === "slim" ? 1 : 2} maxLength={12000} aria-label={t("terminal.messageOrCommand")} placeholder={t(canWrite ? "terminal.messagePlaceholder" : "terminal.draftPlaceholder")} value={draft}
          onChange={e => { setDraft(e.target.value); setNotice(""); }}
          onPaste={e => { const f = [...e.clipboardData.files]; if (f.some(x => x.type.startsWith("image/"))) { e.preventDefault(); void attachImages(f); } }}
          onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
          onDrop={e => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); void attachImages(f); } }}
          onKeyDown={e => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const send = prefs.sendKey === "enter" ? !e.shiftKey : e.ctrlKey || e.metaKey;
            if (send) { e.preventDefault(); submit(); }
          }}/>
        <div className="composer-bar"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => { void attachImages([...(e.target.files || [])]); e.target.value = ""; }}/><button type="button" className="composer-attach" aria-label={t("terminal.addImage")} title={t("terminal.addImageHelp")} onClick={() => fileInput.current?.click()}><ImagePlus size={17}/></button><span className="composer-bar-note">{t(canWrite ? "terminal.willSendToTerminal" : "terminal.waitingForConnection")}</span><button className="composer-send" disabled={!canWrite || !draft.trim() || sending} aria-label={t("terminal.send")}><ArrowUp size={17}/></button></div>
      </form>}
      {prefs.showComposer && <div className="composer-note" role="status">{noteText}</div>}
    </div>
  </div>;
}

function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void;
}) {
  return <div className="pref-row" role="group" aria-label={label}>
    <span className="pref-label">{label}</span>
    <div className="pref-segments">
      {options.map(o => <button key={String(o.value)} type="button" className={o.value === value ? "chosen" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  </div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="pref-row pref-switch">
    <span className="pref-label">{label}</span>
    <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)}/>
  </label>;
}

function TerminalSettings({ prefs, patch, reset, close, presetId, geometry, canResize, changeGeometry }: {
  prefs: TermPrefs; patch: (patch: Partial<TermPrefs>) => void; reset: () => void; close: () => void;
  presetId: string; geometry: Geometry; canResize: boolean; changeGeometry: (id: string) => void;
}) {
  const { t } = useI18n();
  return <div className="terminal-settings" role="dialog" aria-label={t("terminal.terminalView")}>
    <div className="pref-head"><strong>{t("terminal.view")}</strong>
      <button type="button" className="pref-reset" onClick={reset}><RotateCcw size={13}/>{t("terminal.resetDefaults")}</button>
      <button type="button" aria-label={t("terminal.closeSettings")} onClick={close}><X size={15}/></button>
    </div>
    <LanguageSelect />
    <Segmented label={t("terminal.density")} value={prefs.density} onChange={density => patch({ density })}
      options={[{ value: "comfortable", label: t("terminal.comfortable") }, { value: "compact", label: t("terminal.compact") }, { value: "focus", label: t("terminal.focus") }]}/>
    <div className="pref-section">{t("main.terminal")}</div>
    <div className="pref-row">
      <span className="pref-label">{t("terminal.fontSize")}</span>
      <div className="pref-stepper">
        <button type="button" aria-label={t("terminal.decreaseFont")} disabled={prefs.fontSize <= FONT_RANGE.min} onClick={() => patch({ fontSize: prefs.fontSize - 1 })}>A−</button>
        <span>{prefs.fontSize}</span>
        <button type="button" aria-label={t("terminal.increaseFont")} disabled={prefs.fontSize >= FONT_RANGE.max} onClick={() => patch({ fontSize: prefs.fontSize + 1 })}>A+</button>
      </div>
    </div>
    <Segmented label={t("terminal.lineSpacing")} value={prefs.lineHeight} onChange={lineHeight => patch({ lineHeight })}
      options={[{ value: 1.2, label: t("terminal.tight") }, { value: 1.4, label: t("terminal.normal") }, { value: 1.6, label: t("terminal.spacious") }]}/>
    <Segmented label={t("terminal.cursor")} value={prefs.cursor} onChange={cursor => patch({ cursor })}
      options={[{ value: "block", label: t("terminal.block") }, { value: "bar", label: t("terminal.bar") }, { value: "underline", label: t("terminal.underline") }]}/>
    <Switch label={t("terminal.fitWidth")} checked={prefs.fit} onChange={fit => patch({ fit })}/>
    <Switch label={t("terminal.liveScrollback")} checked={prefs.liveScrollback} onChange={liveScrollback => patch({ liveScrollback })}/>
    {prefs.fit && <Segmented label={t("terminal.zoomLimit")} value={prefs.maxScale} onChange={maxScale => patch({ maxScale })}
      options={[{ value: 1, label: t("terminal.zoomOne") }, { value: 1.2, label: t("terminal.zoomOneTwo") }, { value: 1.5, label: t("terminal.zoomOneFive") }, { value: 2, label: t("terminal.zoomTwo") }]}/>}
    <div className="pref-row">
      <span className="pref-label">{t("terminal.sessionSize")}</span>
      <select aria-label={t("terminal.terminalSize")} value={presetId} disabled={!canResize} onChange={e => changeGeometry(e.target.value)}>
        {PRESETS.map(p => <option key={p.id} value={p.id}>{t(p.label)} {p.cols}×{p.rows}</option>)}
        {presetId === "ozel" && <option value="ozel">{t("terminal.customSize", { cols: geometry.cols, rows: geometry.rows })}</option>}
      </select>
    </div>
    <div className="pref-note">{t("terminal.sessionSizeHelp")}</div>
    <div className="pref-section">{t("terminal.layoutBehavior")}</div>
    <Switch label={t("terminal.showComposer")} checked={prefs.showComposer} onChange={showComposer => patch({ showComposer })}/>
    {prefs.showComposer && <Segmented label={t("terminal.messageBox")} value={prefs.composer} onChange={composer => patch({ composer })}
      options={[{ value: "slim", label: t("terminal.oneLine") }, { value: "full", label: t("terminal.wide") }]}/>}
    <Segmented label={t("terminal.sendKey")} value={prefs.sendKey} onChange={sendKey => patch({ sendKey })}
      options={[{ value: "enter", label: "Enter" }, { value: "mod-enter", label: "Ctrl+Enter" }]}/>
    <Switch label={t("terminal.showStatus")} checked={prefs.showStatus} onChange={showStatus => patch({ showStatus })}/>
    <Switch label={t("terminal.showKeyHints")} checked={prefs.showHints} onChange={showHints => patch({ showHints })}/>
    <div className="pref-note">{t("terminal.browserOnlyPreferences")}</div>
  </div>;
}
