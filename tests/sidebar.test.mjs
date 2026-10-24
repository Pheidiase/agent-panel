// Unit tests for the v5 sidebar sections (src/sidebar.ts). The TypeScript
// source is transpiled in-memory like tests/inbox.test.mjs does. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clientModules } from "./fixtures/client-modules.mjs";

const modules = clientModules();
modules("i18n.ts").setLanguage("tr");
const { groupSidebar, isWorking, shortAge } = modules("sidebar.ts");

const now = new Date(2026, 9, 20, 14, 0);
const at = (h, m = 0, day = 20) => new Date(2026, 9, day, h, m).toISOString();
const s = (id, extra = {}) => ({ id, title: id, status: "running", createdAt: at(9), ...extra });
const ids = (list) => list.map((x) => x.id);

test("each session lands in exactly one section; archived never shows", () => {
  const sessions = [
    s("wait"), s("pin", { pinned: true }), s("open"),
    s("done", { status: "ended", endedAt: at(11) }),
    s("old", { status: "ended", endedAt: at(11, 0, 18) }),
    s("arch", { archived: true }), s("archwait", { archived: true }),
  ];
  const waits = [{ sessionId: "wait", type: "approval", expiresAt: null }, { sessionId: "archwait", type: "question", expiresAt: null }];
  const g = groupSidebar(sessions, waits, now);
  assert.deepEqual(ids(g.attention), ["wait"]);
  assert.deepEqual(ids(g.pinned), ["pin"]);
  assert.deepEqual(ids(g.open), ["open"]);
  assert.deepEqual(ids(g.today), ["done"]);
  assert.equal(g.older, 1);
});

test("attention beats pinned and ended; soonest deadline first", () => {
  const sessions = [s("a", { pinned: true }), s("b", { status: "ended", endedAt: at(8, 0, 1) }), s("c")];
  const waits = [
    { sessionId: "a", type: "approval", expiresAt: at(14, 9) },
    { sessionId: "b", type: "error", expiresAt: null },
    { sessionId: "c", type: "question", expiresAt: at(14, 2) },
    { sessionId: "a", type: "question", expiresAt: at(14, 1) },
  ];
  const g = groupSidebar(sessions, waits, now);
  assert.deepEqual(ids(g.attention), ["a", "c", "b"]);
  assert.equal(g.pinned.length + g.today.length + g.older, 0);
});

test("open and today sort by last opened, then created; limit applies", () => {
  const sessions = [
    s("o1", { createdAt: at(8) }), s("o2", { createdAt: at(7), lastOpenedAt: at(13) }), s("o3", { createdAt: at(10) }),
    s("t1", { status: "unavailable", createdAt: at(6) }), s("t2", { status: "ended", createdAt: at(5), lastOpenedAt: at(12) }),
  ];
  const g = groupSidebar(sessions, [], now, "", 2);
  assert.deepEqual(ids(g.open), ["o2", "o3"]);
  assert.deepEqual(ids(g.today), ["t2", "t1"]);
});

test("search filters every section by title, Turkish case-insensitive", () => {
  const sessions = [s("x", { title: "İstanbul işi" }), s("y", { title: "Diğer" }), s("z", { title: "ıSTANBUL", status: "ended", endedAt: at(9) })];
  const g = groupSidebar(sessions, [{ sessionId: "y", type: "approval", expiresAt: null }], now, "istanbul");
  assert.deepEqual(ids(g.open), ["x"]);
  assert.deepEqual(ids(g.attention), []);
  assert.deepEqual(ids(g.today), []);
});

test("working only for chat turns; short ages", () => {
  assert.equal(isWorking({ connection: "running" }), true);
  assert.equal(isWorking({ connection: "attention" }), true);
  assert.equal(isWorking({ connection: "idle" }), false);
  assert.equal(isWorking({}), false);
  const t = now.getTime();
  assert.equal(shortAge(new Date(t - 30_000).toISOString(), t), "şimdi");
  assert.equal(shortAge(new Date(t - 12 * 60_000).toISOString(), t), "12 dk");
  assert.equal(shortAge(new Date(t - 3 * 3600_000).toISOString(), t), "3 sa");
  assert.equal(shortAge(new Date(t - 50 * 3600_000).toISOString(), t), "2 gün");
  assert.equal(shortAge("bozuk", t), "şimdi");
});
