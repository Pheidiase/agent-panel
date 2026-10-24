import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clientModules } from "./fixtures/client-modules.mjs";

const require = createRequire(import.meta.url);
const read = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", "modules", js)(name => name in dependencies ? dependencies[name] : name.endsWith(".css") ? {} : require(name), exports, modules);
  return exports;
}
const modules = clientModules();
modules("i18n.ts").setLanguage("tr");
const ux = modules("ux-state.ts");
const { dialogStack, installDialogFocus } = modules("dialog-focus.ts");
const main = read("main.tsx"), chat = read("StructuredView.tsx");

// A tiny hook host exercises event handlers and effects without a server or browser port.
function hooks() {
  const values = [], dependencies = [], effects = [];
  let cursor = 0;
  return {
    react: { ...React,
      useId: () => "test",
      useState(initial) {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
        return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
      },
      useEffect(fn, deps) {
        const index = cursor++;
        if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) effects.push(fn);
        dependencies[index] = deps;
      },
    },
    render(Component, props) {
      cursor = 0;
      const tree = Component(props);
      effects.splice(0).forEach(fn => fn());
      return tree;
    },
  };
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...elements(node.props.children)];
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join("");
  return node?.props ? content(node.props.children) : typeof node === "string" ? node : "";
}

test("#3 settings footer uses the same close guard and cannot close during save", () => {
  const { canCloseSettings } = ux;
  assert.equal(canCloseSettings(true, true, assert.fail), false);
  assert.equal(canCloseSettings(true, false, assert.fail), false);
  assert.equal(canCloseSettings(false, false, assert.fail), true);
  assert.equal(canCloseSettings(false, true, () => false), false);
  assert.equal(canCloseSettings(false, true, () => true), true);
});

test("#4 mobile entry works in overview and session; pending filter and card labels exist", () => {
  const overview = main.slice(main.indexOf('<header className="topbar">'), main.indexOf('<div className="workspace">'));
  const session = main.slice(main.indexOf('<button className="session-switcher"') - 700);
  for (const surface of [overview, session]) {
    assert.match(surface, /className="inbox-bell mobile-inbox icon-button"/);
    assert.match(surface, /setInboxOpen\(true\)/);
    assert.match(surface, /t\("main.attentionCounts", \{ pending: inbox.events.filter\(isPending\).length, unread: inbox.unread \}\)/);
  }
  assert.match(main, /statusFilter === "attention" \? inbox.events.some\(e => e.sessionId === s.id && isPending\(e\)\)/);
  assert.match(main, /\["attention",t\("main.attention"\)\]/);
  assert.match(main, /t\("main.questionPending"\).*t\("main.approvalPending"\)/);
  assert.match(read("defter/shell.css"), /@media \(max-width: 800px\) \{\s*\.mobile-inbox \{ display: grid/);
});

test("#5 stack follows opening order, not DOM order; removal and reopening stay deterministic", () => {
  assert.deepEqual(dialogStack(["new"], ["palette", "new"]), ["new", "palette"]);
  assert.deepEqual(dialogStack(["new", "palette"], ["palette", "new"]), ["new", "palette"]);
  assert.deepEqual(dialogStack(["new", "palette"], ["new"]), ["new"]);
  assert.deepEqual(dialogStack(["palette"], ["new", "palette"]), ["palette", "new"]);
});

test("#5/#7 focus manager aligns z-index, inert, Tab, Escape, initial focus and return focus", () => {
  const originals = ["document", "window", "HTMLElement", "MutationObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let sync, focusin, keydown;
  class Element {
    constructor(name, parent = null) {
      this.name = name; this.parentElement = parent; this.children = []; parent?.children.push(this);
      this.style = { zIndex: "" }; this.inert = false; this.isConnected = true; this.tabIndex = 0;
      this.shown = true; this.modal = false;
    }
    getClientRects() { return this.shown && this.isConnected ? [1] : []; }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    matches(selector) { return selector === '.drawer-backdrop' && this.name === 'backdrop'; }
    closest(selector) {
      if (selector.includes('role="dialog"')) {
        let node = this;
        while (node && !node.modal) node = node.parentElement;
        return node;
      }
      return this.host || null;
    }
    hasAttribute() { return true; }
    querySelector(selector) { return selector === '[data-dialog-initial]' ? this.initial : this.close; }
    querySelectorAll() { return this.children; }
    focus() { document.activeElement = this; focusin?.({ target: this }); }
    click() { this.clicked = true; }
  }
  const body = new Element("body"), page = new Element("page", body), opener = new Element("opener", page);
  const drawer = new Element("drawer", page), search = new Element("search", drawer), closeDrawer = new Element("close", drawer);
  drawer.modal = true; drawer.initial = search; drawer.close = closeDrawer;
  const paletteHost = new Element("palette-host", body), palette = new Element("palette", paletteHost), input = new Element("input", palette), closePalette = new Element("close-palette", palette);
  palette.modal = true; palette.host = paletteHost; palette.close = closePalette; palette.shown = false;
  const back = new Element("backdrop", page);
  const domOrder = [palette, drawer];
  try {
    Object.assign(globalThis, {
      HTMLElement: Element,
      document: { body, activeElement: opener, querySelectorAll: () => domOrder.filter(el => el.modal), addEventListener(_, fn) { focusin = fn; }, removeEventListener() {} },
      window: { addEventListener(_, fn) { keydown = fn; }, removeEventListener() {} },
      MutationObserver: class { constructor(fn) { sync = fn; } observe() {} disconnect() {} },
    });
    const cleanup = installDialogFocus();
    assert.equal(document.activeElement, search);
    assert.equal(opener.inert, true); assert.equal(back.inert, false);
    palette.shown = true; input.focus();
    assert.equal(document.activeElement, input, "React autoFocus may precede observer registration");
    sync();
    assert.equal(document.activeElement, input);
    assert.equal(page.inert, true);
    assert.ok(+paletteHost.style.zIndex > +drawer.style.zIndex);
    // Clicking or programmatically focusing the underlying modal must not steal focus.
    closeDrawer.focus(); assert.equal(document.activeElement, input);
    closePalette.focus();
    const key = (value, shiftKey = false) => keydown({ key: value, shiftKey, preventDefault() {}, stopImmediatePropagation() {} });
    key("Tab"); assert.equal(document.activeElement, input);
    key("Tab", true); assert.equal(document.activeElement, closePalette);
    key("Escape"); assert.equal(closePalette.clicked, true); assert.equal(closeDrawer.clicked, undefined);
    palette.shown = false; sync(); assert.equal(document.activeElement, search);
    assert.equal(paletteHost.style.zIndex, "");
    drawer.modal = false; sync(); assert.equal(document.activeElement, opener);
    assert.equal(opener.inert, false);
    drawer.modal = true; sync(); assert.equal(document.activeElement, search);
    cleanup(); assert.equal(opener.inert, false); assert.equal(drawer.style.zIndex, "");
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
  assert.match(main, /role=\{session && drawerOpen && narrow \? "dialog" : undefined\} aria-modal=\{session && drawerOpen && narrow \? true : undefined\}/);
  assert.match(main, /data-dialog-initial placeholder=\{t\("main.searchChatsPlaceholder"\)\}/);
  assert.match(main, /media.addEventListener\("change", update\)/);
});

test("#9 stale and expired quota readings never claim verified 100%; age handles missing and future times", () => {
  const now = 1_800_000_000_000;
  assert.equal(ux.quotaReading({ usedPercent: 0, stale: true }, now).remaining, null);
  assert.equal(ux.quotaReading({ usedPercent: 87, resetsAt: now / 1000 - 1 }, now).remaining, null);
  assert.match(ux.quotaReading({ usedPercent: 0, stale: true }, now).label, /güncel okuma bekleniyor/);
  assert.equal(ux.quotaReading({ usedPercent: 87, resetsAt: now / 1000 + 1 }, now).remaining, 13);
  assert.equal(ux.quotaReading({ usedPercent: 0, stale: false }, now).remaining, 100);
  assert.equal(ux.quotaAge(now - 120_000, now), "Son okuma: 2 dk önce");
  assert.equal(ux.quotaAge(now + 120_000, now), "Son okuma: 0 dk önce");
  assert.match(ux.quotaAge(undefined, now), /bilinmiyor/);
});

test("#11 countdown announces only 60s, 20s and expiry thresholds", () => {
  assert.equal(ux.deadlineNotice(null), "");
  assert.equal(ux.deadlineNotice(61), "");
  assert.equal(ux.deadlineNotice(60), ux.deadlineNotice(21));
  assert.match(ux.deadlineNotice(60), /60 saniye/);
  assert.equal(ux.deadlineNotice(20), ux.deadlineNotice(1));
  assert.match(ux.deadlineNotice(20), /20 saniye/);
  assert.match(ux.deadlineNotice(0), /Süre doldu.*yeniden/);
  assert.match(chat, /role="status" aria-atomic="true">\{deadlineNotice\(remain\)\}/);
});

test("#11 question draft survives timeout and server expiry; retry prepares a message without sending", () => {
  const host = hooks();
  const questionI18n = modules("i18n.ts");
  const { QuestionCard } = compile("const window = { setInterval() { return 1; }, clearInterval() {} };\n" + read("QuestionCard.tsx"), { react: host.react, "./ux-state": ux, "./i18n": { useI18n: () => ({ t: questionI18n.t }) } });
  let sent = 0, retried = 0;
  const props = { questions: [{ id: "q", question: "Ne yapalım?", options: [] }], status: "requested", onAnswer() { sent++; }, onReject() { sent++; }, onRetry() { retried++; } };
  let tree = host.render(QuestionCard, props);
  elements(tree).find(el => el.type === "textarea").props.onChange({ target: { value: "Yarım kalan yanıtım" } });
  // A local deadline expires before the server delivers its expiry event.
  for (const status of ["requested", "expired"]) {
    tree = host.render(QuestionCard, { ...props, status, expiresAt: new Date(Date.now() - 1000).toISOString() });
    tree = host.render(QuestionCard, { ...props, status, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(elements(tree).find(el => el.type === "textarea").props.value, "Yarım kalan yanıtım");
    assert.equal(elements(tree).find(el => el.type === "fieldset").props.disabled, false);
    assert.equal(elements(tree).find(el => el.type === "textarea").props.readOnly, true);
    assert.match(content(tree), /Süre uzatılamıyor/);
  }
  elements(tree).find(el => el.type === "button" && content(el).includes("mesaj hazırla")).props.onClick();
  assert.equal(retried, 1); assert.equal(sent, 0);
  assert.match(chat, /approval.questions\?\.length && approval.status === "expired"/);
  assert.match(chat, /setDraft\(current => \(current \? current \+ "\\n\\n" : ""\) \+ t\("chat.retryExpiredDraft"\)/);
});

test("#12 outcome comes from this turn, never old assistant content or connection idle", () => {
  const events = [{ seq: 1, kind: "user" }, { seq: 2, kind: "assistant" }, { seq: 3, kind: "turn", stopReason: "end_turn" }];
  assert.equal(ux.turnNotice(ux.latestTurnOutcome(events).stopReason), "Ajan yanıtı hazır.");
  events.push({ seq: 4, kind: "user" });
  assert.equal(ux.latestTurnOutcome(events), null);
  events.push({ seq: 5, kind: "turn", stopReason: "cancelled" });
  assert.deepEqual(ux.latestTurnOutcome(events), { seq: 5, stopReason: "cancelled" });
  for (const reason of ["failed", "error_during_execution", "max_tokens", undefined]) assert.doesNotMatch(ux.turnNotice(reason), /hazır|tamamlandı/);
  events.push({ seq: 6, kind: "error" });
  assert.match(ux.turnNotice(ux.latestTurnOutcome(events).stopReason), /başarısız/);
  assert.deepEqual(ux.latestTurnOutcome([...events]), ux.latestTurnOutcome(events), "reconnect/snapshot doesn't change the announcement");
  assert.match(chat, /aria-live="polite" aria-atomic="true">\{outcome \? turnNotice\(outcome.stopReason\) : ""\}/);
  // The extracted function references the same pure decision used by the live region.
  const folded = compile('const i18n_1 = { t: modules("i18n.ts").t };\nconst turnNotice = ' + ux.turnNotice.toString() + ';\n' + chat.slice(chat.indexOf("function foldEvents("), chat.indexOf("function foldApprovals(")) + '\nexport { foldEvents };');
  const notice = folded.foldEvents(events).find(item => item.key === 5);
  assert.deepEqual(notice, { type: "notice", key: 5, stopReason: "cancelled" });
  assert.equal(ux.turnNotice(notice.stopReason), "Tur durduruldu.");
});

function contrast(a, b) {
  const luminance = hex => {
    const rgb = hex.match(/[a-f\d]{2}/gi).map(x => parseInt(x, 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}
test("#13 critical text contrasts exceed 4.5:1 in light, automatic dark and explicit dark themes", () => {
  const css = read("defter/tokens.css");
  const danger = [...css.matchAll(/--danger: (#[a-f\d]{6});/g)].map(m => m[1]);
  const ink = [...css.matchAll(/--danger-ink: (#[a-f\d]{6});/g)].map(m => m[1]);
  assert.equal(danger.length, 3); assert.equal(ink.length, 3);
  danger.forEach((background, index) => assert.ok(contrast(background, ink[index]) >= 4.5, `${ink[index]} / ${background}`));
  const hermes = css.match(/--agent-hermes: (#[a-f\d]{6});/)[1];
  assert.ok(contrast(hermes, "#ffffff") >= 4.5);
  assert.match(css, /background: var\(--danger\); color: var\(--danger-ink\)/);
});

test("#16 tool diffs have visible before/after labels and describe empty content", () => {
  const source = chat.slice(chat.indexOf("function ToolCard("), chat.indexOf("export default function StructuredView("));
  const withHelpers = compile('const { t, useI18n } = require("./i18n"); const TOOL_STATUS = {}; const toolIcon = () => null; const CopyButton = () => null;\n' + source + '\nexport { ToolCard };', { "./i18n": modules("i18n.ts") });
  for (const [oldText, newText] of [["", "nový"], ["starý", ""], ["starý", "nový"]]) {
    const markup = renderToStaticMarkup(React.createElement(withHelpers.ToolCard, { tool: { id: "t", status: "completed", content: [{ type: "diff", oldText, newText }] } }));
    assert.match(markup, /<strong>Önce<\/strong>/); assert.match(markup, /<strong>Sonra<\/strong>/);
    if (!oldText) assert.match(markup, /Önce içerik yoktu/);
    if (!newText) assert.match(markup, /İçerik silindi/);
  }
});

test("#17 agent picker has radio keyboard semantics; page navigation exposes selection", () => {
  assert.match(main, /className="agent-options" role="radiogroup".*radioKeys\(event, agents.filter/);
  assert.match(main, /role="radio" aria-checked=\{newAgent === a.id\} tabIndex=\{newAgent === a.id \? 0 : -1\} data-id=\{a.id\}/);
  for (const view of ["sessions", "history", "runs"]) assert.ok(main.includes(`aria-current={view === "${view}"`));
});
