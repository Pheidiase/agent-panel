// "Müdahale bekleyen işler" signals. The session list carries one additive
// `attention` object per chat session so every viewer (and the inbox) can tell
// "waiting for you" from "just running". Nothing here is persisted: pending
// approvals come from the live runtime; latest turn/error markers are folded
// from retained events at startup and on append (seq numbers are stable ids).

const TITLE_MAX = 140;

// Fold an appended event into the per-session marker record (in memory only).
export function noteSignal(signals, id, stored) {
  if (!stored || typeof stored.seq !== "number") return;
  if (stored.kind === "turn") {
    if (stored.stopReason === "cancelled") return; // the user stopped it; nothing to report
    signals.set(id, {
      ...(signals.get(id) ?? {}),
      turn: { seq: stored.seq, stopReason: String(stored.stopReason ?? "end_turn"), at: stored.t ?? null, failed: false },
    });
  } else if (stored.kind === "error") {
    const current = signals.get(id) ?? {};
    // Managers append the turn marker and then its error right after; flag the
    // turn as failed so the client reports one "Hata", not also "Tamamlandı".
    const turn = current.turn && stored.seq - current.turn.seq <= 2 ? { ...current.turn, failed: true } : current.turn;
    signals.set(id, {
      ...current,
      ...(turn ? { turn } : {}),
      error: { seq: stored.seq, text: String(stored.text ?? "").slice(0, TITLE_MAX), at: stored.t ?? null },
    });
  }
}

// Build the list-item `attention` field. `pendingApprovals` is the runtime Map
// (requestId -> {expiresAt, title, isQuestion}); either part may be missing.
export function attentionOf(pendingApprovals, signal) {
  const approvals = [];
  for (const [requestId, pending] of pendingApprovals ?? [])
    approvals.push({
      id: requestId,
      kind: pending?.isQuestion ? "question" : "approval",
      title: String(pending?.title ?? "").slice(0, TITLE_MAX),
      expiresAt: pending?.expiresAt ?? null,
    });
  return { approvals, turn: signal?.turn ?? null, error: signal?.error ?? null };
}
