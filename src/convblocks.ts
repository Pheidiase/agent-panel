import { getLocale, t } from "./i18n";
// Pure layout of a conversation log for the chat reader: day separators,
// folded tool runs and turn ends. No React, so it is unit tested.
export type ConvEntry = { id: string; role: "user" | "assistant"; kind: "text" | "tool"; text?: string; name?: string; summary?: string; result?: string; isError?: boolean; truncated?: boolean; time?: string | null };
export type Conversation = { entries: ConvEntry[]; partial: boolean };
// Parallel tools can finish before the last entry changes. Compare every
// rendered field before retaining the previous reader snapshot.
export function retainConversation(current: Conversation | null, next: Conversation | null): Conversation | null {
  if (!current || !next || current.partial !== next.partial || current.entries.length !== next.entries.length) return next;
  const fields: (keyof ConvEntry)[] = ["id", "role", "kind", "text", "name", "summary", "result", "isError", "truncated", "time"];
  return current.entries.every((entry, i) => fields.every(field => entry[field] === next.entries[i][field])) ? current : next;
}
export const entryText = (e: ConvEntry) => [e.text, e.name, e.summary, e.result].filter(Boolean).join("\n");
export type Block =
  | { type: "day"; key: string; label: string }
  | { type: "msg"; key: string; entry: ConvEntry; index: number; last: boolean }
  | { type: "tools"; key: string; items: Array<{ entry: ConvEntry; index: number }> };

export const validDate = (iso?: string | null) => { const d = iso ? new Date(iso) : null; return d && !isNaN(+d) ? d : null; };
export const clock = (d: Date | null) => (d ? d.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }) : "");
export function dayLabel(d: Date, now = new Date()): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86400000);
  if (days === 0) return t("conv.today");
  if (days === 1) return t("conv.yesterday");
  return d.toLocaleDateString(getLocale(), { day: "numeric", month: "long", weekday: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
// Consecutive tool calls fold into one group; a day separator precedes the
// first entry of each calendar day. `last` marks the reply that closes a turn.
export function buildBlocks(entries: ConvEntry[], now = new Date()): Block[] {
  const blocks: Block[] = [];
  let day = "";
  entries.forEach((entry, index) => {
    const d = validDate(entry.time);
    if (d) {
      const key = d.toDateString();
      if (key !== day) { day = key; blocks.push({ type: "day", key: `day-${entry.id}`, label: dayLabel(d, now) }); }
    }
    const prev = blocks[blocks.length - 1];
    if (entry.kind === "tool") {
      if (prev?.type === "tools") prev.items.push({ entry, index });
      else blocks.push({ type: "tools", key: `tools-${entry.id}`, items: [{ entry, index }] });
      return;
    }
    blocks.push({ type: "msg", key: entry.id, entry, index, last: false });
  });
  // An assistant reply is the end of its turn when a user message (or the end) follows.
  for (let i = blocks.length - 1, closing = true; i >= 0; i--) {
    const b = blocks[i];
    if (b.type !== "msg") continue;
    if (b.entry.role === "user") { closing = true; continue; }
    if (closing) { b.last = true; closing = false; }
  }
  return blocks;
}
export function toolSummary(items: Array<{ entry: ConvEntry }>): string {
  const counts = new Map<string, number>();
  for (const { entry } of items) counts.set(entry.name || t("conv.tool"), (counts.get(entry.name || t("conv.tool")) || 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ");
}
export const resultMeta = (e: ConvEntry) => {
  if (e.isError) return t("conv.error");
  if (!e.result) return "";
  const lines = e.result.split("\n").length;
  return lines > 1 ? t("conv.resultLines", { count: `${lines}${e.truncated ? "+" : ""}` }) : "";
};

