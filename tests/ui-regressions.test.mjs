import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import { renderToStaticMarkup } from "react-dom/server";
import { createPortalAuth } from "../server/portal-auth.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { ClaudeManager } from "../server/claude-manager.mjs";
import { orderedMessages } from "../server/message-queue.mjs";
import { StructuredStore } from "../server/structured-store.mjs";
import { clientModules } from "./fixtures/client-modules.mjs";

const require = createRequire(import.meta.url);
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
function compile(source, deps = {}) {
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("exports", "require", js)(exports, name => name === "./i18n" ? clientModules()("i18n.ts") : deps[name] ?? require(name));
  return exports;
}
const terminal = read("src/TerminalView.tsx"), index = read("server/index.mjs");
const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function dir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "panel-regression-test-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function portal(t) {
  const state = dir(t);
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "auth-client.json"), JSON.stringify({ app: "panel", key: "k".repeat(43), portalInternal: "http://127.0.0.1:9", portalOrigin: "https://portal.example.test", publicOrigin: "https://panel.example.test" }));
  return createPortalAuth({ state, app: "panel", port: 1 });
}

test("diff #1 unknown checks leave owner capacity; invalid tickets never call the portal", async t => {
  const auth = portal(t), waits = [];
  t.mock.method(globalThis, "fetch", async () => { const wait = deferred(); waits.push(wait); return wait.promise; });
  auth.grants.set("owner", { token: "owner" });
  const anonymous = Array.from({ length: 8 }, (_, i) => auth.check(`unknown${i}`));
  await assert.rejects(auth.check("overflow"), { status: 503 });
  const owner = auth.check("owner");
  assert.equal(waits.length, 9);
  waits.slice(0, 8).forEach(w => w.resolve(new Response("null", { status: 401 })));
  waits[8].resolve(new Response(JSON.stringify({ owner: true, token: "owner" })));
  await Promise.all(anonymous); assert.equal((await owner).owner, true);
  // Execute the real upgrade authorization branch without a listening socket.
  const source = index.slice(index.indexOf('  const ticket = tickets.get(token);'), index.indexOf('  // A live-list ticket'));
  const upgrade = new Function("tickets", "token", "portalAuth", "req", "fail", `return (async () => {${source}})()`);
  for (const ticket of [undefined, { expires: 0 }]) {
    let calls = 0;
    assert.equal(await upgrade(new Map([["x", ticket]]), "x", { session() { calls++; } }, {}, status => status), 401);
    assert.equal(calls, 0);
  }
});

test("tests #6 central revalidation closes all three viewers on revoked owner or portal failure", async t => {
  const source = index.slice(index.indexOf('  if (checkingAuth) return;'), index.indexOf('}, 5000).unref();'));
  const tick = new Function("wss", "portalAuth", "grants", `let checkingAuth = false; return async () => {${source}}`);
  const auth = portal(t), token = "owner";
  for (const outcome of [401, "not-owner", 500, "timeout"]) {
    auth.grants.set(token, { token, owner: true });
    t.mock.method(globalThis, "fetch", async () => {
      if (outcome === "timeout") throw new DOMException("timed out", "TimeoutError");
      return new Response(JSON.stringify({ token, owner: false }), { status: typeof outcome === "number" ? outcome : 200 });
    });
    const clients = ["terminal", "structured", "live"].map(route => ({ route, panel: { grant: { token } }, close(code) { this.code = code; } }));
    await tick({ clients }, auth, auth.grants)();
    assert.deepEqual(clients.map(ws => ws.code), [4001, 4001, 4001], String(outcome));
    assert.equal(auth.grants.has(token), false);
    assert.doesNotMatch(source, /tmux|\.kill\(|\.stop\(/, "revocation cannot stop the agent");
    if (outcome === 401 || outcome === "not-owner") assert.equal(await auth.check(token), null);
    else await assert.rejects(auth.check(token), { status: 503 });
    t.mock.restoreAll();
  }
});

test("tests #5 / security #2 mode response loss closes the uncertain runtime", async () => {
  const manager = Object.create(StructuredManager.prototype), wait = deferred();
  const record = {}, runtime = { id: "x", inflight: 0, pendingApprovals: new Map(), modes: { currentModeId: "default" }, conn: { alive: true, request: () => wait.promise, async close() { this.alive = false; } } };
  Object.assign(manager, { runtimes: new Map([["x", runtime]]), _own: () => record, _ensureRuntime: async () => runtime, _broadcastState() {}, store: { get: () => record, save() {} } });
  const changing = manager.setMode("x", "dontAsk");
  await Promise.resolve();
  await assert.rejects(manager.prompt("x", "blocked"), { status: 409 });
  wait.reject(new Error("timeout after apply"));
  await assert.rejects(changing, /timeout/);
  assert.equal(runtime.conn.alive, false); assert.equal(manager.runtimes.size, 0);
  assert.equal(runtime.modes.currentModeId, "default"); assert.equal(record.hermesModeId, undefined);
  const startup = read("server/structured-manager.mjs");
  assert.match(startup, /this\._own\(id\).hermesModeId \|\| "default"/);
  assert.match(startup, /await connection.request\("session\/set_mode"/);
});

test("tests #5 stopped or replaced runtime cannot accept a late mode success", async () => {
  const manager = Object.create(StructuredManager.prototype), wait = deferred();
  const record = { endedAt: "stopped", hermesModeId: "default" };
  const runtime = { id: "x", inflight: 0, pendingApprovals: new Map(), conn: { alive: true, request: () => wait.promise, async close() { this.alive = false; } } };
  Object.assign(manager, { runtimes: new Map([["x", runtime]]), _own: () => record, _ensureRuntime: async () => runtime, _broadcastState() {}, store: { save: assert.fail } });
  const changing = manager.setMode("x", "dontAsk"); await Promise.resolve(); wait.resolve({});
  await assert.rejects(changing, { status: 409 });
  assert.equal(record.hermesModeId, "default"); assert.equal(runtime.conn.alive, false);
});

test("security #1 hidden Bash suffixes cannot be approved, including session approval", async () => {
  const manager = Object.create(ClaudeManager.prototype);
  const events = [];
  manager.approvalSerial = 0; manager._append = (id, event) => { assert.equal(id, "x"); events.push(event); };
  const input = { command: "x".repeat(4000) + "; HIDDEN", description: "safe" };
  const response = await manager._permissionRequest("x", {}, { tool_name: "Bash", input, permission_suggestions: [{}] }, "control");
  assert.equal(response.behavior, "deny"); assert.equal(response.updatedInput, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "status"); assert.equal(events[0].status, "notice");
  assert.match(events[0].detail, /uzun.*reddedildi/);
});

test("security #3 malformed Markdown stays responsive and preserves text and safe links", () => {
  const { renderMarkdown } = compile(read("src/markdown.tsx"), { "./clipboard": {} });
  for (const length of [80_000, 200_000]) {
    const start = performance.now();
    const html = renderToStaticMarkup(renderMarkdown("[".repeat(length)));
    assert.equal((html.match(/\[/g) || []).length, length);
    assert.ok(performance.now() - start < 1000, "malformed brackets must not trigger quadratic scanning");
  }
  const html = renderToStaticMarkup(renderMarkdown("[site](https://example.test) [bad](javascript:alert) **bold**"));
  assert.match(html, /href="https:\/\/example.test"/); assert.doesNotMatch(html, /href="javascript:/); assert.match(html, /<strong>bold/);
});

test("security #6 logout removes only private panel keys and blocks stale unmount writes", () => {
  const storage = compile(read("src/storage.ts"));
  const old = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const backing = { "panel-start-draft": "private start", "panel-draft-x": "secret", "panel-comments-x": "comment", "panel-autosend-x": "send", unrelated: "keep", "panel-theme": "dark" };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: new Proxy(backing, { get(target, key) {
    if (key === "getItem") return k => target[k] ?? null;
    if (key === "setItem") return (k, v) => { target[k] = v; };
    if (key === "removeItem") return k => { delete target[k]; };
    return target[key];
  } }) });
  try {
    storage.remember("panel-draft-x", "memory secret", true);
    storage.clearPrivateStorage();
    assert.deepEqual(backing, { unrelated: "keep", "panel-theme": "dark" });
    assert.equal(storage.remember("panel-draft-x", "stale effect", true), false);
    assert.equal(storage.stored("panel-draft-x", "", true), "");
    const cache = compile(read("src/terminal-snapshots.ts") + "\nexport const epoch = () => snapshotEpoch;");
    cache.snapshots.set("x", { text: "private terminal output" });
    const before = cache.epoch(); cache.clearTerminalSnapshots();
    assert.equal(cache.snapshots.size, 0); assert.equal(cache.epoch(), before + 1);
    assert.match(terminal, /epoch === snapshotEpoch && reading.current/);
    assert.match(read("src/main.tsx"), /clearPrivateStorage\(\);\s*clearTerminalSnapshots\(\)/);
  } finally { if (old) Object.defineProperty(globalThis, "sessionStorage", old); else delete globalThis.sessionStorage; }
});

// Run the actual component handlers and server input branch, without opening
// sockets, launching agents, or relying on a browser storage implementation.
const submitSource = terminal.slice(terminal.indexOf('  function submit('), terminal.indexOf('  async function copy('));
const { composer } = compile(`export function composer(draft, bracketed) {
  let error = "", sent = [], sending = false;
  const canWrite = true, WebSocket = { OPEN: 1 }, pending = { current: null },
    socket = { current: { readyState: 1, send: data => sent.push(JSON.parse(data)) } },
    term = { current: { modes: { bracketedPasteMode: bracketed } } },
    setError = x => { error = x }, setSending = x => { sending = x }, setNotice = () => {};
  ${submitSource}
  submit(); return { error, sent, draft, sending };
}`);
const inputBranch = index.slice(index.indexOf('      if (writers.get(id) !== ws)'), index.indexOf('      // The viewer must not drive pane geometry.'));
const deliver = new Function("writers", "id", "ws", "msg", "terminal", "send", inputBranch);

test("tests #12 terminal character/byte limits agree across client and server including paste wrappers", () => {
  for (const bracketed of [false, true]) {
    const overhead = bracketed ? 13 : 1;
    for (const text of ["a".repeat(16384 - overhead), "a".repeat(16385 - overhead), "ğ".repeat(11000), "😀".repeat(7000), ...["ğ", "😀"].flatMap(char => {
      const count = Math.floor((24000 - overhead) / Buffer.byteLength(char));
      return [char.repeat(count), char.repeat(count + 1)];
    }), ...(bracketed ? ["a\n" + "x".repeat(16384 - overhead - 2), "a\n" + "x".repeat(16385 - overhead - 2)] : [])]) {
      const result = composer(text, bracketed);
      const data = (bracketed ? `\x1b[200~${text}\x1b[201~` : text) + "\r";
      const allowed = data.length <= 16384 && Buffer.byteLength(data) <= 24000;
      assert.equal(result.sent.length, allowed ? 1 : 0);
      assert.equal(result.draft, text, "no draft cleared before acknowledgment");
      const ws = {}, writes = [], replies = [];
      deliver(new Map([["s", ws]]), "s", ws, { type: "input", data, requestId: "request" }, { write: data => writes.push(data) }, (_ws, msg) => replies.push(msg));
      assert.equal(writes.length, allowed ? 1 : 0);
      assert.equal(replies[0].type, allowed ? "input-accepted" : "input-rejected");
    }
  }
});

test("tests #14 actual WebSocket handler rechecks writer after delayed portal validation", async () => {
  const marker = '      handle: async (raw, active) => {';
  const start = index.indexOf(marker) + marker.length;
  const body = index.slice(start, index.indexOf('      },', start));
  const handler = new Function("portalAuth", "g", "grants", "ws", "writers", "id", "terminal", "send", "roles", `return async (raw, active) => {${body}}`);
  const a = { readyState: 1, close: assert.fail }, b = { readyState: 1, close: assert.fail };
  const writers = new Map([["s", a]]), writes = [], replies = [], wait = deferred(), entered = deferred();
  const g = { token: "owner", expires: Date.now() + 60000 }, grants = new Map([[g.token, g]]);
  const make = (ws, check) => orderedMessages({ open: () => ws.readyState === 1, fail: assert.fail,
    handle: handler({ check }, g, grants, ws, writers, "s", { write: text => writes.push(text) }, (ws, msg) => replies.push([ws, msg.type]), () => {}),
  });
  const onA = make(a, async () => { entered.resolve(); return wait.promise; });
  const onB = make(b, async () => g);
  const waiting = onA(Buffer.from(JSON.stringify({ type: "input", data: "A", requestId: "r" })));
  await entered.promise;
  await onB(Buffer.from('{"type":"control"}'));
  wait.resolve(g); await waiting;
  await onB(Buffer.from(JSON.stringify({ type: "input", data: "B", requestId: "r" })));
  assert.deepEqual(writes, ["B"]); assert.deepEqual(replies, [[a, "input-rejected"], [b, "input-accepted"]]);
  const rejection = terminal.slice(terminal.indexOf('          if (data.type === "input-rejected"'), terminal.indexOf('          if (data.type === "detached"'));
  const { rejectedDraft } = compile(`export function rejectedDraft() {
    let draft = "private draft", sending = true, error = "";
    const data = { type: "input-rejected", requestId: "r" }, pending = { current: { id: "r" } },
      setDraft = () => { throw Error("must preserve draft") }, setSending = x => { sending = x }, setError = x => { error = x };
    ${rejection}
    return { draft, sending, error };
  }`);
  const result = rejectedDraft(), i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
  assert.equal(result.draft, "private draft"); assert.equal(result.sending, false);
  assert.equal(i18n.messageText(result.error), "Kontrol başka pencerede. Taslağın korundu.");
});

test("tests #17 second upload failure keeps the first path and concurrent draft edits", async () => {
  const source = terminal.slice(terminal.indexOf('  async function attachImages('), terminal.indexOf('  const hint ='));
  const { upload } = compile(`export async function upload(status) {
    let draft = "existing", notice = "", calls = 0;
    const setDraft = fn => { draft = fn(draft) }, setNotice = x => { notice = x }, composer = { current: null };
    const request = async () => { if (++calls === 2) { draft += "new typing"; throw Error(String(status)); } return { path: "/private/first.png" }; };
    ${source}
    await attachImages([{ type: "image/png" }, { type: "image/png" }]); return { draft, notice };
  }`);
  for (const status of [413, 503]) {
    const result = await upload(status);
    assert.equal(result.draft, "existing /private/first.png new typing");
    assert.ok(result.notice instanceof Error);
    assert.equal(i18n.messageText(result.notice), String(status));
  }
});

test("tests #11 browser retry reuses the creation identity until success or changed input", () => {
  const { creationAttempt } = compile(read("src/input-state.ts"));
  const options = { projectId: "p", agentId: "codex", kind: "structured", title: "hello", firstMessage: "hello", allowParallel: false };
  const first = creationAttempt(null, options);
  assert.equal(creationAttempt(first, { ...options }), first);
  for (const change of [{ firstMessage: "changed" }, { agentId: "claude" }, { allowParallel: true }])
    assert.notEqual(creationAttempt(first, { ...options, ...change }).requestId, first.requestId);
  assert.notEqual(creationAttempt(null, options).requestId, first.requestId);
  assert.match(read("src/main.tsx"), /requestId: pendingCreation.current.requestId/);
});

test("tests #15 actual fold retains a tool completion from a truncated server page without duplicates", t => {
  const view = read("src/StructuredView.tsx");
  const { foldEvents, foldApprovals } = compile(view.slice(view.indexOf("function foldEvents("), view.indexOf("function ApprovalCard(")) + "\nexport { foldEvents, foldApprovals }");
  const { retainChatEvents } = compile(read("src/chat-events.ts"));
  const store = new StructuredStore({ stateDir: dir(t) }); t.after(() => store.closeLogs());
  store.appendEvent("x", { kind: "tool", id: "read", app: "start", data: { title: "Read" } });
  for (let i = 0; i < 10; i++) store.appendEvent("x", { kind: "assistant", text: "x".repeat(180_000) });
  const last = store.appendEvent("x", { kind: "tool", id: "read", app: "update", patch: { status: "completed", content: "result kept" } });
  const page = store.readEvents("x", {});
  assert.equal(page.truncated, true);
  const kept = retainChatEvents(page.events).events;
  const tool = foldEvents(kept).find(item => item.type === "tool");
  assert.equal(tool.tool.content, "result kept"); assert.equal(i18n.t(tool.tool.title), "Önceki geçmişte başlayan araç");
  let history = { events: kept, items: foldEvents(kept), tools: [], approvals: [], plan: null, commands: null };
  const seqRef = { current: page.lastSeq }, original = history;
  const mergeSource = view.slice(view.indexOf('    if (!Array.isArray(incoming)'), view.indexOf('  }, []);', view.indexOf('  const merge =')));
  const { merge } = compile(`export function merge(incoming, setHistory, seqRef, retainChatEvents, setHistoryIncomplete, foldEvents, foldApprovals) {${mergeSource}}`);
  const apply = incoming => merge(incoming, fn => { history = fn(history); }, seqRef, retainChatEvents, () => {}, foldEvents, foldApprovals);
  apply([last]);
  assert.equal(history, original, "overlapping replay is a no-op");
  assert.equal(history.items.filter(item => item.type === "tool").length, 1);
  apply([{ seq: last.seq + 1, kind: "assistant", id: "new", text: "tail" }]);
  assert.equal(history.items.at(-1).text, "tail");
  assert.deepEqual(history.items, foldEvents(history.events));
  const many = Array.from({ length: 5000 }, (_, seq) => ({ seq, kind: seq % 100 === 0 ? "user" : "tool" }));
  assert.equal(retainChatEvents(many).truncated, true);
  assert.match(view, /data.truncated\) setHistoryIncomplete\(true\)/);
  assert.match(view, /historyIncomplete &&/);
});

test("tests #11 real creation handler recovers a lost reply with one session and one first-message handoff", async () => {
  const main = read("src/main.tsx");
  const source = main.slice(main.indexOf('  async function createSession('), main.indexOf('  // Pencere hangi yoldan'));
  const { create } = compile(`${read("src/input-state.ts")}
    export function create() {
      const pendingCreation = { current: null }, records = new Map(), ids = [], seeded = [];
      let lost = true;
      const setCreating = () => {}, setError = () => {}, refresh = async () => {}, openSession = () => {}, closeModal = () => {};
      const remember = (key, value) => { seeded.push([key, value]) };
      const api = async (_url, _method, body) => {
        ids.push(body.requestId);
        if (!records.has(body.requestId)) records.set(body.requestId, { id: "single-session" });
        if (lost) { lost = false; throw Error("response lost after server commit") }
        return records.get(body.requestId);
      };
      ${source}
      return { createSession, ids, records, seeded };
    }
  `);
  const browser = create(), opts = { projectId: "p", agentId: "codex", kind: "structured", title: "hello", firstMessage: "hello", allowParallel: false };
  assert.equal(await browser.createSession(opts), false);
  assert.equal(browser.seeded.length, 0);
  assert.equal(await browser.createSession(opts), true);
  assert.equal(browser.ids[0], browser.ids[1]); assert.equal(browser.records.size, 1);
  assert.deepEqual(browser.seeded, [["panel-draft-single-session", "hello"], ["panel-autosend-single-session", "hello"]]);
});

test("tests #14 writer disconnect hands control back to the live viewer exactly once", () => {
  const source = index.slice(index.indexOf('  function cleanup() {', index.indexOf('wss.on("connection"')), index.indexOf('  ws.on("close", cleanup);', index.indexOf('wss.on("connection"')));
  const close = new Function("ws", "client", "writers", "viewers", "id", "terminal", "roles", `let cleaned = false; ${source} return cleanup;`);
  const a = { readyState: 1 }, b = { readyState: 1 }, ca = { ws: a }, cb = { ws: b }, writers = new Map([["s", b]]), viewers = new Map([["s", new Set([ca, cb])]]);
  let kills = 0, broadcasts = 0;
  const cleanup = close(b, cb, writers, viewers, "s", { kill() { kills++; } }, () => broadcasts++);
  cleanup(); cleanup();
  assert.equal(writers.get("s"), a); assert.equal(kills, 1); assert.equal(broadcasts, 1);
  assert.deepEqual([...viewers.get("s")], [ca]);
});

test("tests #5 reconnect reapplies only the saved permission and waits for its acknowledgment", async t => {
  const { AcpConnection } = await import("../server/acp-client.mjs");
  const store = new StructuredStore({ stateDir: dir(t) }); t.after(() => store.closeLogs());
  const record = { id: "x", projectId: "p", agentId: "hermes", acpSessionId: "native", hermesModeId: "default" };
  store.add(record);
  const manager = new StructuredManager({ store, projects: [{ id: "p", path: "/unused" }], agentCommand: { command: "unused", args: [] } });
  const ack = deferred(), called = deferred(), calls = [];
  t.mock.method(AcpConnection.prototype, "start", function () { this.child = { exitCode: null }; });
  t.mock.method(AcpConnection.prototype, "close", async function () { this.child.exitCode = 0; });
  t.mock.method(AcpConnection.prototype, "request", async function (method, params) {
    calls.push([method, params]);
    if (method === "session/load") return { sessionId: "native", modes: { currentModeId: "dontAsk" } };
    if (method === "session/set_mode") { called.resolve(); return ack.promise; }
    return {};
  });
  const connecting = manager._ensureRuntime("x");
  await called.promise;
  const runtime = manager.runtimes.get("x");
  assert.notEqual(runtime.status, "idle");
  assert.deepEqual(calls.at(-1), ["session/set_mode", { sessionId: "native", modeId: "default" }]);
  ack.resolve({}); await connecting;
  assert.equal(runtime.status, "idle"); assert.equal(runtime.modes.currentModeId, "default");
  await manager.shutdown();
});

test("tests #5 mode persistence failure closes the child and preserves the last verified choice", async t => {
  const store = new StructuredStore({ stateDir: dir(t) }); t.after(() => store.closeLogs());
  store.add({ id: "x", agentId: "hermes", hermesModeId: "default" });
  const manager = new StructuredManager({ store, projects: [], agentCommand: { command: "unused" } });
  const runtime = { id: "x", inflight: 0, pendingApprovals: new Map(), modes: { currentModeId: "default" }, conn: { alive: true, async request() {}, async close() { this.alive = false; } } };
  manager.runtimes.set("x", runtime);
  await manager.setMode("x", "acceptEdits");
  assert.equal(store.get("x").hermesModeId, "acceptEdits");
  assert.equal(new StructuredStore({ stateDir: store.stateDir }).get("x").hermesModeId, "acceptEdits");
  t.mock.method(store, "save", () => { throw Error("EIO"); });
  await assert.rejects(manager.setMode("x", "dontAsk"), /EIO/);
  assert.equal(store.get("x").hermesModeId, "acceptEdits");
  assert.equal(new StructuredStore({ stateDir: store.stateDir }).get("x").hermesModeId, "acceptEdits");
  assert.equal(runtime.conn.alive, false); assert.equal(manager.runtimes.size, 0);
});

// React treats whatever an effect callback returns as its cleanup. In new Chromium
// scrollIntoView() returns a Promise, so an expression-bodied effect crashed the app.
test("effect callbacks only return cleanup functions, never call results", () => {
  const cleanupCalls = new Set(["installDialogFocus", "subscribeYakStatus"]); // documented to return an unsubscribe function
  const effects = /^(?:use(?:Layout|Insertion)?Effect)$/, problems = [];
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
  const isFunction = node => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  const src = path.join(import.meta.dirname, "../src");
  let checked = 0;
  for (const file of walk(src)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      const callee = ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
      if (callee && ts.isIdentifier(callee) && effects.test(callee.text)) {
        checked++;
        const callback = node.arguments[0], where = `${path.relative(src, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (!callback || !isFunction(callback)) problems.push(`${where}: effect callback must be an inline function`);
        else if (!ts.isBlock(callback.body)) {
          const body = callback.body;
          const allowed = isFunction(body) || ts.isCallExpression(body) && ts.isIdentifier(body.expression) && cleanupCalls.has(body.expression.text);
          if (!allowed) problems.push(`${where}: expression body returns ${body.getText().slice(0, 60)}; use a block body`);
        } else {
          const returns = [];
          const find = child => {
            if (child !== callback && ts.isFunctionLike(child)) return;
            if (ts.isReturnStatement(child) && child.expression) returns.push(child.expression);
            ts.forEachChild(child, find);
          };
          find(callback.body);
          for (const value of returns) if (!isFunction(value) && !ts.isIdentifier(value))
            problems.push(`${where}: returns ${value.getText().slice(0, 60)}, not a cleanup function`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked > 50, "the scan must find the effects it is meant to check");
  assert.deepEqual(problems, []);
});
