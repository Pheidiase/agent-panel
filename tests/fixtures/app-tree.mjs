// Gerçek App ağacını adlandırılmış durumla, efekt, soket ve model olmadan çalıştırır.
import fs from "node:fs";
import React from "react";
import ts from "@typescript/typescript6";
import { clientModules } from "./client-modules.mjs";
import { clientDom } from "./client-dom.mjs";

export function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return node?.props ? [node, ...elements(node.props.children)] : [];
}
export function content(node) {
  if (Array.isArray(node)) return node.map(content).join("");
  return node?.props ? content(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
}
// Exercise the real App tree with named state, without effects, sockets or models.
export function appFixture(t, { unread = 0, state: initial = {} } = {}) {
  const dom = clientDom(); t.after(() => dom.restore());
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname: "/", search: "", hash: "" } });
  t.after(() => { if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore); else delete globalThis.location; });
  window.history = { replaceState() {} };
  const agents = ["claude", "hermes", "codex", "shell"].map(id => ({ id, name: id === "shell" ? "Kabuk" : id, available: true }));
  const projects = [{ id: "general", name: "Genel / General", path: "/tmp", displayPath: "~" }, { id: "demo", name: "Demo" }];
  const session = { id: "test", title: "Example", agentId: "shell", projectId: "general", status: "running", createdAt: "2026-10-20" };
  const state = { authConfig: { mode: "local" }, user: "owner", ready: true, rawAgents: agents, rawProjects: projects,
    sessions: [session], selected: null, paletteOpen: true, modal: true, ...initial };
  const testState = (name, initial) => [Object.hasOwn(state, name) ? state[name] : typeof initial === "function" ? initial() : initial,
    value => { state[name] = typeof value === "function" ? value(state[name]) : value; }];
  const react = { ...React, lazy: factory => "lazy:" + factory.toString(), useSyncExternalStore() {}, useEffect() {}, useLayoutEffect() {},
    useCallback: fn => fn, useMemo: fn => fn(), useRef: value => ({ current: value }) };
  const source = fs.readFileSync(new URL("../../src/main.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.tsx", source, ts.ScriptTarget.Latest, true);
  const dependencies = { react, "react-dom/client": {}, "test-state": { testState } };
  for (const node of ast.statements.filter(ts.isImportDeclaration)) {
    const name = node.moduleSpecifier.text;
    if (["react", "./i18n", "./storage", "./input-state", "./sidebar", "./live", "./inbox"].includes(name) || name === "react-dom/client") continue;
    const stub = { default: name };
    for (const binding of node.importClause?.namedBindings?.elements ?? []) stub[binding.name.text] = binding.name.text;
    dependencies[name] = stub;
  }
  dependencies["./Inbox"] = { useInbox: () => ({ events: [], state: {}, unread, marker: () => null }), useCountdown: () => 0, InboxDialog: "InboxDialog", remainingLabel: () => "" };
  const load = clientModules(dependencies, false, (source, file) => {
    if (!file.endsWith("/main.tsx")) return source;
    const edits = [];
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "useState" && ts.isVariableDeclaration(node.parent)) {
        const name = node.parent.name.elements[0].name.text;
        edits.push([node.getStart(ast), node.end, `testState("${name}", ${node.arguments[0]?.getText(ast) ?? "undefined"})`]);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + value + source.slice(end);
    return 'import { testState } from "test-state";\n' + source.replace(/createRoot\(document\.getElementById\("root"\)!\)\.render\(<App \/>\);/, "export { App };");
  });
  const i18n = load("i18n.ts"), { App } = load("main.tsx");
  return { state, agents, projects, i18n, render: () => App() };
}

