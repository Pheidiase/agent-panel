import { clientModules } from "./fixtures/client-modules.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);
function compile(file, deps = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(new URL("../src/" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("exports", "require", js)(exports, name => deps[name] ?? require(name)); return exports;
}
function harness(props, language = "tr") {
  let cursor = 0, effectCursor = 0; const states = [], effects = [], pending = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
    useEffect(fn, deps) {
      const i = effectCursor++, previous = effects[i];
      if (!previous || deps.some((v, n) => !Object.is(v, previous.deps[n]))) pending.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; });
    },
  };
  const i18n = clientModules()("i18n.ts"); i18n.setLanguage(language);
  const { Login } = compile("Login.tsx", { react, "./i18n": { ...i18n, useI18n() {} } });
  return { setLanguage: i18n.setLanguage, render() { cursor = 0; effectCursor = 0; const tree = Login(props); pending.splice(0).forEach(f => f()); return tree; },
    dispose() { effects.forEach(e => e?.cleanup?.()); } };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children].flat(5)) { const found = find(child, predicate); if (found) return found; }
  return null;
}
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree?.props ? [tree.props.children].flat(5).map(text).join(" ") : "";
}
test("local form has keyboard submit, autocomplete and clears its secret on success before granting access", async () => {
  let sent, resolve; const accepted = [];
  const ui = harness({ config: { mode: "local", configured: true }, submit: (...args) => { sent = args; return new Promise(r => { resolve = r; }); }, onLogin: grant => accepted.push(grant) });
  let tree = ui.render();
  for (const [name, value] of [["username", "synthetic"], ["password", "synthetic secret"]]) {
    const input = find(tree, e => e.type === "input" && e.props.name === name);
    assert.equal(input.props.autoComplete, name === "password" ? "current-password" : "username"); input.props.onChange({ target: { value } });
  }
  tree = ui.render(); const login = find(tree, e => e.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(sent, ["synthetic", "synthetic secret"]); assert.equal(find(ui.render(), e => e.type === "button").props.disabled, true);
  resolve({ username: "synthetic", csrf: "csrf" }); await login;
  assert.deepEqual(accepted, [{ username: "synthetic", csrf: "csrf" }]); assert.equal(find(ui.render(), e => e.props?.name === "password").props.value, "");
  ui.dispose();
});
test("429 displays Retry-After, clears password and disables retries; 401 and 503 stay distinct", async () => {
  for (const status of [401, 429, 503]) {
    const ui = harness({ config: { mode: "local", configured: true }, submit: async () => { throw Object.assign(new Error(), { status, retryAfter: 17 }); }, onLogin: assert.fail });
    const tree = ui.render(); await find(tree, e => e.type === "form").props.onSubmit({ preventDefault() {} });
    const result = ui.render();
    assert.match(text(result), status === 429 ? /17 saniye/ : status === 401 ? /parola hatalı/ : /servisine ulaşılamıyor/);
    assert.equal(find(result, e => e.type === "button").props.disabled, status === 429); ui.dispose();
  }
});
test("unconfigured local screen only directs to the CLI; only portal mode redirects", () => {
  const setup = harness({ config: { mode: "local", configured: false }, submit: assert.fail, onLogin: assert.fail });
  assert.match(text(setup.render()), /npm run set-password/); assert.equal(find(setup.render(), e => e.type === "input"), null); setup.dispose();
  const previous = globalThis.window; let destination;
  globalThis.window = { addEventListener() {}, location: { replace: value => { destination = value; } } };
  try {
    const portal = harness({ config: { mode: "portal" }, submit: assert.fail, onLogin: assert.fail }); portal.render(); assert.equal(destination, "/"); portal.dispose();
  } finally { globalThis.window = previous; }
});
test("App bootstraps mode before /me and installs CSRF before private views mount", () => {
  const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(main.indexOf('api<AuthConfig>("/auth/config")') < main.indexOf('return api<LoginGrant>("/me")'));
  assert.match(main, /error\.status !== 401\) setAuthError/);
  assert.match(main, /csrf = grant\.csrf; setUser\(grant\.username\)/);
  assert.match(main, /csrf = d\.csrf;\s*setUser\(d\.username\)/);
  assert.match(main, /if \(!user\) return <Login config=\{authConfig\}/);
});

test("English login and a visible coded error switch to Turkish without another request", async () => {
  let requests = 0;
  const ui = harness({ config: { mode: "local", configured: true }, submit: async () => {
    requests++; throw Object.assign(new Error("legacy"), { status: 401, code: "LOGIN_FAILED" });
  }, onLogin: assert.fail }, "en");
  assert.match(text(ui.render()), /Sign in to Agent Panel/);
  await find(ui.render(), e => e.type === "form").props.onSubmit({ preventDefault() {} });
  assert.match(text(ui.render()), /Incorrect username or password/);
  ui.setLanguage("tr"); assert.match(text(ui.render()), /Kullanıcı adı veya parola hatalı/);
  assert.equal(requests, 1); ui.dispose();
});
