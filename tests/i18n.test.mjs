import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { clientModules } from "./fixtures/client-modules.mjs";
import { loadLocales, loadOptionalServerModules } from "./fixtures/locales.mjs";
import { ERROR_CODES, STATUS_CODES } from "../server/error-codes.mjs";
import { PanelError } from "../server/session-store.mjs";

const load = clientModules();
const { tr, en } = loadLocales(load);
await loadOptionalServerModules();
const src = path.resolve(import.meta.dirname, "../src");
const server = path.resolve(import.meta.dirname, "../server");
function sources(dir, extensions) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(path.join(dir, entry.name), extensions)
    : extensions.some(ext => entry.name.endsWith(ext)) ? [path.join(dir, entry.name)] : []);
}
function ast(file, visit) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function walk(node) { visit(node, sf); ts.forEachChild(node, walk); }
  walk(sf);
}
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test("Turkish and English have identical keys and placeholders", () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(tr[key].length && en[key].length, key);
    assert.deepEqual(placeholders(tr[key]), placeholders(en[key]), key);
  }
});
test("every literal t() key in client source exists in both dictionaries", () => {
  let calls = 0;
  for (const file of sources(src, [".ts", ".tsx"])) ast(file, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "t") return;
    const key = node.arguments[0];
    if (!key || !ts.isStringLiteralLike(key)) return;
    calls++;
    assert.ok(Object.hasOwn(tr, key.text) && Object.hasOwn(en, key.text), `${file}: ${key.text}`);
  });
  assert.ok(calls > 150, `Scanned ${calls} calls`);
});
test("public server codes, auth codes and WebSocket reason codes all have translations", () => {
  const codes = new Set([...Object.values(ERROR_CODES), ...Object.values(STATUS_CODES)]);
  for (const file of sources(server, [".mjs"])) ast(file, node => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "code" && ts.isStringLiteralLike(node.initializer)) codes.add(node.initializer.text);
    if (!ts.isCallExpression(node)) return;
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "close" && node.arguments[1] && ts.isStringLiteralLike(node.arguments[1])) {
      const reason = node.arguments[1].text;
      assert.match(reason, /^[A-Z_]+\|/);
      assert.ok(Buffer.byteLength(reason) <= 123, reason);
      codes.add(reason.split("|")[0]);
    }
    if (node.expression.getText() === "AuthError" && node.arguments?.[2]) codes.add(node.arguments[2].text);
  });
  // AuthError constructors are NewExpressions rather than CallExpressions.
  for (const file of sources(server, [".mjs"])) ast(file, node => {
    if (ts.isNewExpression(node) && node.expression.getText() === "AuthError" && node.arguments?.[2] && ts.isStringLiteralLike(node.arguments[2])) codes.add(node.arguments[2].text);
  });
  for (const code of codes) assert.ok(Object.hasOwn(en, `server.${code}`) && Object.hasOwn(tr, `server.${code}`), code);
  for (const [message, code] of Object.entries(ERROR_CODES)) assert.ok(Buffer.byteLength(`${code}|${message}`) <= 123, code);
});
test("PanelError preserves legacy text and carries a stable validation/limit code", () => {
  for (const [status, message, code] of [[404, "Session bulunamadı.", "SESSION_NOT_FOUND"], [409, "En fazla 8 açık session olabilir.", "SESSION_LIMIT"], [400, "Geçersiz terminal ölçüsü.", "GEOMETRY_INVALID"]]) {
    const failure = new PanelError(status, message);
    assert.equal(failure.message, message); assert.equal(failure.status, status); assert.equal(failure.code, code);
  }
});
function globalValue(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
}
function browser(t, language, saved) {
  const values = new Map(saved ? [["panel-language", saved]] : []), events = new Map();
  globalValue(t, "navigator", { language });
  globalValue(t, "document", { documentElement: { lang: "" } });
  globalValue(t, "localStorage", { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  globalValue(t, "window", { addEventListener: (key, listener) => events.set(key, listener) });
  return { values, events };
}
test("preference overrides navigator; auto follows browser changes and updates html lang", t => {
  const { values, events } = browser(t, "tr-CY", "en");
  const notifications = []; let subscribe;
  const i18n = clientModules({ react: { useSyncExternalStore: callback => { subscribe = callback; } } })("i18n.ts");
  assert.equal(i18n.getLanguage(), "en"); assert.equal(document.documentElement.lang, "en");
  i18n.useI18n(); const unsubscribe = subscribe(() => notifications.push(i18n.getLanguage()));
  i18n.setLanguage("auto");
  assert.equal(values.get("panel-language"), "auto"); assert.equal(i18n.getLocale(), "tr-TR");
  assert.equal(document.documentElement.lang, "tr");
  navigator.language = "de-DE"; events.get("languagechange")();
  assert.equal(i18n.getLanguage(), "en"); assert.equal(i18n.getLocale(), "en-US");
  values.set("panel-language", "tr"); events.get("storage")({ key: "panel-language" });
  assert.equal(i18n.getLanguage(), "tr"); assert.equal(document.documentElement.lang, "tr");
  values.delete("panel-language"); events.get("storage")({ key: null }); assert.equal(i18n.getLanguage(), "en");
  assert.deepEqual(notifications, ["tr", "en", "tr", "en"]); unsubscribe();
});
test("invalid preference falls back to auto; blocked storage still allows in-page selection", t => {
  browser(t, "TR-tr", "junk");
  t.mock.method(localStorage, "getItem", () => { throw new Error("blocked"); });
  t.mock.method(localStorage, "setItem", () => { throw new Error("blocked"); });
  const i18n = clientModules()("i18n.ts");
  assert.equal(i18n.getLanguage(), "tr"); i18n.setLanguage("en"); assert.equal(i18n.getLanguage(), "en");
});
test("interpolation, server-code translation and legacy errors work in both languages", t => {
  browser(t, "en-US"); const i18n = clientModules()("i18n.ts");
  assert.equal(i18n.t("main.selectTitle", { title: "{count}" }), "Select {count}");
  assert.equal(i18n.t("main.sessionCount", { count: 0 }), "0 sessions");
  assert.equal(i18n.t("main.sessionCount", { count: 1 }), "1 session");
  assert.equal(i18n.t("main.sessionCount", { count: 2 }), "2 sessions");
  assert.equal(i18n.serverError({ code: "LOGIN_FAILED", error: "old" }), en["server.LOGIN_FAILED"]);
  assert.match(i18n.serverError({ code: "LOGIN_LIMITED", retryAfter: 17 }), /17 seconds/);
  assert.equal(i18n.serverError({ code: "FUTURE", error: "legacy" }), "legacy");
  assert.equal(i18n.serverError({ error: "old server" }), "old server");
  assert.equal(i18n.socketError("AUTH_EXPIRED|Giriş süresi doldu"), "Sign-in expired");
  assert.equal(i18n.socketError("legacy reason"), "legacy reason");
  i18n.setLanguage("tr");
  assert.equal(i18n.t("auth.title"), "Agent Panel'e giriş");
  assert.match(i18n.t("auth.limited", { count: 17 }), /17 saniye/);
  assert.equal(i18n.socketError("AUTH_EXPIRED|Giriş süresi doldu"), "Giriş süresi doldu");
});
test("missing translations warn once in development and fall back to English in production", t => {
  browser(t, "tr-TR"); const warnings = []; t.mock.method(console, "warn", value => warnings.push(value));
  for (const development of [true, false]) {
    const modules = clientModules({}, development), i18n = modules("i18n.ts");
    delete modules("locales/tr.ts").default["auth.title"];
    assert.equal(i18n.t("auth.title"), en["auth.title"]); i18n.t("auth.title");
    assert.equal(i18n.t("missing.key"), "missing.key");
    assert.equal(i18n.t("toString"), "toString");
  }
  assert.equal(warnings.length, 3);
});

test("date and number formatting follows changes without reloading the module", t => {
  browser(t, "tr-TR"); const modules = clientModules(), i18n = modules("i18n.ts");
  const { clock, dayLabel } = modules("convblocks.ts");
  const date = new Date(2026, 9, 10, 17, 5), now = new Date(2026, 9, 20);
  assert.equal((12345.6).toLocaleString(i18n.getLocale()), "12.345,6");
  assert.match(dayLabel(date, now), /Ekim/);
  i18n.setLanguage("en");
  assert.equal((12345.6).toLocaleString(i18n.getLocale()), "12,345.6");
  assert.match(dayLabel(date, now), /October/);
  assert.equal(clock(date), date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
});
test("language selector applies and persists explicit and automatic preferences", t => {
  const { values } = browser(t, "tr-TR");
  const modules = clientModules({ react: { useSyncExternalStore() {} } });
  const { LanguageSelect } = modules("LanguageSelect.tsx");
  let tree = LanguageSelect(), select = tree.props.children[1];
  assert.equal(select.props.value, "auto");
  assert.deepEqual(select.props.children.map(option => option.props.children), ["Türkçe", "English", "Otomatik"]);
  select.props.onChange({ target: { value: "en" } });
  tree = LanguageSelect(); assert.equal(tree.props.children[1].props.value, "en");
  assert.equal(document.documentElement.lang, "en"); assert.equal(values.get("panel-language"), "en");
  select.props.onChange({ target: { value: "auto" } });
  assert.equal(document.documentElement.lang, "tr");
});
