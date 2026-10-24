// Read-only view of a Claude Code terminal session's own conversation log.
// Claude Code records `<pid>.json` (pid -> sessionId, cwd) under
// ~/.claude/sessions and the messages in ~/.claude/projects/<cwd>/<id>.jsonl.
// The panel maps its tmux pane to that log through the process tree, so no
// guessing by time or folder is involved. Nothing here writes, and the log is
// read only through a bounded tail. The `.key` files next to the pid records
// are never opened.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TAIL_BYTES = 6 * 1024 * 1024;
export const MAX_ENTRIES = 400;
const TEXT_LIMIT = 20000, RESULT_LIMIT = 1500, SUMMARY_LIMIT = 200;
// Harness-injected user turns (slash-command echoes, reminders) are not messages.
const NOISE = /^\s*<(local-command|command-name|command-message|command-args|system-reminder|task-notification|user-prompt-submit-hook)/;

export const encodeCwd = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, "-");

// Pane pid and all of its descendants, breadth first, from a `ps` pid/ppid table.
export function descendants(root, table) {
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [root], seen = new Set([root]);
  for (let i = 0; i < found.length && found.length < 500; i++) {
    for (const child of children.get(found[i]) || []) {
      if (!seen.has(child)) { seen.add(child); found.push(child); }
    }
  }
  return found;
}

async function processTable() {
  const { stdout } = await run("/bin/ps", ["-eo", "pid=,ppid="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && r.every(Number.isInteger));
}

// Returns { sessionId, file } for the Claude process under `panePid`, or null.
export async function locateClaudeLog(panePid, { home = os.homedir(), table } = {}) {
  if (!Number.isInteger(panePid) || panePid <= 0) return null;
  const pids = descendants(panePid, table || (await processTable()));
  for (const pid of pids) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(home, ".claude", "sessions", `${pid}.json`), "utf8")); }
    catch { continue; }
    if (!UUID.test(record?.sessionId || "") || typeof record.cwd !== "string") continue;
    const file = path.join(home, ".claude", "projects", encodeCwd(record.cwd), `${record.sessionId}.jsonl`);
    if (fs.existsSync(file)) return { sessionId: record.sessionId, cwd: record.cwd, file };
  }
  return null;
}

const clip = (text, limit) => (text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false });
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "file_path", "pattern", "path", "url", "query", "description", "prompt"]) {
    if (typeof input[key] === "string" && input[key]) return clip(input[key].replace(/\s+/g, " ").trim(), SUMMARY_LIMIT).text;
  }
  const first = Object.values(input).find((v) => typeof v === "string" && v);
  return first ? clip(first.replace(/\s+/g, " ").trim(), SUMMARY_LIMIT).text : "";
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

// Pure: JSONL text -> display entries. Unparseable lines are skipped, sidechain
// (sub-agent) turns and thinking blocks are left out, and tool results attach
// to the tool call that produced them.
export function parseConversation(jsonl, { max = MAX_ENTRIES } = {}) {
  const entries = [], tools = new Map();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d?.type !== "user" && d?.type !== "assistant") || d.isSidechain || d.isMeta || !d.message) continue;
    const time = typeof d.timestamp === "string" ? d.timestamp : null, content = d.message.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    blocks.forEach((b, i) => {
      if (!b || typeof b !== "object") return;
      const id = `${d.uuid || entries.length}:${i}`;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (d.type === "user" && NOISE.test(b.text)) return;
        const { text, truncated } = clip(b.text, TEXT_LIMIT);
        entries.push({ id, role: d.type, kind: "text", text, truncated, time });
      } else if (b.type === "tool_use" && d.type === "assistant") {
        const entry = { id, role: "assistant", kind: "tool", name: String(b.name || "araç").slice(0, 60), summary: summarize(b.input), result: "", isError: false, truncated: false, time };
        entries.push(entry);
        if (typeof b.id === "string") tools.set(b.id, entry);
      } else if (b.type === "tool_result" && d.type === "user") {
        const entry = tools.get(b.tool_use_id);
        if (!entry) return;
        const { text, truncated } = clip(resultText(b.content), RESULT_LIMIT);
        entry.result = text; entry.truncated = truncated; entry.isError = b.is_error === true;
      }
    });
  }
  return entries.length > max ? entries.slice(-max) : entries;
}

// Bounded tail read; a tail that starts mid-file drops its partial first line.
export function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd), start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, partial: start > 0 };
  } finally { fs.closeSync(fd); }
}

export async function readClaudeConversation(panePid, options = {}) {
  const located = await locateClaudeLog(panePid, options);
  if (!located) return { available: false };
  const { text, partial } = readTail(located.file);
  return { available: true, source: "claude", sessionId: located.sessionId, cwd: located.cwd, entries: parseConversation(text), partial };
}

// A session whose process has ended: the log the panel mapped while it ran.
export function readClaudeLogById({ id, cwd } = {}, { home = os.homedir() } = {}) {
  if (!UUID.test(String(id || "")) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return { available: false };
  const file = path.join(home, ".claude", "projects", encodeCwd(cwd), `${id}.jsonl`);
  if (!fs.existsSync(file)) return { available: false };
  const { text, partial } = readTail(file);
  return { available: true, source: "claude", sessionId: id, cwd, entries: parseConversation(text), partial };
}
