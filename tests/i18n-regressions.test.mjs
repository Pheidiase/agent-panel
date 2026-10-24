import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "@typescript/typescript6";
import { clientModules } from "./fixtures/client-modules.mjs";
import { clientDom } from "./fixtures/client-dom.mjs";
import { ImageUploads } from "../server/uploads.mjs";
import { PanelError } from "../server/session-store.mjs";

// Expose private helpers only in the in-memory test copy, not the application.
const expose = (source, file) => source + (file.endsWith("/StructuredView.tsx")
  ? "\nexport { ChatRow, ToolCard, CopyButton, foldEvents, itemText, ContextGauge };"
  : file.endsWith("/UsagePanel.tsx") ? "\nexport { resetText, Row, Block, summary, short };" : "");
function modules(react = React, extra = {}) {
  return clientModules({ react, "./question-card.css": {}, ...extra }, false, expose);
}
const png = bytes => { const buffer = Buffer.alloc(bytes); buffer.set([0x89, 0x50, 0x4e, 0x47]); return buffer; };

test("upload storage capacity and individual image size have distinct actionable errors", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-i18n-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const load = modules(), i18n = load("i18n.ts");
  const uploads = new ImageUploads(dir, { maxFiles: 1 }); uploads.save(png(16), "image/png");
  const cases = [
    [() => uploads.save(png(16), "image/png"), "UPLOAD_CAPACITY_FULL", /older uploads to expire/],
    [() => uploads.save(png(10 * 1024 * 1024 + 1), "image/png"), "IMAGE_TOO_LARGE", /10 MB limit/],
  ];
  for (const [save, code, english] of cases) {
    assert.throws(save, error => {
      assert.equal(error.status, 413); assert.equal(error.code, code);
      const response = { code: error.code, error: error.message };
      i18n.setLanguage("en"); assert.match(i18n.serverError(response), english);
      i18n.setLanguage("tr"); assert.equal(i18n.serverError(response), error.message);
      return true;
    });
  }
});
test("unmapped custom PanelErrors retain raw text rather than a translation based on HTTP status", () => {
  const i18n = modules()("i18n.ts");
  for (const language of ["en", "tr"]) {
    i18n.setLanguage(language);
    for (const status of [400, 409, 413, 503]) {
      const error = new PanelError(status, "custom action required");
      assert.equal(error.code, undefined);
      assert.equal(i18n.serverError({ code: error.code, error: error.message }), "custom action required");
    }
    const error = new PanelError(400, "Bu model seçilen düşünme düzeyini desteklemiyor.");
    assert.equal(error.code, "REASONING_EFFORT_UNSUPPORTED");
    assert.equal(i18n.serverError({ code: "FUTURE_CODE", error: "raw future error" }), "raw future error");
  }
});

async function mounted(t) {
  const dom = clientDom(), root = createRoot(dom.container), load = modules(), i18n = load("i18n.ts");
  t.after(async () => { await act(() => root.unmount()); dom.restore(); });
  i18n.setLanguage("tr");
  return { ...dom, load, i18n, root,
    render: async element => { await act(async () => { root.render(element); }); },
    language: async language => { await act(async () => { i18n.setLanguage(language); }); },
  };
}
function elements(node) { return [node, ...node.childNodes.flatMap(elements)]; }
function find(node, predicate) { const result = elements(node).find(predicate); assert.ok(result, "expected DOM element"); return result; }

test("mounted memo rows follow tr→en→tr with identical props, keys, focus and expanded cards", async t => {
  const f = await mounted(t), { ChatRow, ToolCard, CopyButton } = f.load("StructuredView.tsx");
  const common = { hit: false, current: false, awaiting: false, initial: true, root: { current: null }, follow: { current: false } };
  const thought = { type: "thought", key: 1, text: "agent reasoning" };
  const assistant = { type: "assistant", key: 2, text: "agent answer", id: "a" };
  const tool = { id: "tool", title: "Read", status: "completed", rawInput: { command: "pwd" } };
  await f.render(React.createElement(React.Fragment, null,
    React.createElement(ChatRow, { ...common, item: thought, key: thought.key }),
    React.createElement(ChatRow, { ...common, item: assistant, key: assistant.key }),
    React.createElement(React.memo(ToolCard), { tool, key: "tool" }),
    React.createElement(React.memo(CopyButton), { text: "copy me", key: "copy" })));
  const thoughtNode = find(f.container, n => n.tagName === "DETAILS" && n.className.includes("thought"));
  const toolNode = find(f.container, n => n.tagName === "DETAILS" && n.className.includes("tool-details"));
  const copyNode = f.container.lastChild;
  thoughtNode.open = true; toolNode.open = true; copyNode.focus();
  for (const [language, labels] of [["en", ["thought", "Assistant", "completed", "Command and output", "Copy"]], ["tr", ["düşünce", "Asistan", "tamamlandı", "Komut ve çıktı", "Kopyala"]]]) {
    await f.language(language);
    for (const label of labels) assert.ok(f.container.textContent.includes(label), label);
    assert.equal(find(f.container, n => n === thoughtNode), thoughtNode);
    assert.equal(find(f.container, n => n === toolNode), toolNode);
    assert.equal(f.container.lastChild, copyNode);
    assert.equal(f.document.activeElement, copyNode);
    assert.equal(thoughtNode.open, true); assert.equal(toolNode.open, true);
    assert.equal(copyNode.getAttribute("aria-label"), labels.at(-1));
  }
});

test("existing turn notices translate at display time while user/agent text stays intact", async t => {
  const f = await mounted(t), { ChatRow, foldEvents, itemText } = f.load("StructuredView.tsx");
  const events = [
    { seq: 1, kind: "user", text: "Ajan yanıtı hazır." },
    { seq: 2, kind: "assistant", id: "a", text: "Tur durduruldu." },
    { seq: 3, kind: "turn", stopReason: "completed" },
    { seq: 4, kind: "turn", stopReason: "cancelled" },
  ];
  const items = foldEvents(events), saved = JSON.stringify(items);
  assert.deepEqual(items[2], { type: "notice", key: 3, stopReason: "completed" });
  const outcome = f.load("ux-state.ts").latestTurnOutcome(events);
  await f.render(React.createElement(React.Fragment, null, ...items.map(item => React.createElement(ChatRow, {
    item, key: item.key, initial: true, hit: false, current: false, awaiting: false, root: { current: null }, follow: { current: false },
  }))));
  assert.match(f.container.textContent, /Ajan yanıtı hazır/);
  await f.language("en");
  assert.match(f.container.textContent, /Agent response is ready/); assert.match(f.container.textContent, /Turn stopped/);
  assert.equal(itemText(items[0]), events[0].text); assert.equal(itemText(items[1]), events[1].text);
  assert.equal(f.load("ux-state.ts").turnNotice(outcome.stopReason), "Turn stopped.");
  await f.language("tr");
  assert.equal(itemText(items[2]), "Ajan yanıtı hazır.");
  assert.equal(JSON.stringify(items), saved);
});

test("a visible question validation error and its parameter follow language changes", async t => {
  const f = await mounted(t), { QuestionCard } = f.load("QuestionCard.tsx");
  const question = "my question";
  await f.render(React.createElement(QuestionCard, {
    questions: [{ id: "q", header: question, question: "body", options: [] }], status: "requested", onAnswer() {}, onReject() {},
  }));
  await act(() => f.container.firstChild.dispatchEvent({ type: "submit" }));
  const alert = find(f.container, n => n.getAttribute?.("role") === "alert");
  assert.ok(alert.textContent.includes(question)); assert.match(alert.textContent, /yanıt/);
  await f.language("en"); assert.equal(find(f.container, n => n === alert), alert);
  assert.match(alert.textContent, /answer/i); assert.ok(alert.textContent.includes(question));
  await f.language("tr"); assert.match(alert.textContent, /yanıt/);
});

// Run the real API function without bootstrapping main.tsx or opening a socket.
function apiWith(fetchJson) {
  const file = "main.tsx", source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "api");
  assert.ok(declaration);
  const js = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("fetchJson", "csrf", js + "\nreturn api;")(fetchJson, "test-csrf");
}
test("API failures retain raw error/code/retryAfter and open question errors retranslate", async t => {
  const f = await mounted(t), { QuestionCard } = f.load("QuestionCard.tsx");
  const data = { error: "legacy rate limit", code: "LOGIN_LIMITED" };
  const api = apiWith(async () => ({ response: { ok: false, status: 429, headers: new Headers({ "Retry-After": "2" }) }, data }));
  let failure;
  try { await api("/test"); } catch (error) { failure = error; }
  assert.equal(failure.message, data.error); assert.equal(failure.code, data.code); assert.equal(failure.retryAfter, 2);
  await f.render(React.createElement(QuestionCard, {
    questions: [], status: "requested", onAnswer() {}, onReject() { throw failure; },
  }));
  const reject = find(f.container, n => n.tagName === "BUTTON" && n.getAttribute("type") === "button");
  await act(() => reject.dispatchEvent({ type: "click", button: 0 }));
  const alert = find(f.container, n => n.getAttribute?.("role") === "alert");
  assert.match(alert.textContent, /2 saniye/);
  await f.language("en"); assert.match(alert.textContent, /2 seconds/);
  await f.language("tr"); assert.match(alert.textContent, /2 saniye/);
  const socket = { reason: "AUTH_EXPIRED|Giriş süresi doldu" };
  const descriptor = { key: "chat.commentsAdded", params: { count: 2 } };
  for (const lang of ["en", "tr", "en"]) {
    await f.language(lang);
    assert.equal(f.i18n.messageText(socket), lang === "en" ? "Sign-in expired" : "Giriş süresi doldu");
    assert.equal(f.i18n.messageText(descriptor), f.i18n.t(descriptor.key, descriptor.params));
  }
});
test("API failures preserve zero retry delays from both response bodies and headers", async () => {
  for (const count of [0, 1, 2]) {
    for (const fromBody of [true, false]) {
      const data = { code: "LOGIN_LIMITED", error: "raw limit", ...(fromBody ? { retryAfter: count } : {}) };
      const api = apiWith(async () => ({ data, response: { ok: false, status: 429,
        headers: new Headers(fromBody ? {} : { "Retry-After": String(count) }) } }));
      await assert.rejects(api("/test"), failure => {
        assert.equal(failure.retryAfter, count); assert.equal(failure.message, "raw limit");
        return true;
      });
    }
  }
});

test("history deletion stores raw failures and fallback keys until display", () => {
  const load = modules(), i18n = load("i18n.ts");
  const source = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.tsx", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "errorText");
  const handler = source.slice(source.indexOf("  async function performHistoryDelete("), source.indexOf("  async function saveTitle("));
  const js = ts.transpileModule(declaration.getText(ast) + `
    async function run() {
      const historyDelete = [{ agentId: "a", id: "1" }], historyDeleteBusy = false;
      const historyKey = () => "a:1";
      let failure;
      const setHistoryDeleteBusy = () => {}, setHistoryDeleteError = value => { failure = value; };
      const setPast = () => {}, setPrefs = () => {}, setHistorySelection = () => {}, setHistoryDelete = () => {};
      const api = async () => ({ results: [{ key: "a:1", ok: false }, { key: "a:1", ok: false, error: "raw failure" }], prefs: {} });
      ${handler}
      await performHistoryDelete(); return { failure, text: () => errorText(failure) };
    }
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function("messageText", js + "\nreturn run;")(i18n.messageText);
  return run().then(result => {
    assert.deepEqual(result.failure, [{ key: "main.deleteFailed" }, "raw failure"]);
    for (const lang of ["tr", "en", "tr"]) {
      i18n.setLanguage(lang);
      assert.equal(result.text(), i18n.t("main.deleteFailed") + " raw failure");
    }
  });
});

test("visible usage refresh failure translates without refetching on language changes", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "fetch"); let calls = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { calls++; throw new Error("offline"); } });
  t.after(() => Object.defineProperty(globalThis, "fetch", original));
  const f = await mounted(t), { UsagePanel } = f.load("UsagePanel.tsx");
  await f.render(React.createElement(UsagePanel));
  assert.match(f.container.textContent, /Kota yenilenemedi/);
  await f.language("en"); assert.match(f.container.textContent, /quota/i); assert.doesNotMatch(f.container.textContent, /Kota yenilenemedi/);
  await f.language("tr"); assert.match(f.container.textContent, /Kota yenilenemedi/);
  assert.equal(calls, 1);
});

test("Turkish search button, ended placeholder, last-turn counter and history return keep their original text", async t => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const dom = clientDom(); t.after(() => dom.restore());
  // Render header slot content inline for this static text regression.
  const load = modules(React, { "./header-slots": { inSlot: node => node }, "@xterm/xterm": {}, "@xterm/addon-unicode11": {}, "@xterm/addon-web-links": {}, "@xterm/xterm/css/xterm.css": {} });
  load("i18n.ts").setLanguage("tr");
  const view = load("StructuredView.tsx");
  const markup = renderToStaticMarkup(React.createElement(view.default, { session: { id: "demo", status: "ended" }, request: assert.fail, onUnauthorized: assert.fail }));
  assert.match(markup, /chat-search-toggle[^]*?aria-label="Sohbette ara"[^]*?<span>Ara<\/span>/);
  assert.match(markup, /placeholder="Oturum sonlanmış"/);
  const gauge = renderToStaticMarkup(React.createElement(view.ContextGauge, { usage: { used: 50, size: 100 }, lastTurn: 42 }));
  assert.match(gauge, /class="ctx-turn"> · son tur 42<\/span>/);
  assert.match(gauge, /title="[^"]*son tur 42 token/);
  load("terminal-snapshots.ts").snapshots.set("demo", { text: "saved output", styled: {} });
  const terminal = load("TerminalView.tsx").default;
  const history = renderToStaticMarkup(React.createElement(terminal, { session: { id: "demo", status: "running" }, request: assert.fail, onUnauthorized: assert.fail }));
  assert.match(history, /class="reader-jump"[^]*?Canlıya dön<\/button>/);
  assert.equal(load("i18n.ts").t("terminal.goToLive"), "Canlıya in");
});

// Locale-neutral brands, protocol/file names, keyboard legends and punctuation
// are the only exceptions. Keep them explicit so ASCII-only Turkish is caught.
const literalExceptions = new Map([
  ["*", new Set(["(", ")", ":", "—", "+", "−", "/", "·", "$", ".", ",", "×", "↑", "↓", "↵", "…", "✓", "· +", "", " "])],
  ["Palette.tsx", new Set(["Esc"])],
  ["TerminalView.tsx", new Set(["A−", "A+"])],
  ["RunsView.tsx", new Set([": jobs.json", "· executions.db"])],
  ["UsagePanel.tsx", new Set(["Codex", "Claude"])],
  ["main.tsx", new Set(["Agent Panel", "agent", "panel", "Ctrl K", "v", "✳", "Ubuntu · ~", "Hermes ACP", "tmux", "beta"])],
]);
// İsteğe bağlı modüllerin kendi tarafsız-metin istisnaları tests/fixtures/literals-*.mjs içinde durur.
const fixtures = new URL("./fixtures/", import.meta.url);
for (const file of fs.readdirSync(fixtures).filter(file => /^literals-.*\.mjs$/.test(file)))
  for (const [name, texts] of Object.entries((await import(new URL(file, fixtures))).default)) literalExceptions.set(name, new Set(texts));
function outputLiterals(node) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(span => [...outputLiterals(span.expression), span.literal.text])];
  if (ts.isParenthesizedExpression(node)) return outputLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...outputLiterals(node.whenTrue), ...outputLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return outputLiterals(node.right);
    if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(op))
      return [...outputLiterals(node.left), ...outputLiterals(node.right)];
  }
  return [];
}
function scanLiterals(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), found = [];
  function collect(node, values) {
    const line = sf.getLineAndCharacterOfPosition(node.pos).line + 1;
    for (const text of values.map(text => text.trim()))
      if (!literalExceptions.get("*").has(text) && !literalExceptions.get(file)?.has(text)) found.push(`${file}:${line}: ${text}`);
  }
  function visit(node) {
    if (ts.isJsxText(node)) collect(node, [node.text]);
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) collect(node, outputLiterals(node.expression));
    if (ts.isJsxAttribute(node) && ["title", "aria-label", "placeholder"].includes(node.name.getText(sf))) {
      const value = node.initializer;
      collect(node, value && ts.isJsxExpression(value) ? outputLiterals(value.expression) : outputLiterals(value));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf); return found;
}
test("every JSX text node and title/aria-label/placeholder literal uses the dictionary or an explicit neutral exception", () => {
  const root = new URL("../src/", import.meta.url), violations = [];
  for (const file of fs.readdirSync(root, { recursive: true }).filter(file => /\.tsx?$/.test(file)))
    violations.push(...scanLiterals(fs.readFileSync(new URL(file, root), "utf8"), file));
  assert.deepEqual(violations, []);
  for (const text of ["En sona", "Asistan", "son:", "5 sa", "kalan", "kod", "Ara"]) {
    for (const source of [`<b>${text}</b>`, `<b title="${text}"/>`, `<b aria-label={\`label ${text}\`}/>`, `<b placeholder={ok ? "${text}" : t("chat.search")}/>`])
      assert.ok(scanLiterals(source, "sample.tsx").length, source);
  }
});

test("formerly untranslated labels render in English", async t => {
  const f = await mounted(t), { ChatRow } = f.load("StructuredView.tsx"), usage = f.load("UsagePanel.tsx");
  await f.language("en");
  const win = { usedPercent: 50, resetsAt: null, stale: false };
  const code = f.load("markdown.tsx").renderMarkdown("```\nconst x = 1;\n```");
  await f.render(React.createElement(React.Fragment, null,
    React.createElement(ChatRow, { item: { key: 1, type: "assistant", text: "answer" }, initial: true, root: { current: null }, follow: { current: false } }),
    React.createElement(usage.Block, { id: "codex", name: "Codex", src: { available: true, fiveHour: win, weekly: win }, now: Date.now(), detay: false }), code));
  assert.match(f.container.textContent, /Assistant/); assert.match(f.container.textContent, /5 hr/); assert.match(f.container.textContent, /code/);
  assert.equal(find(f.container, n => n.getAttribute?.("role") === "meter").getAttribute("aria-label"), "5 hr remaining");
  assert.equal(f.i18n.t("runs.lastAt", { time: "12:30" }), "last: 12:30");
  assert.equal(f.i18n.t("chat.jumpLatest"), "Jump to latest");
});

test("English count boundaries 0/1/2 and active-locale percentages", async t => {
  const f = await mounted(t), usage = f.load("UsagePanel.tsx");
  await f.language("en");
  const now = 1_800_000_000_000;
  for (const count of [0, 1, 2]) {
    assert.equal(f.i18n.t("usage.dayShort", { count }), count === 1 ? "day" : "days");
    assert.equal(f.i18n.t("usage.daysAgo", { count }), `${count} ${count === 1 ? "day" : "days"} ago`);
    assert.match(f.i18n.t("questionCard.deadlineHint", { count }), new RegExp(`within ${count} ${count === 1 ? "second\\." : "seconds\\."}`));
    assert.match(f.i18n.serverError({ code: "LOGIN_LIMITED", retryAfter: count }), new RegExp(`${count} ${count === 1 ? "second\\." : "seconds\\."}`));
    assert.equal(usage.resetText({ resetsAt: now / 1000 + count * 86400 }, now), count ? `${count} ${count === 1 ? "day" : "days"} 0 hr` : "0 min");
    for (const [key, noun] of [["chat.lastTurn", "token"], ["chat.recordCount", "record"], ["conv.resultLines", "line"],
      ["runs.failureStreak", "failure"], ["changes.group", "comment"], ["changes.batchesNote", "group"], ["chat.skippedLargeChanges", "change"]]) {
      assert.match(f.i18n.t(key, { count, index: 1 }), new RegExp(`${count} (?:consecutive |large )?${noun}${count === 1 ? "" : "s"}\\b`));
    }
  }
  for (const language of ["tr", "en", "tr"]) {
    await f.language(language);
    for (const value of [0, 1, 2, 50, 100]) {
      const expected = language === "en" ? `${value}%` : `%${value}`;
      assert.equal(f.i18n.formatPercent(value), expected);
      assert.equal(usage.short({ available: true, fiveHour: { usedPercent: 100 - value } }), expected);
      assert.equal(f.i18n.t("usage.week", { left: value }), `${language === "en" ? "week" : "hafta"} ${expected}`);
      await f.render(React.createElement(usage.Row, { label: "quota", win: { usedPercent: 100 - value }, now, detay: false }));
      const row = find(f.container, n => n.className === "usage-left");
      assert.equal(row.textContent, expected);
      assert.ok(f.container.firstChild.getAttribute("title").includes(f.i18n.formatPercent(100 - value)));
    }
    const text = f.i18n.t("usage.remainingPace", { now: 50, end: 25 });
    assert.ok(text.includes(language === "en" ? "50%" : "%50"));
  }
});
