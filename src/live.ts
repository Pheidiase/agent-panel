// Client side of the live session list: applies the server's snapshot/patch
// stream. The patch format lives in one place here and mirrors the reference
// implementation in server/live-state.mjs (kept in sync by the acceptance run).
export type SessionOp =
  | { op: "remove"; id: string }
  | { op: "add"; index: number; item: { id: string } }
  | { op: "update"; id: string; fields: Record<string, unknown> };

export type SessionList<T> = { epoch: string | null; version: number; items: T[] };
export type SessionMessage<T> = {
  epoch?: string; mode?: string; version?: number; baseVersion?: number;
  items?: T[]; ops?: SessionOp[];
};

// REST snapshots and socket messages share one version cursor. A new epoch
// identifies a server restart, whose version counter starts again at one.
export function mergeSessionList<T extends { id: string }>(state: SessionList<T>, message: SessionMessage<T>, allowNewEpoch = false) {
  if (typeof message.epoch !== "string" || !Number.isInteger(message.version))
    return { state, resync: true };
  const version = message.version as number;
  const sameEpoch = message.epoch === state.epoch;
  if (sameEpoch && version <= state.version) return { state, resync: false };
  if (message.mode === "snapshot" && Array.isArray(message.items)) {
    if (state.epoch && !sameEpoch && !allowNewEpoch) return { state, resync: false };
    return { state: { epoch: message.epoch, version, items: message.items }, resync: false };
  }
  const known = new Set(state.items.map(item => item.id));
  if (!sameEpoch || message.baseVersion !== state.version || !Array.isArray(message.ops) ||
      !message.ops.every(op => op.op === "add" || known.has(op.id))) return { state, resync: true };
  return { state: { epoch: message.epoch, version, items: applySessionOps(state.items, message.ops) }, resync: false };
}

export function applySessionOps<T extends { id: string }>(list: T[], ops: SessionOp[]): T[] {
  let next = list.slice();
  for (const op of ops)
    if (op.op === "remove") next = next.filter((item) => item.id !== op.id);
  for (const op of ops)
    if (op.op === "add") {
      // A full fetch (refresh) can land between the server's diff and the
      // patch, so the id may already be present; a second insert would give
      // the list duplicate keys and corrupt the rendered cards.
      if (next.some((item) => item.id === op.item.id)) continue;
      next = [...next.slice(0, op.index), op.item as unknown as T, ...next.slice(op.index)];
    }
  for (const op of ops)
    if (op.op === "update")
      next = next.map((item) =>
        item.id === op.id ? { ...item, ...(op.fields as Partial<T>) } : item,
      );
  return next;
}
