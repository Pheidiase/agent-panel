import { getLocale, useI18n } from "./i18n";
// Clean message view of a terminal session, read from the agent's own
// conversation log (Claude Code, Codex). Presentation only: the entries,
// search hits and scroll container belong to TerminalView.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Wrench } from "lucide-react";
import { renderMarkdown } from "./markdown";
import { buildBlocks, clock, resultMeta, toolSummary, validDate, type ConvEntry, type Conversation } from "./convblocks";
export { entryText, type ConvEntry, type Conversation } from "./convblocks";

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { document.body.removeChild(area); }
  }
}
function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return <button type="button" className="conv-action" aria-label={t("conv.copyAnswer")} title={t("conv.copyMarkdown")}
    onClick={async () => { if (await copyText(text)) { setDone(true); window.setTimeout(() => setDone(false), 1500); } }}>
    {done ? <Check size={13}/> : <Copy size={13}/>}{done ? t("conv.copied") : t("conv.copy")}
  </button>;
}

function ToolCard({ entry, hit, open }: { entry: ConvEntry; hit: string; open: boolean }) {
  const { t } = useI18n();
  const meta = resultMeta(entry);
  return <details className={`conv-tool${entry.isError ? " is-error" : ""}${hit}`} open={open || undefined} data-entry={entry.id}>
    <summary>
      <span className={`conv-tool-dot${entry.isError ? " is-error" : entry.result ? " is-ok" : ""}`} aria-hidden="true"/>
      <span className="conv-tool-name">{entry.name}</span>
      <span className="conv-tool-sum">{entry.summary}</span>
      {meta && <span className="conv-tool-meta">{meta}</span>}
    </summary>
    {entry.result ? <pre>{entry.result}{entry.truncated ? `\n${t("conv.truncated")}` : ""}</pre> : <pre className="empty">{t("conv.noResult")}</pre>}
  </details>;
}

export default function ConvReader({ conv, hits, current, onScroll, scrollRef }: {
  conv: Conversation; hits: number[]; current: number;
  onScroll: () => void; scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const blocks = useMemo(() => buildBlocks(conv.entries), [conv.entries, getLocale()]);
  const hitClass = (index: number) => {
    const at = hits.indexOf(index);
    return at < 0 ? "" : at === current ? " conv-hit conv-current" : " conv-hit";
  };
  const currentIndex = current >= 0 ? hits[current] : -1;
  const prompts = useMemo(() => conv.entries.flatMap((e, index) => (e.role === "user" && e.kind === "text" ? [{ index, id: e.id, text: (e.text || "").replace(/\s+/g, " ").trim() }] : [])), [conv.entries]);
  const [active, setActive] = useState<string>("");
  const frame = useRef(0);
  // The outline follows the last prompt that has scrolled past the top.
  function track() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + 48;
      let found = prompts[0]?.id || "";
      // At the very bottom the newest prompt is the one being read.
      if (el.scrollHeight - el.clientHeight - el.scrollTop < 8) { setActive(prompts[prompts.length - 1]?.id || ""); return; }
      for (const p of prompts) {
        const node = el.querySelector<HTMLElement>(`[data-entry="${CSS.escape(p.id)}"]`);
        if (node && node.getBoundingClientRect().top <= top) found = p.id; else if (node) break;
      }
      setActive(found);
    });
  }
  useEffect(() => { track(); return () => cancelAnimationFrame(frame.current); }, [prompts]);
  function jump(id: string) {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`);
    if (node && scrollRef.current) scrollRef.current.scrollTop += node.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - 16;
  }
  return <>
    <div className="conv-reader" ref={scrollRef} tabIndex={0} role="region" aria-label={t("conv.history")} onScroll={() => { onScroll(); track(); }}>
      <div className="conv-stream">
        {conv.partial && <div className="conv-note">{t("conv.partialHistory")}</div>}
        {blocks.map(b => {
          if (b.type === "day") return <div className="conv-day" key={b.key}><span>{b.label}</span></div>;
          if (b.type === "tools") {
            const errors = b.items.filter(i => i.entry.isError).length;
            const hasHit = b.items.some(i => hits.includes(i.index));
            if (b.items.length === 1) return <ToolCard key={b.key} entry={b.items[0].entry} hit={hitClass(b.items[0].index)} open={b.items[0].index === currentIndex}/>;
            return <details className={`conv-tools${hasHit ? " has-hit" : ""}`} key={b.key} open={b.items.some(i => i.index === currentIndex) || undefined}>
              <summary>
                <Wrench size={13} aria-hidden="true"/>
                <span className="conv-tools-count">{t("conv.toolCalls", { count: b.items.length })}</span>
                <span className="conv-tools-names">{toolSummary(b.items)}</span>
                {errors > 0 && <span className="conv-tools-err">{t("conv.errors", { count: errors })}</span>}
              </summary>
              <div className="conv-tools-list">
                {b.items.map(i => <ToolCard key={i.entry.id} entry={i.entry} hit={hitClass(i.index)} open={i.index === currentIndex}/>)}
              </div>
            </details>;
          }
          const e = b.entry, time = clock(validDate(e.time));
          return <div className={`chat-msg ${e.role}${hitClass(b.index)}`} key={b.key} data-entry={e.id}>
            <div className="msg-body">{e.role === "assistant" ? renderMarkdown(e.text || "") : e.text}{e.truncated ? ` ${t("conv.truncated")}` : ""}</div>
            {e.role === "user"
              ? time && <time className="conv-time">{time}</time>
              : <div className={`conv-actions${b.last ? " turn-end" : ""}`}>
                  {e.text && <CopyButton text={e.text}/>}
                  {time && <time className="conv-time">{time}</time>}
                </div>}
          </div>;
        })}
      </div>
    </div>
    {prompts.length > 1 && <nav className="conv-outline" aria-label={t("conv.messages")}>
      <div className="conv-outline-head">{t("conv.messages")} <span>{prompts.length}</span></div>
      <ol>
        {prompts.map(p => <li key={p.id}><button type="button" className={p.id === active ? "active" : ""} aria-current={p.id === active || undefined} title={p.text} onClick={() => jump(p.id)}>{p.text || "…"}</button></li>)}
      </ol>
    </nav>}
  </>;
}
