import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";
import { clientModules } from "./fixtures/client-modules.mjs";

const modules = clientModules();
modules("i18n.ts").setLanguage("tr");

async function load(name) {
  if (name === "storage") return modules("storage.ts");
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}
const { startTitle, clearSubmitted, radioKeys, closeSuggestions } = await load("input-state");

test("automatic titles respect the server's UTF-16 limit without splitting emoji", () => {
  const server = fs.readFileSync(new URL("../server/codex-manager.mjs", import.meta.url), "utf8");
  assert.match(server, /title.length > 80/);
  assert.equal(startTitle("😀".repeat(41)), "😀".repeat(40));
  assert.equal(startTitle("a".repeat(79) + "😀"), "a".repeat(79));
  assert.equal(startTitle("a".repeat(78) + "😀x"), "a".repeat(78) + "😀");
  assert.equal(startTitle("  iş\tadı\nmesaj  "), "iş adı");
  assert.equal(startTitle("a".repeat(81)).length, 80);
});

test("delayed session creation clears only the exact submitted draft, including whitespace", async () => {
  for (const submitted of ["ilk mesaj", "  ilk mesaj\n"]) {
    let current = submitted;
    const complete = async () => { await Promise.resolve(); current = clearSubmitted(current, submitted); };
    const pending = complete();
    current += "yeni metin";
    await pending;
    assert.equal(current, submitted + "yeni metin");
    assert.equal(clearSubmitted(submitted, submitted), "");
  }
  const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /clearSubmitted\(current, firstMessage\)/, "parallel dialog uses the same protection");
  assert.match(main, /clearSubmitted\(current, submittedText\)/);
});

test("radio navigation captures the group before React resets currentTarget", () => {
  for (const [key, current, expected] of [
    ["ArrowRight", "a", "b"], ["ArrowDown", "b", "a"],
    ["ArrowLeft", "a", "b"], ["ArrowUp", "b", "a"],
    ["Home", "b", "a"], ["End", "a", "b"],
  ]) {
    let callback, chosen, focused, prevented = false;
    const event = { key, preventDefault() { prevented = true; }, currentTarget: {
      querySelector(selector) { return { focus() { focused = selector; } }; },
    } };
    radioKeys(event, ["a", "b"], current, id => { chosen = id; }, fn => { callback = fn; });
    event.currentTarget = null;
    callback();
    assert.equal(chosen, expected);
    assert.equal(focused, `[data-id="${expected}"]`);
    assert.equal(prevented, true);
  }
  radioKeys({ key: "Home", preventDefault: assert.fail }, [], "", assert.fail, assert.fail);
});

test("session drafts and one-shot autosend survive disabled storage and failed clears", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw Error("disabled"); } });
  try {
    const { stored, remember, sessionStorageFailed } = await load("storage");
    for (const kind of ["terminal", "structured"]) {
      const draft = `panel-draft-${kind}`, auto = `panel-autosend-${kind}`;
      assert.equal(remember(draft, "ilk mesaj", true), false);
      if (kind === "structured") remember(auto, "ilk mesaj", true);
      assert.equal(stored(draft, "", true), "ilk mesaj");
      if (kind === "structured") {
        assert.equal(stored(auto, "", true), "ilk mesaj");
        remember(auto, "", true);
        assert.equal(stored(auto, "", true), "", "autosend cannot replay after a failed storage clear");
      }
      remember(draft, "yeni taslak", true);
      assert.equal(stored(draft, "", true), "yeni taslak");
    }
    assert.equal(sessionStorageFailed(), true);
  } finally {
    if (old) Object.defineProperty(globalThis, "sessionStorage", old);
    else delete globalThis.sessionStorage;
  }
});

test("a quota failure cannot restore an old draft or a consumed autosend marker", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem() { return "eski mesaj"; },
    setItem() { throw Error("QuotaExceededError"); },
  } });
  try {
    const { stored, remember } = await load("storage");
    for (const key of ["panel-draft-quota", "panel-autosend-quota"]) {
      assert.equal(stored(key, "", true), "eski mesaj");
      remember(key, "yeni mesaj", true);
      assert.equal(stored(key, "", true), "yeni mesaj");
      remember(key, "", true);
      assert.equal(stored(key, "", true), "");
    }
  } finally {
    if (old) Object.defineProperty(globalThis, "sessionStorage", old);
    else delete globalThis.sessionStorage;
  }
});

test("closing suggestions cancels queued work and invalidates late responses", async () => {
  let fired = false;
  const token = { current: 4 }, requestToken = token.current;
  const timer = { current: setTimeout(() => { fired = true; }, 0) };
  const state = closeSuggestions(token, timer);
  assert.deepEqual(state, { open: false, query: "", start: 0, items: [], active: 0 });
  assert.notEqual(token.current, requestToken, "in-flight response is stale");
  assert.equal(timer.current, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fired, false);
  const view = fs.readFileSync(new URL("../src/StructuredView.tsx", import.meta.url), "utf8");
  assert.match(view, /await request\(`\/sessions\/\$\{session.id\}\/prompt`[\s\S]*?closeMention\(\);\s*setDraft/);
  assert.match(view, /if \(!match\) \{\s*closeMention\(\)/);
  assert.match(view, /onBlur=\{[\s\S]*?contains\(event.relatedTarget[\s\S]*?closeMention\(\)/);
});

test("clipboard confirms only real success, cleans fallback and restores focus", async () => {
  const { copyText } = await load("clipboard");
  const originals = ["navigator", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    for (const outcome of [true, false, "throw", "modern"]) {
      let removed = 0, restored = 0, appended = 0;
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
        async writeText() { if (outcome !== "modern") throw Error("denied"); },
      } } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        activeElement: { focus() { restored++; } },
        createElement() { return { style: {}, select() {}, remove() { removed++; } }; },
        body: { appendChild() { appended++; } },
        execCommand() { if (outcome === "throw") throw Error("denied"); return outcome; },
      } });
      assert.equal(await copyText("kod"), outcome === true || outcome === "modern");
      assert.equal(removed, outcome === "modern" ? 0 : 1);
      assert.equal(restored, removed);
      assert.equal(appended, removed);
    }
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
