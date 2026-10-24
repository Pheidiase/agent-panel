// Unit tests for the "Müdahale bekleyen işler" helpers (src/inbox.ts) and the
// server-side attention markers (server/attention.mjs). The TypeScript source
// is transpiled in-memory like tests/changes.test.mjs does. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionOf, noteSignal } from "../server/attention.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";

const load = clientModules();
load("i18n.ts").setLanguage("tr");
const inbox = load("inbox.ts");

const sessions = [
  { id: "s1", title: "Bir", attention: { approvals: [{ id: "a1-x", kind: "approval", title: "rm -rf", expiresAt: "2026-01-01T00:05:00Z" }, { id: "u2-y", kind: "question", title: "Hangisi?", expiresAt: null }], turn: { seq: 7, stopReason: "end_turn", at: "t7" }, error: null } },
  { id: "s2", title: "İki", attention: { approvals: [], turn: { seq: 4, stopReason: "end_turn", at: "t4", failed: true }, error: { seq: 5, text: "patladı", at: "t5" } } },
  { id: "s3", title: "Arşiv", archived: true, attention: { approvals: [{ id: "a9", kind: "approval", title: "", expiresAt: null }] } },
  { id: "t1", title: "Terminal" },
];

test("extractEvents builds stable ids and skips archived, terminal and failed-turn done", () => {
  const events = inbox.extractEvents(sessions);
  assert.deepEqual(events.map((e) => [e.id, e.type]), [
    ["s1:approval:a1-x", "approval"],
    ["s1:approval:u2-y", "question"],
    ["s1:turn:7", "done"],
    ["s2:error:5", "error"],
  ]);
  assert.deepEqual(inbox.extractEvents(sessions).map((e) => e.id), events.map((e) => e.id));
});

test("baseline swallows old results but keeps pending approvals live", () => {
  const events = inbox.extractEvents(sessions);
  const state = inbox.baseline(events);
  assert.deepEqual(state.seen.sort(), ["s1:turn:7", "s2:error:5"]);
  assert.equal(inbox.unreadCount(events, state), 2);
  assert.equal(inbox.sessionMarker("s1", events, state), "wait");
  assert.equal(inbox.sessionMarker("s2", events, state), null);
});

test("markSeen and sessionMarker: unread result vs waiting", () => {
  const events = inbox.extractEvents(sessions);
  let state = { seen: [], notified: [] };
  assert.equal(inbox.sessionMarker("s2", events, state), "unread");
  state = inbox.markSeen(state, inbox.idsOfSession(events, "s2"));
  assert.equal(inbox.sessionMarker("s2", events, state), null);
  assert.equal(inbox.markSeen(state, ["s2:error:5"]), state); // no-op keeps identity
});

test("planNotifications notifies once, skips the watched visible session", () => {
  const events = inbox.extractEvents(sessions);
  const state = { seen: [], notified: [] };
  const first = inbox.planNotifications(events, state, { sessionId: "s1", visible: true });
  assert.deepEqual(first.toNotify.map((e) => e.id), ["s2:error:5"]);
  // Reconnect / reload: same events again -> nothing, even for the watched one.
  const again = inbox.planNotifications(events, first.next, { sessionId: null, visible: false });
  assert.deepEqual(again.toNotify, []);
  // Hidden tab: the watched session is notified too.
  const hidden = inbox.planNotifications(events, state, { sessionId: "s1", visible: false });
  assert.equal(hidden.toNotify.length, 4);
  // A genuinely new event after that still fires.
  const more = [...events, ...inbox.extractEvents([{ id: "s2", title: "İki", attention: { approvals: [{ id: "a3", kind: "approval", title: "x", expiresAt: null }] } }])];
  assert.deepEqual(inbox.planNotifications(more, hidden.next, { sessionId: null, visible: true }).toNotify.map((e) => e.id), ["s2:approval:a3"]);
});

test("parseSeen tolerates garbage; remainingLabel counts down", () => {
  assert.equal(inbox.parseSeen("nope"), null);
  assert.equal(inbox.parseSeen(null), null);
  assert.deepEqual(inbox.parseSeen('{"seen":["a",1],"notified":[]}'), { seen: ["a"], notified: [] });
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(inbox.remainingLabel("2026-01-01T00:04:32Z", now), "4:32");
  assert.equal(inbox.remainingLabel("2025-12-31T23:59:00Z", now), "süre doldu");
  assert.equal(inbox.remainingLabel(null, now), null);
});

test("server attention: pending map, turn/error markers", () => {
  const signals = new Map();
  noteSignal(signals, "s", { kind: "turn", stopReason: "cancelled", seq: 1, t: "t1" });
  assert.equal(signals.get("s"), undefined);
  noteSignal(signals, "s", { kind: "turn", stopReason: "end_turn", seq: 2, t: "t2" });
  assert.equal(signals.get("s").turn.failed, false);
  noteSignal(signals, "s", { kind: "error", text: "boom", seq: 3, t: "t3" });
  assert.equal(signals.get("s").turn.failed, true);
  assert.equal(signals.get("s").error.seq, 3);
  const pending = new Map([["a1", { isQuestion: true, title: "Soru", expiresAt: "x" }], ["a2", { title: "Onay", expiresAt: null }]]);
  const a = attentionOf(pending, signals.get("s"));
  assert.deepEqual(a.approvals.map((p) => [p.id, p.kind]), [["a1", "question"], ["a2", "approval"]]);
  assert.deepEqual(attentionOf(undefined, undefined), { approvals: [], turn: null, error: null });
});
