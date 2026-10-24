import { clientModules } from "./fixtures/client-modules.mjs";
// No model processes, real services or listening sockets; state lives in /tmp.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import ts from "@typescript/typescript6";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadAgentBinaries, resolveExecutable, runtimeTools, readPanelSettings, projectConfigFile } from "../server/config.mjs";
import { loadProjects } from "../server/projects.mjs";
import { resolveAcpCommand } from "../server/structured-manager.mjs";
import { resolveCodexCommand } from "../server/codex-manager.mjs";
import { resolveClaudeCommand } from "../server/claude-manager.mjs";
import { initializeState, setup, serviceUnits, supportedNode, unitQuote } from "../ops/install.mjs";
import { requestApp } from "./fixtures/http-memory.mjs";

const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-setup-")), state = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin with spaces"); fs.mkdirSync(bin);
  const executable = name => { const file = path.join(bin, name); fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); return file; };
  for (const name of ["tmux", "python3", "bash"]) executable(name);
  const env = { PATH: bin, PANEL_STATE_DIR: state, XDG_CONFIG_HOME: path.join(root, "xdg") };
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config/projects.json"), '[{"id":"general","kind":"general","name":"General"}]');
  const v = process.versions.node.split(".");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ engines: { node: `^${v[0]}.0.0` } }));
  const write = (name, value) => { fs.mkdirSync(state, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(state, name), JSON.stringify(value), { mode: 0o600 }); };
  return { root, state, bin, env, executable, write };
}

test("real startup initialization works without agents.json; missing agents stay unavailable", t => {
  const f = fixture(t), start = index.slice(index.indexOf("const state ="), index.indexOf("let projectsAt ="));
  f.env.PANEL_WORKSPACE = path.join(f.root, "workspace");
  fs.mkdirSync(path.join(f.env.PANEL_WORKSPACE, "isolated-project"), { recursive: true });
  const boot = new Function("root", "process", "fs", "path", "readPanelSettings", "runtimeTools", "loadAgentBinaries", "projectConfigFile", "loadProjects", `${start}; return { projects, binaryConfig, host, port };`);
  const result = boot(f.root, { env: f.env }, fs, path,
    opts => readPanelSettings({ ...opts, env: f.env }), () => runtimeTools(f.env),
    opts => loadAgentBinaries({ ...opts, env: f.env }), projectConfigFile, loadProjects);
  assert.deepEqual(result.binaryConfig, { shell: path.join(f.bin, "bash") });
  assert.equal(result.host, "127.0.0.1"); assert.equal(result.port, 4317);
  assert.equal(result.projects[0].id, "general");
  assert.deepEqual(result.projects.map(p => p.id), ["general", "isolated-project"]);
  assert.equal(result.projects[1].path, path.join(f.env.PANEL_WORKSPACE, "isolated-project"));
  assert.equal(fs.existsSync(path.join(f.state, "agents.json")), false);
  for (const resolve of [resolveAcpCommand, resolveCodexCommand, resolveClaudeCommand])
    assert.equal(resolve({ stateDir: f.state, env: f.env }), null);
  const names = ["hermes", "codex", "claude"];
  for (const name of names) f.executable(name);
  for (const [i, resolve] of [resolveAcpCommand, resolveCodexCommand, resolveClaudeCommand].entries())
    assert.equal(resolve({ stateDir: f.state, env: f.env }).command, path.join(f.bin, names[i]));
});

test("broken agents JSON is explicit, never silently resets or prints its contents", t => {
  const f = fixture(t); f.write("agents.json", {});
  fs.writeFileSync(path.join(f.state, "agents.json"), '{"private-value":');
  assert.throws(() => loadAgentBinaries({ stateDir: f.state, env: f.env }), error =>
    /agents.json.*JSON bozuk/.test(error.message) && !error.message.includes("private-value"));
  for (const value of [[], null, "codex", { codex: 1 }]) {
    f.write("agents.json", value);
    assert.throws(() => loadAgentBinaries({ stateDir: f.state, env: f.env }), /agents.json/);
  }
});

test("PATH resolution checks executable files and honors overrides without falling back", t => {
  const f = fixture(t), custom = f.executable("custom-codex");
  f.executable("codex"); f.write("agents.json", { codex: custom });
  assert.equal(loadAgentBinaries({ stateDir: f.state, env: f.env }).codex, custom);
  assert.equal(loadAgentBinaries({ stateDir: f.state, env: { ...f.env, PANEL_CODEX_BINARY: "codex" } }).codex, path.join(f.bin, "codex"));
  assert.equal(loadAgentBinaries({ stateDir: f.state, env: { ...f.env, PANEL_CODEX_BINARY: "/missing/codex" } }).codex, undefined);
  fs.chmodSync(custom, 0o600); assert.equal(resolveExecutable(custom, f.env), null);
  assert.equal(resolveExecutable(f.bin, f.env), null);
  assert.equal(resolveExecutable("bash", { PATH: "" }), null);
  const tools = runtimeTools(f.env); assert.equal(tools.tmux, path.join(f.bin, "tmux")); assert.equal(tools.systemdRun, null);
  assert.throws(() => runtimeTools({ PATH: f.bin, PANEL_TMUX_BINARY: "/missing" }), /tmux.*PANEL_TMUX_BINARY/);
  assert.throws(() => runtimeTools({ PATH: f.bin, PANEL_PYTHON_BINARY: "/missing" }), /python3.*PANEL_PYTHON_BINARY/);
  assert.equal(runtimeTools({ ...f.env, PANEL_TMUX_BINARY: process.execPath }).tmux, process.execPath);
  assert.equal(runtimeTools({ ...f.env, PANEL_PYTHON_BINARY: process.execPath }).python3, process.execPath);
  assert.equal(runtimeTools({ ...f.env, PANEL_SYSTEMD_RUN_BINARY: process.execPath }).systemdRun, process.execPath);
});

test("settings default to loopback, no home link and the existing workspace; env wins", t => {
  const f = fixture(t);
  assert.deepEqual(readPanelSettings(f), { workspace: path.dirname(f.root), host: "127.0.0.1", port: 4317, homeUrl: null });
  f.write("settings.json", { workspace: "work", host: "0.0.0.0", port: 7000, homeUrl: "https://home.example.test/" });
  const settings = readPanelSettings({ ...f, env: { PANEL_WORKSPACE: f.root, PANEL_HOST: "::1", PANEL_PORT: "7001" } });
  assert.deepEqual(settings, { workspace: f.root, host: "::1", port: 7001, homeUrl: "https://home.example.test/" });
  assert.match(index, /server.listen\(port, host/);
  assert.match(index, /\["0\.0\.0\.0", "::"\].includes\(host\)[\s\S]*console.warn\(/);
  for (const value of [{ port: 0 }, { port: -1 }, { port: 65536 }, { host: "" }, { homeUrl: "javascript:alert(1)" },
    { homeUrl: "https://user:secret@example.test" }, { homeUrl: 1 }, [], null]) {
    f.write("settings.json", value); assert.throws(() => readPanelSettings(f), /settings.json/);
  }
});

test("private projects preserve curated metadata; workspace discovery and generic fallback remain", t => {
  const f = fixture(t), workspace = path.join(f.root, "work");
  fs.mkdirSync(path.join(workspace, "alpha"), { recursive: true }); fs.mkdirSync(path.join(workspace, "beta"));
  assert.equal(projectConfigFile(f.root, f.state), path.join(f.root, "config/projects.json"));
  f.write("projects.json", [{ id: "general", kind: "general", name: "Private general" }, { id: "alpha", name: "Custom name", color: "blue" }]);
  const projects = loadProjects({ workspace, configFile: projectConfigFile(f.root, f.state) });
  assert.deepEqual(projects.map(p => p.id), ["general", "alpha", "beta"]);
  assert.equal(projects[1].name, "Custom name"); assert.equal(projects[1].path, path.join(workspace, "alpha"));
  fs.writeFileSync(path.join(f.state, "projects.json"), "broken");
  assert.throws(() => loadProjects({ workspace, configFile: projectConfigFile(f.root, f.state) }), /projects.json.*JSON bozuk/);
});

test("setup is private, repeatable and preserves existing auth/agent files", async t => {
  const f = fixture(t), logs = [], options = { ...f, args: [], log: s => logs.push(s), loadPty: async () => ({ spawn() {} }) };
  await setup(options);
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
  for (const name of ["auth.json", "agents.json"]) assert.equal(fs.statSync(path.join(f.state, name)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "auth.json"))).mode, "local");
  assert.equal(fs.existsSync(f.env.XDG_CONFIG_HOME), false);
  f.write("auth.json", { mode: "portal" }); f.write("agents.json", { shell: process.execPath });
  const before = ["auth.json", "agents.json"].map(n => fs.readFileSync(path.join(f.state, n), "utf8"));
  await setup(options);
  assert.deepEqual(["auth.json", "agents.json"].map(n => fs.readFileSync(path.join(f.state, n), "utf8")), before);
  assert.match(logs.join("\n"), /npm run set-password/);
  assert.equal(fs.existsSync(path.join(f.state, "credentials.json")), false);
  assert.equal(fs.existsSync(path.join(f.state, "bootstrap-password")), false);
});

test("setup reports missing prerequisites before writing state", async t => {
  const f = fixture(t), options = { ...f, args: [], log() {}, loadPty: async () => { throw new Error("native loader detail"); } };
  await assert.rejects(setup(options), /node-pty.*npm ci/);
  assert.equal(fs.existsSync(f.state), false);
  await assert.rejects(setup({ ...options, env: { ...f.env, PATH: "" } }), /tmux/);
  const link = path.join(f.root, "symlink"); fs.symlinkSync(f.bin, link);
  assert.throws(() => initializeState(link, {}), /symlink/);
  const range = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).engines.node;
  for (const v of ["22.23.4", "24.22.1", "26.12.1", "22.24.0"]) assert.equal(supportedNode(v, range), true);
  for (const v of ["20.99.0", "22.23.3", "23.0.0", "24.22.0", "26.12.0", "26.12.1-pre"]) assert.equal(supportedNode(v, range), false);
});

test("systemd is opt-in, uses generated paths, separates tmux and never overwrites units", async t => {
  const f = fixture(t); f.executable("systemctl");
  const options = { ...f, args: ["--systemd"], log() {}, loadPty: async () => ({ spawn() {} }) };
  await setup(options);
  const dir = path.join(f.env.XDG_CONFIG_HOME, "systemd/user");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["agent-panel-tmux.service", "agent-panel-web.service"]);
  const web = fs.readFileSync(path.join(dir, "agent-panel-web.service"), "utf8");
  assert.ok(web.includes(`ExecStart="${process.execPath}" "${f.root}/server/index.mjs"`));
  assert.match(web, /After=agent-panel-tmux.service/); assert.doesNotMatch(web, /PartOf=|BindsTo=|ExecStop=/);
  await assert.rejects(setup(options), /Existing unit preserved/);
  assert.equal(fs.readFileSync(path.join(dir, "agent-panel-web.service"), "utf8"), web);
  assert.equal(unitQuote("/a %h/$name", true), '"/a %%h/$$name"');
  assert.equal(unitQuote("/a %h/$name"), '"/a %%h/$name"');
  assert.throws(() => unitQuote("/a\nb"), /control character/);
  const units = serviceUnits({ ...f, socket: path.join(f.state, "tmux.sock"), tools: runtimeTools(f.env) });
  assert.doesNotMatch(Object.values(units).join("\n"), /\/usr\/bin\/(tmux|python3)|cloudflare/i);
});

// Run the actual catalog mount through Express without listen(); no optional module is loaded here.
function catalogApp(homeUrl = null) {
  const app = express();
  const auth = (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401);
  const catalog = index.slice(index.indexOf('app.get("/api/catalog",'), index.indexOf('// Read-only Hermes cron'));
  new Function("app", "auth", "PANEL_VERSION", "projects", "agents", "structured", "codex", "claude", "GEOMETRY_PRESETS", "DEFAULT_GEOMETRY", "homeUrl", "optionalCatalog", catalog)(
    app, auth, "test", [], [], {}, {}, {}, [], {}, homeUrl, []);
  return app;
}

test("catalog reports no homeUrl unless configured and adds no optional fields without modules", async () => {
  const app = catalogApp();
  const catalog = (await requestApp(app, { path: "/api/catalog", headers: { Authorization: "test" } })).json();
  assert.equal(catalog.homeUrl, null);
  const core = ["agents", "defaultGeometry", "geometry", "homeUrl", "projects", "structured", "structuredClaude", "structuredCodex", "version"];
  assert.deepEqual(Object.keys(catalog).filter(key => !core.includes(key)), []);
  const homeUrl = "https://home.example.test/";
  assert.equal((await requestApp(catalogApp(homeUrl), { path: "/api/catalog", headers: { Authorization: "test" } })).json().homeUrl, homeUrl);
});

test("actual sidebar and mobile JSX hide the optional home link and reveal it when configured", () => {
  const links = [...main.matchAll(/\{homeUrl && <a[\s\S]*?<\/a>\}/g)].map(m => m[0]);
  assert.equal(links.length, 2);
  const source = `export function View({homeUrl}) {
    const ArrowLeft=()=>null, House=()=>null;
    return <>${links.join("\n")}</>;
  }`;
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
  const exports = {}; new Function("require", "exports", "t", js)(require, exports, i18n.t);
  assert.equal(renderToStaticMarkup(React.createElement(exports.View, { homeUrl: null })), "");
  const html = renderToStaticMarkup(React.createElement(exports.View, { homeUrl: "https://home.example.test/" }));
  assert.equal((html.match(/href="https:\/\/home.example.test\/"/g) || []).length, 2);
  assert.doesNotMatch(main, /href="https?:\/\//);
});
