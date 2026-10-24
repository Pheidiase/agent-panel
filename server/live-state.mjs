// Live panel state: one WebSocket channel carries the session list to every
// signed-in viewer as an initial snapshot plus small incremental patches.
// The list is rebuilt when a mutation kicks it (instant feedback) and on a
// slow reconciliation tick (process liveness changes without a record write).
// No new dependency; the patch format is a tiny JSON-Patch-like subset.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const LIVE_TICK_MS = 5000;
export const LIVE_COALESCE_MS = 40;

// Order-insensitive comparison: two records that differ only in key order are
// the same; anything else is a change. Records are JSON-safe by construction.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}
function same(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// Diff two session lists into ops that reconstruct `next` from `prev`:
// removals by id, then insertions in ascending target index, then field
// updates. If that cannot reproduce `next` exactly (an unexpected order
// change), a reset is requested and the caller sends a fresh snapshot.
export function diffSessionLists(prev, next) {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const ops = [];
  for (const item of prev)
    if (!nextById.has(item.id)) ops.push({ op: "remove", id: item.id });
  const adds = [];
  next.forEach((item, index) => {
    if (!prevById.has(item.id)) adds.push({ op: "add", index, item });
  });
  adds.sort((a, b) => a.index - b.index);
  ops.push(...adds);
  for (const item of next) {
    const before = prevById.get(item.id);
    if (!before) continue;
    const fields = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(item)])) {
      if (item[key] === undefined) continue; // a lost field is caught by the simulation below
      if (!same(before[key], item[key])) fields[key] = item[key];
    }
    if (Object.keys(fields).length) ops.push({ op: "update", id: item.id, fields });
  }
  if (!same(applySessionOps(prev, ops), next)) return { reset: true, ops: null };
  return { reset: false, ops };
}

// Applies a patch the same way the browser does; doubles as the reference
// implementation (the client keeps a mirrored copy in src/live.ts). Adds are
// idempotent per id: a full fetch can race the stream, and inserting an id
// that is already present would duplicate it (duplicate React keys).
export function applySessionOps(prev, ops) {
  let list = prev.slice();
  for (const op of ops)
    if (op.op === "remove") list = list.filter((item) => item.id !== op.id);
  for (const op of ops)
    if (op.op === "add") {
      if (list.some((item) => item.id === op.item.id)) continue;
      list = [...list.slice(0, op.index), op.item, ...list.slice(op.index)];
    }
  for (const op of ops)
    if (op.op === "update")
      list = list.map((item) => (item.id === op.id ? { ...item, ...op.fields } : item));
  return list;
}

export class LiveState extends EventEmitter {
  constructor({ build, tickMs = LIVE_TICK_MS, coalesceMs = LIVE_COALESCE_MS }) {
    super();
    this.build = build;
    this.tickMs = tickMs;
    this.coalesceMs = coalesceMs;
    this.version = 0;
    this.epoch = randomUUID();
    this.items = null; // last broadcast list
    this.pending = false; // a rebuild is scheduled
    this.queued = false; // another change arrived while one was scheduled
    this.building = null; // in-flight rebuild
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.tickMs);
    this.timer.unref();
    this.kick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Coalesces nearby changes into one rebuild so a burst of writes does not
  // produce a burst of patches. A kick while a rebuild is already scheduled is
  // satisfied by that rebuild (it reads the post-change state); only a change
  // that lands while a build is in flight schedules another pass.
  kick() {
    if (this.pending) return;
    if (this.building) {
      this.queued = true;
      return;
    }
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this._drain();
    }, this.coalesceMs).unref();
  }

  async _drain() {
    try {
      await this._rebuild();
    } catch {
      /* keep the last known list */
    }
    if (this.queued) {
      this.queued = false;
      this.kick();
    }
  }

  _rebuild() {
    if (this.building) return this.building;
    this.building = (async () => {
      const list = await this.build();
      if (this.items === null) {
        this.items = list;
        this.version += 1;
        return;
      }
      const { reset, ops } = diffSessionLists(this.items, list);
      if (reset) {
        this.items = list;
        this.version += 1;
        this.emit("snapshot", this.snapshot());
        return;
      }
      if (!ops.length) return;
      const baseVersion = this.version;
      this.items = list;
      this.version += 1;
      this.emit("patch", {
        type: "sessions",
        mode: "patch",
        epoch: this.epoch,
        version: this.version,
        baseVersion,
        ops,
      });
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  snapshot() {
    return { type: "sessions", mode: "snapshot", epoch: this.epoch, version: this.version, items: this.items ?? [] };
  }

  // Current snapshot for a newly attached viewer; builds one on first use and
  // answers with the last known list when a rebuild fails.
  async current() {
    try {
      await this._rebuild();
    } catch {
      /* keep the last known list */
    }
    return this.snapshot();
  }
}
