import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const js = ts.transpileModule(fs.readFileSync(new URL("../src/termprefs.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DEFAULT_PREFS, PREFS_KEY, computeScale, loadPrefs, normalizePrefs, serializePrefs } =
  await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("normalizePrefs: junk and out-of-range values fall back to safe ones", () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs("x"), DEFAULT_PREFS);
  const p = normalizePrefs({ density: "huge", fontSize: 99, lineHeight: 0, cursor: "x", fit: "yes", maxScale: 9, composer: 1, sendKey: null, showStatus: 0 });
  assert.equal(p.density, DEFAULT_PREFS.density);
  assert.equal(p.fontSize, 22);
  assert.equal(p.lineHeight, 1.2);
  assert.equal(p.cursor, "block");
  assert.equal(p.fit, true);
  assert.equal(p.maxScale, 2);
  assert.equal(p.composer, "slim");
  assert.equal(p.sendKey, "enter");
  assert.equal(p.showStatus, true);
  assert.equal(normalizePrefs({ fontSize: "abc" }).fontSize, DEFAULT_PREFS.fontSize);
});

test("loadPrefs: round-trips, survives bad JSON, and migrates the legacy keys", () => {
  const prefs = normalizePrefs({ density: "focus", fontSize: 16, sendKey: "mod-enter", showHints: false });
  assert.deepEqual(loadPrefs(k => (k === PREFS_KEY ? serializePrefs(prefs) : "")), prefs);
  assert.deepEqual(loadPrefs(() => ""), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs(k => (k === PREFS_KEY ? "{oops" : "")), DEFAULT_PREFS);
  const legacy = loadPrefs(k => ({ "panel-font-size": "18", "panel-fit": "false" })[k] ?? "");
  assert.equal(legacy.fontSize, 18);
  assert.equal(legacy.fit, false);
  assert.equal(legacy.density, DEFAULT_PREFS.density);
});

test("computeScale: shrinks to width, enlarges only within width, cap and height", () => {
  const base = { fit: true, fitHeight: false, maxScale: 1.5, width: 800, height: 500, availW: 1600, availH: 2000 };
  assert.equal(computeScale({ ...base, availW: 400 }), 0.5);          // narrow frame: shrink as before
  assert.equal(computeScale(base), 1.5);                                // wide frame: capped by maxScale
  assert.equal(computeScale({ ...base, availH: 600 }), 1.2);          // height limits the enlargement
  assert.equal(computeScale({ ...base, availH: 400 }), 1);            // never below 1 because of height
  assert.equal(computeScale({ ...base, fit: false }), 1);
  assert.equal(computeScale({ ...base, maxScale: 1 }), 1);
  assert.equal(computeScale({ ...base, width: 0 }), 1);
  // Desktop: a terminal taller than its frame shrinks so its last row stays visible.
  const desk = { ...base, fitHeight: true };
  assert.equal(computeScale({ ...desk, availH: 250 }), 0.5);
  assert.equal(computeScale({ ...desk, availH: 400 }), 0.8);
  assert.equal(computeScale({ ...desk, availH: 600 }), 1.2);
  assert.equal(computeScale({ ...desk, fit: false, availH: 250 }), 1);
});

test("normalizePrefs: seamless live scrollback is on by default and can be switched off", () => {
  assert.equal(DEFAULT_PREFS.liveScrollback, true);
  assert.equal(normalizePrefs({ liveScrollback: "no" }).liveScrollback, true);
  assert.equal(normalizePrefs({ liveScrollback: false }).liveScrollback, false);
  assert.equal(loadPrefs(k => (k === PREFS_KEY ? serializePrefs(normalizePrefs({ liveScrollback: false })) : "")).liveScrollback, false);
});
