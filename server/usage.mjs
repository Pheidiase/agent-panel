// Read-only plan-usage view for the sidebar. Codex: the newest rate_limits
// event in the rollout JSONL files. Claude: a snapshot the user's statusline
// script writes to <state>/claude-usage.json (Claude Code only hands these
// numbers to the statusline); it is as fresh as the last active Claude
// session. Neither source touches credentials.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TAIL_BYTES = 256 * 1024;
const RECENT_FILES = 8;

async function tail(file) {
  const fd = await fs.open(file, "r");
  try {
    const { size } = await fd.stat();
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    await fd.close();
  }
}

async function newestRollouts(root, limit) {
  const found = [];
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          found.push({ full, mtime: (await fs.stat(full)).mtimeMs });
          found.sort((a, b) => b.mtime - a.mtime);
          if (found.length > limit) found.pop();
        } catch {}
      }
    }
  };
  await walk(root, 0);
  return found;
}

function windowOf(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.used_percent ?? raw.used_percentage);
  if (!Number.isFinite(used)) return null;
  const resetsAt = Number(raw.resets_at);
  const resets = Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null;
  // A window whose reset time has passed has started over since the reading.
  const expired = resets !== null && resets * 1000 <= now;
  return {
    usedPercent: expired ? 0 : Math.min(100, Math.max(0, used)),
    resetsAt: expired ? null : resets,
    stale: expired,
  };
}

export async function readCodexUsage({ home = os.homedir(), now = Date.now() } = {}) {
  const root = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  for (const file of await newestRollouts(root, RECENT_FILES)) {
    let text;
    try {
      text = await tail(file.full);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let limits;
      try {
        limits = JSON.parse(lines[i])?.payload?.rate_limits;
      } catch {
        continue; // first line of the tail can be cut mid-record
      }
      const fiveHour = windowOf(limits?.primary, now);
      const weekly = windowOf(limits?.secondary, now);
      if (!fiveHour && !weekly) continue;
      return { available: true, plan: limits.plan_type || null, fiveHour, weekly, updatedAt: Math.round(file.mtime) };
    }
  }
  return { available: false };
}

export async function readClaudeUsage({ stateDir, now = Date.now() }) {
  let snap;
  let mtime;
  try {
    const file = path.join(stateDir, "claude-usage.json");
    mtime = (await fs.stat(file)).mtimeMs;
    snap = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return { available: false };
  }
  const fiveHour = windowOf(snap?.five_hour, now);
  const weekly = windowOf(snap?.seven_day, now);
  if (!fiveHour && !weekly) return { available: false };
  const written = Number(snap.updated_at) * 1000;
  return { available: true, plan: null, fiveHour, weekly, updatedAt: Number.isFinite(written) ? written : Math.round(mtime) };
}

export async function readUsage({ stateDir, home, now = Date.now() }) {
  const [codex, claude] = await Promise.all([
    readCodexUsage({ home, now }), readClaudeUsage({ stateDir, now }),
  ]);
  return { codex, claude };
}

// One reader per server, shared by the sidebar, mobile rail and quota page.
// Concurrent misses share the same promise; failures are never cached.
export function createUsageReader({ stateDir, home, ttlMs = 5000, now = Date.now, load = readUsage }) {
  let cached, expires = 0, pending = null;
  return function usage() {
    if (pending) return pending;
    if (cached && now() < expires) return Promise.resolve(cached);
    pending = Promise.resolve().then(() => load({ stateDir, home, now: now() }))
      .then(value => {
        cached = value;
        expires = now() + ttlMs;
        return value;
      }).finally(() => { pending = null; });
    return pending;
  };
}
