// Read-only view of a Codex terminal session's own conversation log
// (~/.codex/sessions/.../rollout-*.jsonl). Codex runs one shared app-server, so
// the pane's process tree cannot name its thread. The panel starts Codex and
// Codex creates the pane's first thread right away, so the thread is the one
// started by `codex-tui` in the pane's folder within a short window after the
// pane was created. Anything ambiguous (another thread or another panel Codex
// session in the same window) answers `available: false` and the reader keeps
// the raw terminal output. Nothing here writes; the log is read through a
// bounded tail and the SQLite index through a read-only handle.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as sqlite from "node:sqlite";
const Database = sqlite.Database ?? sqlite.DatabaseSync;
import { MAX_ENTRIES, TAIL_BYTES, readTail } from "./claude-conversation.mjs";

export const START_WINDOW_MS = 120_000;
const TEXT_LIMIT = 20000, RESULT_LIMIT = 1500, SUMMARY_LIMIT = 200;
const clip = (text, limit) => (text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false });
const oneLine = (text) => clip(String(text).replace(/\s+/g, " ").trim(), SUMMARY_LIMIT).text;

// Threads created by the panel's Codex TUI near `startedAt`; null unless exactly one.
export function locateCodexRollout({ cwd, startedAt, otherStarts = [], home = os.homedir() }) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || typeof cwd !== "string") return null;
  // A second panel Codex in the same folder started inside the window makes the match unprovable.
  if (otherStarts.some((t) => Math.abs(Date.parse(t) - started) <= START_WINDOW_MS)) return null;
  let db;
  try {
    db = new Database(path.join(home, ".codex", "state_5.sqlite"), { readOnly: true });
    const rows = db.prepare(
      "SELECT id, rollout_path FROM threads WHERE cwd = ? AND originator = 'codex-tui' AND archived = 0 AND created_at_ms BETWEEN ? AND ? LIMIT 3",
    ).all(cwd, started - 5000, started + START_WINDOW_MS);
    if (rows.length !== 1) return null;
    const file = String(rows[0].rollout_path || "");
    const sessions = path.join(home, ".codex", "sessions") + path.sep;
    if (!path.resolve(file).startsWith(sessions) || !fs.existsSync(file)) return null;
    return { threadId: String(rows[0].id), file };
  } catch { return null; }
  finally { try { db?.close(); } catch { /* ignore */ } }
}

const joinText = (parts, types) => (Array.isArray(parts) ? parts.map((p) => (p && types.includes(p.type) && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n") : "");
function outputText(output) {
  const raw = typeof output === "string" ? output : joinText(output, ["input_text", "output_text", "text"]);
  // Tool output arrives as a "Script completed ... Output:" preface plus a JSON envelope.
  const body = raw.split("\nOutput:\n").slice(1).join("\nOutput:\n") || raw;
  try {
    let j = JSON.parse(body);
    for (let i = 0; i < 3 && j && typeof j === "object"; i++) {
      if (typeof j.output === "string") return j.output.trim();
      j = j.value;
    }
  } catch { /* not a single JSON document */ }
  const embedded = body.match(/"output":("(?:[^"\\]|\\.)*")/);
  if (embedded) { try { return JSON.parse(embedded[1]).trim(); } catch { /* keep raw */ } }
  return body.trim();
}
function summarize(input) {
  if (typeof input !== "string") return "";
  const cmd = input.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/);
  return oneLine(cmd ? cmd[1].replace(/\\n/g, " ") : input);
}

// Pure: rollout JSONL -> display entries (same shape as the Claude reader).
// User turns come from the UI's own UserMessage items, so injected instructions
// and developer messages never appear; reasoning is left out.
export function parseCodexConversation(jsonl, { max = MAX_ENTRIES } = {}) {
  const entries = [], tools = new Map();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d?.payload;
    if (!p || typeof p !== "object") continue;
    const time = typeof d.timestamp === "string" ? d.timestamp : null, n = entries.length;
    if (d.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") {
      const body = joinText(p.item.content, ["text"]);
      if (!body.trim()) continue;
      const { text, truncated } = clip(body, TEXT_LIMIT);
      entries.push({ id: `${p.item.id || n}:u`, role: "user", kind: "text", text, truncated, time });
    } else if (d.type === "response_item" && p.type === "message" && p.role === "assistant") {
      const body = joinText(p.content, ["output_text"]);
      if (!body.trim()) continue;
      const { text, truncated } = clip(body, TEXT_LIMIT);
      entries.push({ id: `${p.id || n}:a`, role: "assistant", kind: "text", text, truncated, time });
    } else if (d.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
      const entry = { id: `${p.id || p.call_id || n}:t`, role: "assistant", kind: "tool", name: String(p.name || "araç").slice(0, 60), summary: summarize(p.type === "function_call" ? p.arguments : p.input), result: "", isError: false, truncated: false, time };
      entries.push(entry);
      if (typeof p.call_id === "string") tools.set(p.call_id, entry);
    } else if (d.type === "response_item" && (p.type === "custom_tool_call_output" || p.type === "function_call_output")) {
      const entry = tools.get(p.call_id);
      if (!entry) continue;
      const { text, truncated } = clip(outputText(p.output), RESULT_LIMIT);
      entry.result = text; entry.truncated = truncated;
    }
  }
  return entries.length > max ? entries.slice(-max) : entries;
}

export async function readCodexConversation(target, options = {}) {
  const located = locateCodexRollout({ ...target, ...options });
  if (!located) return { available: false };
  const { text, partial } = readTail(located.file, TAIL_BYTES);
  return { available: true, source: "codex", sessionId: located.threadId, entries: parseCodexConversation(text), partial };
}
