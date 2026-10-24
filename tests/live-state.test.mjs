// Live session list: the diff/apply contract (a patch must reconstruct the
// next list exactly), reset detection for unexpected order changes, and the
// LiveState snapshot/patch/version flow against a fake build function.
// No model, no network, no tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveState, diffSessionLists, applySessionOps } from "../server/live-state.mjs";

function item(id, extra = {}) {
  return { id, title: `t-${id}`, status: "running", pid: 1, geometry: { cols: 120, rows: 34 }, ...extra };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("diffSessionLists: apply reconstructs the next list for structural changes", () => {
  const cases = [
    [[], [item("a"), item("b")]],
    [[item("a"), item("b")], []],
    [[item("a"), item("b")], [item("c"), item("a"), item("b")]],
    [[item("a"), item("b")], [item("b")]],
    [[item("a"), item("b"), item("c")], [item("a"), item("c")]],
    [[item("a")], [item("a"), item("b")]],
    [[item("a", { status: "running" })], [item("a", { status: "ended" })]],
    [[item("a")], [item("a", { pinned: true, lastOpenedAt: "2026-10-05T00:00:00.000Z" })]],
    [[item("a"), item("x")], [item("x"), item("a")]],
  ];
  for (const [before, after] of cases) {
    const result = diffSessionLists(before, after);
    if (result.reset) {
      // A reset is only allowed when the change is not a plain add/remove/update.
      const ids = (list) => list.map((entry) => entry.id).sort().join(",");
      assert.equal(ids(before), ids(after));
      continue;
    }
    assert.deepEqual(applySessionOps(before, result.ops), after);
  }
  const unchanged = [item("a"), item("b")];
  assert.deepEqual(diffSessionLists(unchanged, unchanged).ops, []);
});

test("diffSessionLists: a pure reorder reports a reset, never a wrong patch", () => {
  const result = diffSessionLists([item("a"), item("b")], [item("b"), item("a")]);
  assert.equal(result.reset, true);
  assert.equal(result.ops, null);
});

test("applySessionOps: an add for an id already present never duplicates it", () => {
  // A plain refresh (GET /sessions) can land between the server's diff and
  // the patch broadcast; the client then already holds the item. A second
  // insert would give the list duplicate keys and corrupt the card render.
  const before = [item("a"), item("b")];
  const raced = applySessionOps(before, [{ op: "add", index: 0, item: item("a") }]);
  assert.deepEqual(raced.map((entry) => entry.id), ["a", "b"]);
  assert.equal(raced.length, 2);
});

test("diffSessionLists: fuzz — a patch always reconstructs the next list", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let round = 0; round < 400; round++) {
    const before = [];
    for (let i = 0; i < 4; i += 1) before.push(item(`i${i}`, { pid: Math.round(rand() * 1000) }));
    const after = before.map((entry) => ({ ...entry }));
    const kind = Math.floor(rand() * 4);
    if (kind === 0 && after.length) after.splice(Math.floor(rand() * after.length), 1);
    else if (kind === 1) after.splice(Math.floor(rand() * (after.length + 1)), 0, item(`n${round}`));
    else if (kind === 2 && after.length) {
      const at = Math.floor(rand() * after.length);
      after[at] = { ...after[at], status: "ended", pid: null };
    } else if (after.length) {
      const at = Math.floor(rand() * after.length);
      after[at] = { ...after[at], extra: { nested: [1, 2, 3] } };
    }
    const result = diffSessionLists(before, after);
    if (result.reset) {
      const ids = (list) => list.map((entry) => entry.id).sort().join(",");
      assert.equal(ids(before), ids(after));
    } else {
      assert.deepEqual(applySessionOps(before, result.ops), after);
    }
  }
});

test("LiveState: snapshot on attach, patch on change, snapshot on reset", async () => {
  let current = [item("a")];
  const live = new LiveState({
    build: async () => current.map((entry) => ({ ...entry })),
    tickMs: 60_000,
    coalesceMs: 5,
  });
  const patches = [];
  const snapshots = [];
  live.on("patch", (payload) => patches.push(payload));
  live.on("snapshot", (payload) => snapshots.push(payload));
  const first = await live.current();
  assert.equal(first.mode, "snapshot");
  assert.equal(first.version, 1);
  assert.deepEqual(first.items.map((entry) => entry.id), ["a"]);
  // A change produces exactly one patch with contiguous versions.
  current = [item("b"), item("a")];
  live.kick();
  await delay(80);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].baseVersion, first.version);
  assert.equal(patches[0].version, first.version + 1);
  assert.deepEqual(
    applySessionOps(first.items, patches[0].ops).map((entry) => entry.id),
    ["b", "a"],
  );
  // No change → no traffic.
  live.kick();
  await delay(80);
  assert.equal(patches.length, 1);
  // A pure reorder falls back to a broadcast snapshot.
  current = [item("a"), item("b")];
  live.kick();
  await delay(80);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].items.map((entry) => entry.id), ["a", "b"]);
  assert.equal(snapshots[0].version, first.version + 2);
  // current() answers the latest version after the reset.
  const afterReset = await live.current();
  assert.equal(afterReset.version, first.version + 2);
  live.stop();
});

test("LiveState: builds coalesce and a failing build keeps the last list", async () => {
  let current = [item("a")];
  let builds = 0;
  let fail = false;
  const live = new LiveState({
    build: async () => {
      builds += 1;
      if (fail) throw new Error("boom");
      return current.map((entry) => ({ ...entry }));
    },
    tickMs: 60_000,
    coalesceMs: 10,
  });
  await live.current();
  const baseline = builds;
  current = [item("b")];
  live.kick();
  live.kick();
  live.kick();
  await delay(80);
  // Three kicks in one window collapse into a single rebuild.
  assert.equal(builds - baseline, 1);
  const snapshot = await live.current();
  assert.deepEqual(snapshot.items.map((entry) => entry.id), ["b"]);
  fail = true;
  current = [item("c")];
  live.kick();
  await delay(80);
  const survived = await live.current();
  assert.deepEqual(survived.items.map((entry) => entry.id), ["b"]);
  live.stop();
});
