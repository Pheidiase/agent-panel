// Codex structured tier: manager lifecycle, event normalization (messages,
// thinking, command execution, file changes, plan, usage), the approval and
// user-input bridge, cancel/resume, and store sharing with the ACP tier —
// all against the deterministic app-server fixture (no model, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AcpConnection } from "../server/acp-client.mjs";
import { CodexManager, parseUnifiedDiff, resolveCodexCommand } from "../server/codex-manager.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { StructuredStore } from "../server/structured-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/fake-codex-app-server.mjs");
const acpFixture = path.join(root, "tests/fixtures/fake-acp-agent.mjs");

function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-codex-"));
  const fixtureLog = path.join(dir, "fixture.log");
  const manager = new CodexManager({
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [fixture] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: { ...process.env, FIXTURE_LOG: fixtureLog, ...extraEnv },
  });
  const wait = async (fn, ms = 9000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Beklenen koşul zaman aşımına uğradı.");
  };
  const events = (id) => manager.readEvents(id, {}).events;
  return { dir, manager, fixtureLog, wait, events };
}

async function cleanup(dir, ...managers) {
  await Promise.all(managers.map((manager) => manager.shutdown().catch(() => {})));
  fs.rmSync(dir, { recursive: true, force: true });
}

const requestId = () => crypto.randomUUID().replace(/-/g, "").padEnd(24, "x");

test("codex: the resolver always carries the app-server subcommand", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-codex-resolve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveCodexCommand({ stateDir: dir, env: {} }), null);
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ codex: process.execPath }));
  assert.deepEqual(resolveCodexCommand({ stateDir: dir, env: {} }), {
    command: process.execPath,
    args: ["app-server"],
  });
  const override = path.join(dir, "codex-override");
  fs.writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.deepEqual(
    resolveCodexCommand({ stateDir: dir, env: { PANEL_CODEX_BINARY: override } }),
    { command: override, args: ["app-server"] },
  );
  assert.equal(resolveCodexCommand({ stateDir: dir, env: { PANEL_CODEX_BINARY: path.join(dir, "missing") } }), null);
});

test("codex: create starts a thread and normalizes chat, thinking and usage", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await manager.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Fixture sohbet",
    requestId: requestId(),
  });
  assert.equal(created.agentId, "codex");
  assert.equal(created.kind, "structured");
  assert.match(created.codexThreadId, /^th-\d+$/);
  const id = created.id;

  const info = await manager.sessionInfo(id);
  assert.equal(info.models.availableModels.length, 2);
  assert.equal(info.models.currentModelId, "fixture-model-a");

  await manager.prompt(id, "sohbet");
  await wait(async () => events(id).some((e) => e.kind === "turn"));
  const list = events(id);
  assert.ok(list.some((e) => e.kind === "user" && e.text === "sohbet"));
  const assistant = list.filter((e) => e.kind === "assistant");
  assert.ok(assistant.length >= 2, "chunked assistant deltas");
  assert.equal(assistant.map((e) => e.text).join(""), "Merhaba fixture dünya");
  assert.ok(list.some((e) => e.kind === "thought" && String(e.text).includes("düşünüyorum")));
  const usage = list.find((e) => e.kind === "usage");
  assert.deepEqual({ used: usage.used, size: usage.size }, { used: 42, size: 200000 });
  const state = manager.stateOf(id);
  assert.equal(state.status, "idle");
  assert.equal(state.usage.used, 42);
});

test("codex: command approval bridge — accept and decline paths", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await manager.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Onay",
    requestId: requestId(),
  });
  const id = created.id;

  await manager.prompt(id, "komut çalıştır");
  await wait(async () => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  const requested = events(id).find((e) => e.kind === "approval" && e.status === "requested");
  // Onay, araç satırına itemId ile bağlanır (panelde "Onay bekliyor" doğru satırda).
  assert.ok(requested.toolCall.toolCallId && events(id).some((e) => e.kind === "tool" && e.id === requested.toolCall.toolCallId));
  assert.equal(requested.options.length, 4);
  await manager.approve(id, requested.requestId, "accept");
  await wait(async () => events(id).some((e) => e.kind === "turn"));
  let list = events(id);
  assert.ok(list.some((e) => e.kind === "approval" && e.status === "decided" && e.optionId === "accept"));
  const said = () =>
    events(id)
      .filter((e) => e.kind === "assistant")
      .map((e) => String(e.text))
      .join("");
  assert.ok(said().includes("onaylandı"));
  const toolDone = list.filter((e) => e.kind === "tool" && e.app === "update").find((e) => e.patch?.status === "completed");
  assert.ok(toolDone, "command tool completed");
  assert.ok(list.some((event) => event.kind === "tool" && event.app === "start" && event.data?.kind === "execute"), "command tool start stays visible");

  await manager.prompt(id, "komut çalıştır");
  await wait(async () => events(id).filter((e) => e.kind === "approval" && e.status === "requested").length === 2);
  const second = events(id).filter((e) => e.kind === "approval" && e.status === "requested")[1];
  await manager.approve(id, second.requestId, "decline");
  await wait(async () => events(id).filter((e) => e.kind === "turn").length === 2);
  list = events(id);
  assert.ok(said().includes("reddedildi"));
  assert.ok(
    list.filter((e) => e.kind === "tool" && e.app === "update").some((e) => e.patch?.status === "declined"),
  );
});

test("codex: file changes become diff blocks that fold into the changes panel", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await manager.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Diff",
    requestId: requestId(),
  });
  const id = created.id;
  await manager.prompt(id, "dosya düzenle");
  await wait(async () => events(id).some((e) => e.kind === "turn"));
  const fileTool = events(id).find((e) => e.kind === "tool" && e.app === "start" && e.data?.kind === "edit");
  assert.ok(fileTool, "file change tool card");
  const diff = fileTool.data.content.find((block) => block.type === "diff");
  assert.equal(diff.path, "src/fixture.txt");
  assert.ok(diff.oldText.includes("eski satır bir"));
  assert.ok(diff.newText.includes("yeni satır bir"));
  assert.ok(!diff.oldText.includes("+yeni"));
  // The update event carries the same folded diff for the panel.
  const updated = events(id).find((e) => e.kind === "tool" && e.app === "update" && e.patch?.status === "completed" && Array.isArray(e.patch.content) && e.patch.content[0]?.type === "diff");
  assert.ok(updated, "completed diff update");
});

test("codex: user-input question becomes a card and the answer flows back", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await manager.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Soru",
    requestId: requestId(),
  });
  const id = created.id;
  await manager.prompt(id, "soru sor");
  await wait(async () => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  const card = events(id).find((e) => e.kind === "approval" && e.status === "requested");
  assert.equal(card.options.length, 2);
  assert.equal(card.options[0].optionId, "Seçenek A");
  await manager.approve(id, card.requestId, "Seçenek B");
  await wait(async () => events(id).some((e) => e.kind === "turn"));
  const said = events(id)
    .filter((e) => e.kind === "assistant")
    .map((e) => String(e.text))
    .join("");
  assert.ok(said.includes("Seçenek B"));
});

test("codex: plan updates and cancel of a slow turn", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await manager.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Plan",
    requestId: requestId(),
  });
  const id = created.id;
  await manager.prompt(id, "plan yap");
  await wait(async () => events(id).some((e) => e.kind === "turn"));
  const plan = events(id).find((e) => e.kind === "plan");
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].content, "Adım bir");

  await manager.prompt(id, "yavaş iş");
  await wait(async () => manager.stateOf(id).status === "running");
  const cancelled = await manager.cancel(id);
  assert.deepEqual(cancelled, { cancelled: true });
  await wait(async () => events(id).some((e) => e.kind === "turn" && e.stopReason === "interrupted"));
  assert.equal(manager.stateOf(id).status, "idle");
});

test("codex: resume succeeds on a known thread and reopens visibly when missing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-codex-resume-"));
  const stateDir = dir;
  const mk = (resume) =>
    new CodexManager({
      root,
      stateDir,
      agentCommand: { command: process.execPath, args: [fixture] },
      projects: [{ id: "agent-panel", name: "Panel", path: stateDir }],
      env: { ...process.env, FIXTURE_RESUME: resume },
    });
  const manager1 = mk("missing");
  const created = await manager1.create({
    projectId: "agent-panel",
    agentId: "codex",
    title: "Resume",
    requestId: requestId(),
  });
  const id = created.id;
  await manager1.shutdown();

  const manager2 = mk("ok");
  const ok = await manager2.ensureConnected(id);
  assert.equal(ok, true);
  let list = manager2.readEvents(id, {}).events;
  assert.ok(list.some((e) => e.kind === "status" && e.status === "resumed"));
  assert.ok(!list.some((e) => e.kind === "status" && e.status === "reopened"));
  await manager2.shutdown();

  const manager3 = mk("missing");
  const reopened = await manager3.ensureConnected(id);
  assert.equal(reopened, true);
  list = manager3.readEvents(id, {}).events;
  assert.ok(list.some((e) => e.kind === "status" && e.status === "reopened"));
  await manager3.shutdown();
  cleanup(dir);
});

test("codex: validation, idempotency and record caps", async (t) => {
  const { dir, manager } = setup();
  t.after(() => cleanup(dir, manager));
  await assert.rejects(
    manager.create({ projectId: "agent-panel", agentId: "hermes", title: "x", requestId: requestId() }),
    /yalnız Codex/,
  );
  const key = requestId();
  const first = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "A", requestId: key });
  const again = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "B", requestId: key });
  assert.equal(again.id, first.id);
  await assert.rejects(manager.prompt(first.id, "x".repeat(9000)), /karakter/);
  assert.throws(() => manager.get(crypto.randomUUID()), /bulunamadı/);
});

test("codex and acp managers share one store without crossing records", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-shared-"));
  const store = new StructuredStore({ stateDir: dir });
  const acp = new StructuredManager({
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [acpFixture] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: { ...process.env },
    store,
  });
  const codex = new CodexManager({
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [fixture] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: { ...process.env },
    store,
  });
  t.after(() => cleanup(dir, acp, codex));
  const a = await acp.create({ projectId: "agent-panel", agentId: "hermes", title: "ACP", requestId: requestId() });
  const c = await codex.create({ projectId: "agent-panel", agentId: "codex", title: "Codex", requestId: requestId() });
  assert.equal(acp.list().length, 1);
  assert.equal(codex.list().length, 1);
  assert.equal(acp.list()[0].id, a.id);
  assert.equal(codex.list()[0].id, c.id);
  assert.throws(() => acp.get(c.id), /bulunamadı/);
  assert.throws(() => codex.get(a.id), /bulunamadı/);
  assert.equal(store.records.length, 2);
});

test("parseUnifiedDiff folds a unified diff into old/new text", () => {
  const { oldText, newText } = parseUnifiedDiff(
    ["@@ -1,2 +1,2 @@", "-eski", "+yeni", " bağlam", " son"].join("\n"),
  );
  assert.equal(oldText, "eski\nbağlam\nson");
  assert.equal(newText, "yeni\nbağlam\nson");
});

function protocolCalls(fixtureLog, method) {
  return fs.readFileSync(fixtureLog, "utf8").split("\n")
    .filter((line) => line.startsWith(`params ${method} `))
    .map((line) => JSON.parse(line.slice(`params ${method} `.length)));
}

test("codex: explicit permissions reach thread and turn, persist and restore with model/effort", async (t) => {
  const { dir, manager, fixtureLog, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Ayarlar", requestId: requestId() });
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write");
  const start = protocolCalls(fixtureLog, "thread/start")[0];
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(start.approvalPolicy, "on-request");
  assert.equal((await manager.sessionInfo(id)).models.currentModelId, "fixture-model-a", "top-level response.model is authoritative");

  await manager.setMode(id, "full-access");
  assert.equal(manager.stateOf(id).modes.currentModeId, "full-access");
  await manager.setModel(id, "fixture-model-b", "high");
  let state = manager.stateOf(id);
  assert.equal(state.model, "fixture-model-b");
  assert.equal(state.reasoningEffort, "high");
  assert.equal(state.modes.currentModeId, "full-access");
  const change = protocolCalls(fixtureLog, "thread/resume").at(-1);
  assert.equal(change.excludeTurns, true);
  assert.equal(change.sandbox, "danger-full-access");
  assert.equal(change.approvalPolicy, "never");
  assert.deepEqual(change.config, { model_reasoning_effort: "high" });
  await manager.prompt(id, "sohbet");
  await wait(() => events(id).some((event) => event.kind === "turn"));
  const turn = protocolCalls(fixtureLog, "turn/start").at(-1);
  assert.deepEqual(turn.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.model, "fixture-model-b");
  assert.equal(turn.effort, "high");

  await manager.shutdown();
  const restored = new CodexManager({ root, stateDir: dir, agentCommand: { command: process.execPath, args: [fixture] }, projects: [{ id: "agent-panel", name: "Panel", path: dir }], env: { ...process.env, FIXTURE_LOG: fixtureLog } });
  t.after(() => restored.shutdown());
  assert.equal(restored.stateOf(id).modes.currentModeId, "full-access");
  assert.equal(await restored.ensureConnected(id), true);
  state = restored.stateOf(id);
  assert.equal(state.modes.currentModeId, "full-access");
  assert.equal(state.model, "fixture-model-b");
  assert.equal(state.reasoningEffort, "high");
  assert.equal(protocolCalls(fixtureLog, "thread/resume").at(-1).excludeTurns, true);
  assert.equal(protocolCalls(fixtureLog, "thread/resume").at(-1).sandbox, "danger-full-access");
  await restored.setMode(id, "read-only");
  await restored.prompt(id, "sohbet");
  await wait(() => restored.stateOf(id).status === "idle");
  const readTurn = protocolCalls(fixtureLog, "turn/start").at(-1);
  assert.deepEqual(readTurn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(readTurn.approvalPolicy, "on-request");
  await restored.shutdown();
});

test("codex: rejected access changes preserve confirmed preferences and require reconnect", async (t) => {
  const { dir, manager, fixtureLog } = setup({ FIXTURE_REJECT_FULL: "1" });
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Ret", requestId: requestId() });
  await assert.rejects(manager.setMode(id, "full-access"), { status: 503 });
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write");
  assert.equal(manager.stateOf(id).status, "offline");
  assert.match(manager.stateOf(id).lastError, /refuses full access/);
  assert.equal(manager.store.get(id).codexModeId, "workspace-write");
  assert.equal(await manager.ensureConnected(id), true);
  assert.equal(protocolCalls(fixtureLog, "thread/resume").at(-1).sandbox, "workspace-write");
  assert.equal(manager.stateOf(id).lastError, null);
});

test("codex: validation and model defaults prevent unsupported reasoning choices", async (t) => {
  const { dir, manager, fixtureLog } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Kontrol", requestId: requestId() });
  await assert.rejects(manager.setMode(id, "danger-full-access"), { status: 400 });
  await assert.rejects(manager.setModel(id, "unknown-model"), { status: 400 });
  await assert.rejects(manager.setModel(id, "fixture-model-a", "low"), { status: 400 });
  await assert.rejects(manager.setModel(id, "fixture-model-a", { evil: true }), { status: 400 });
  assert.equal(protocolCalls(fixtureLog, "thread/resume").length, 0);
  await manager.setModel(id, "fixture-model-b");
  assert.equal(manager.stateOf(id).reasoningEffort, "low");
  assert.deepEqual(protocolCalls(fixtureLog, "thread/resume").at(-1).config, { model_reasoning_effort: "low" });
});

test("codex: in-progress changes keep old state and reject competing prompt/settings", async (t) => {
  const { dir, manager, wait, fixtureLog } = setup({ FIXTURE_RESUME_DELAY_MS: "150" });
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Yarış", requestId: requestId() });
  const change = manager.setMode(id, "full-access");
  await wait(() => manager.stateOf(id).settingsChanging);
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write", "no optimistic privilege display");
  await assert.rejects(manager.prompt(id, "sohbet"), { status: 409 });
  await assert.rejects(manager.setMode(id, "read-only"), { status: 409 });
  await assert.rejects(manager.setModel(id, "fixture-model-a", "high"), { status: 409 });
  await change;
  assert.equal(manager.stateOf(id).modes.currentModeId, "full-access");
  assert.equal(protocolCalls(fixtureLog, "turn/start").length, 0);

  await manager.prompt(id, "yavaş iş");
  await assert.rejects(manager.prompt(id, "ikinci mesaj"), { status: 409 });
  await assert.rejects(manager.setMode(id, "read-only"), { status: 409 });
  await assert.rejects(manager.setModel(id, "fixture-model-a", "high"), { status: 409 });
  await wait(() => protocolCalls(fixtureLog, "turn/start").length === 1);
  await manager.cancel(id);
  await wait(() => manager.stateOf(id).status === "idle");
});

test("codex: a pending approval also prevents a second prompt or access switch", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Onay yarışı", requestId: requestId() });
  await manager.prompt(id, "komut çalıştır");
  await wait(() => manager.stateOf(id).status === "attention");
  await assert.rejects(manager.prompt(id, "ikinci mesaj"), { status: 409 });
  await assert.rejects(manager.setMode(id, "full-access"), { status: 409 });
  const approval = events(id).find((event) => event.kind === "approval" && event.status === "requested");
  await manager.approve(id, approval.requestId, "decline");
  await wait(() => manager.stateOf(id).status === "idle");
});

test("codex: effective setting mismatch rolls the complete preferences back", async (t) => {
  const { dir, manager } = setup({ FIXTURE_COERCE_FULL: "1", FIXTURE_COERCE_MODEL: "1", FIXTURE_COERCE_READONLY_FULL: "1" });
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Uyumsuz", requestId: requestId() });
  await assert.rejects(manager.setMode(id, "full-access"), { status: 409 });
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write");
  assert.equal(await manager.ensureConnected(id), true);
  await assert.rejects(manager.setMode(id, "read-only"), { status: 409 });
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write", "unexpected full-access response cannot elevate saved permission");
  assert.equal(await manager.ensureConnected(id), true);
  await assert.rejects(manager.setModel(id, "fixture-model-b", "high"), { status: 409 });
  assert.equal(manager.stateOf(id).status, "offline");
  assert.equal(manager.stateOf(id).model, "fixture-model-a");
  assert.equal(manager.stateOf(id).reasoningEffort, "medium");
  assert.equal(await manager.ensureConnected(id), true);
  assert.equal(manager.stateOf(id).model, "fixture-model-a");
  assert.equal(manager.stateOf(id).reasoningEffort, "medium");
});

test("codex: failed preference save cannot leak full access or model/effort into error-save", async (t) => {
  const { dir, manager } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Disk arızası", requestId: requestId() });
  const originalSave = manager.store.save.bind(manager.store);
  const failNextSave = () => {
    let saves = 0;
    manager.store.save = () => {
      if (++saves === 1) throw new Error("fixture disk full");
      return originalSave();
    };
  };
  const assertOld = () => {
    assert.equal(manager.stateOf(id).status, "offline");
    assert.equal(manager.store.get(id).codexModeId, "workspace-write");
    assert.equal(manager.store.get(id).codexModelId, "fixture-model-a");
    assert.equal(manager.store.get(id).codexReasoningEffort, "medium");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "structured.json"), "utf8")).find((record) => record.id === id);
    assert.equal(saved.codexModeId, "workspace-write");
    assert.equal(saved.codexModelId, "fixture-model-a");
    assert.equal(saved.codexReasoningEffort, "medium");
    assert.match(saved.lastError, /disk full/);
  };
  failNextSave();
  await assert.rejects(manager.setMode(id, "full-access"), { status: 503 });
  assertOld();
  manager.store.save = originalSave;
  assert.equal(await manager.ensureConnected(id), true);
  failNextSave();
  await assert.rejects(manager.setModel(id, "fixture-model-b", "high"), { status: 503 });
  assertOld();
  manager.store.save = originalSave;
  assert.equal(await manager.ensureConnected(id), true);
  assert.equal(manager.stateOf(id).modes.currentModeId, "workspace-write");
  assert.equal(manager.stateOf(id).model, "fixture-model-a");
  assert.equal(manager.stateOf(id).reasoningEffort, "medium");
});

const formQuestions = () => [
  { id: "q1", header: "Metin", question: "Özel yanıt", options: null, isSecret: true },
  { id: "q2", header: "Çoklu", question: "Seçenekler", options: [{ label: "A", description: "İlk" }, { label: "B" }], multiSelect: true },
  { id: "q3", header: "Diğer", question: "Seç veya yaz", options: [{ label: "Bir" }], isOther: true },
];

test("codex: question forms carry every answer through the transport without recording answer text", async (t) => {
  const { dir, manager, wait, events, fixtureLog } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Form", requestId: requestId() });
  await manager.prompt(id, "form soruları");
  await wait(() => manager.stateOf(id).status === "attention");
  const card = events(id).find((event) => event.kind === "approval" && event.questions);
  assert.equal(card.questions.length, 3);
  assert.equal(card.questions[0].isSecret, true);
  assert.equal(card.questions[1].multiSelect, true);
  assert.equal(card.questions[1].options[0].description, "İlk");
  assert.equal(card.questions[2].isOther, true);
  const secret = "SECRET_FORM_VALUE_19d2f";
  const other = "PRIVATE_OTHER_7c28";
  await manager.approve(id, card.requestId, "__answer", { q1: secret, q2: ["A", "B"], q3: other });
  await wait(() => manager.stateOf(id).status === "idle");
  assert.match(fs.readFileSync(fixtureLog, "utf8"), /form answered/);
  const decision = events(id).find((event) => event.kind === "approval" && event.status === "decided");
  assert.equal(decision.optionId, "__answer");
  assert.equal(decision.answers, undefined);
  for (const file of fs.readdirSync(dir)) {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    assert.equal(content.includes(secret), false, `${file} cannot record secret answer`);
    assert.equal(content.includes(other), false, `${file} cannot record free answer`);
  }
});

test("codex: direct form bridge validates full answer structure and returns exact protocol values", async (t) => {
  const { dir, manager, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Yanıt kontrolü", requestId: requestId() });
  const runtime = manager.runtimes.get(id);
  const result = manager._userInputRequest(id, runtime, { questions: formQuestions() });
  const card = events(id).find((event) => event.questions);
  const invalid = [
    undefined, {}, [], { q1: "a", q2: ["A"] },
    { q1: "a", q2: ["A"], q3: "Bir", unknown: "x" },
    { q1: " ", q2: ["A"], q3: "Bir" },
    { q1: "x".repeat(4001), q2: ["A"], q3: "Bir" },
    { q1: ["a", "b"], q2: ["A"], q3: "Bir" },
    { q1: "a", q2: [], q3: "Bir" },
    { q1: "a", q2: ["A", "A"], q3: "Bir" },
    { q1: "a", q2: ["unadvertised"], q3: "Bir" },
    { q1: "a", q2: [123], q3: "Bir" },
    { q1: "a", q2: ["A"], q3: "bad\0value" },
  ];
  for (const answers of invalid) {
    await assert.rejects(manager.approve(id, card.requestId, "__answer", answers), { status: 400 });
    assert.equal(runtime.pendingApprovals.size, 1, "invalid submission keeps form pending");
  }
  await assert.rejects(manager.approve(id, card.requestId, "accept"), { status: 400 });
  await manager.approve(id, card.requestId, "__answer", { q1: "exact free text", q2: ["A", "B"], q3: "other value" });
  assert.deepEqual(await result, { answers: { q1: { answers: ["exact free text"] }, q2: { answers: ["A", "B"] }, q3: { answers: ["other value"] } } });
  assert.throws(() => manager._userInputRequest(id, runtime, { questions: [] }), { status: 400 });
  assert.throws(() => manager._userInputRequest(id, runtime, { questions: [...formQuestions(), { id: "q4", question: "four" }] }), { status: 400 });
  assert.throws(() => manager._userInputRequest(id, runtime, { questions: [formQuestions()[0], formQuestions()[0]] }), { status: 400 });
  for (const labels of [["same", "same"], ["__answer"], ["__deny"]])
    assert.throws(() => manager._userInputRequest(id, runtime, { questions: [{ id: "ambiguous", question: "Seç", options: labels.map((label) => ({ label })) }] }), { status: 400 });
  const secretResult = manager._userInputRequest(id, runtime, { questions: [{ id: "secret", question: "Gizli değer", isSecret: true, isOther: false, options: [{ label: "advertised" }] }] });
  const secretCard = events(id).filter((event) => event.questions).at(-1);
  await manager.approve(id, secretCard.requestId, "__answer", { secret: "masked custom value" });
  assert.deepEqual(await secretResult, { answers: { secret: { answers: ["masked custom value"] } } });
  const limitResult = manager._userInputRequest(id, runtime, { questions: [{ id: "limit", question: "Çoklu metin", multiSelect: true }] });
  const limitCard = events(id).filter((event) => event.questions).at(-1);
  await assert.rejects(manager.approve(id, limitCard.requestId, "__answer", { limit: Array.from({ length: 9 }, (_, index) => String(index)) }), { status: 400 });
  await assert.rejects(manager.approve(id, limitCard.requestId, "__answer", { limit: ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000), "d".repeat(4000)] }), { status: 400 });
  const boundary = ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000)];
  await manager.approve(id, limitCard.requestId, "__answer", { limit: boundary });
  assert.deepEqual(await limitResult, { answers: { limit: { answers: boundary } } });
});

test("codex: deny, cancel, stop and timeout return an empty answer for every question", async (t) => {
  const { dir, manager, events } = setup();
  t.after(() => cleanup(dir, manager));
  const expected = { answers: { q1: { answers: [] }, q2: { answers: [] }, q3: { answers: [] } } };
  for (const action of ["deny", "cancel", "stop", "timeout"]) {
    const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: action, requestId: requestId() });
    const runtime = manager.runtimes.get(id);
    if (action === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = manager._userInputRequest(id, runtime, { questions: formQuestions() });
    const card = events(id).find((event) => event.questions);
    if (action === "deny") await manager.approve(id, card.requestId, "__deny");
    if (action === "cancel") {
      runtime.currentTurnId = "fixture-pending-turn";
      assert.equal((await manager.cancel(id)).cancelled, true);
    }
    if (action === "stop") await manager.stop(id);
    if (action === "timeout") t.mock.timers.tick(300001);
    assert.deepEqual(await result, expected, action);
    assert.equal(runtime.pendingApprovals.size, 0, action);
    if (action === "timeout") t.mock.timers.reset();
    const outcome = events(id).find((event) => event.kind === "approval" && event.requestId === card.requestId && event.status !== "requested");
    assert.equal(outcome.status, action === "deny" ? "decided" : "expired");
  }
});

test("codex: shutdown/delete/exit drain pending output and leave no late flush timer", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  for (const action of ["shutdown", "delete", "exit"]) {
    const { dir, manager, events } = setup();
    t.after(() => cleanup(dir, manager));
    const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: action, requestId: requestId() });
    const runtime = manager.runtimes.get(id);
    const emitted = [];
    manager.on("event", (_id, event) => emitted.push(event));
    manager._onItemStarted(id, runtime, { id: "buffered-command", type: "commandExecution", command: "fixture", status: "inProgress" });
    manager._onNotification(id, runtime, "item/commandExecution/outputDelta", { threadId: runtime.threadId, itemId: "buffered-command", delta: "buffered output survives close" });
    const state = runtime.items.get("buffered-command");
    assert.ok(state.flushTimer);
    if (action === "shutdown") await manager.shutdown();
    if (action === "delete") await manager.delete(id);
    if (action === "exit") await runtime.conn.close();
    assert.equal(runtime.closed, true);
    assert.equal(state.flushTimer, null);
    assert.ok(emitted.some((event) => event.kind === "tool" && event.patch?.content?.[0]?.content?.text === "buffered output survives close"));
    if (action !== "delete") assert.ok(events(id).some((event) => event.patch?.content?.[0]?.content?.text === "buffered output survives close"));
    const count = emitted.length;
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(emitted.length, count, `${action} has no late output updates`);
    if (action === "delete") assert.equal(fs.existsSync(manager.store.logPath(id)), false, "deleted log is not recreated by a flush");
    manager._onNotification(id, runtime, "item/commandExecution/outputDelta", { threadId: runtime.threadId, itemId: "buffered-command", delta: "late data" });
    assert.equal(state.flushTimer, null);
  }
  assert.equal(errors.mock.callCount(), 0, "closing output cannot produce ENOENT append errors");
});

test("codex: completed and evicted tool output cancels its timer without losing final text", async (t) => {
  const { dir, manager, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await manager.create({ projectId: "agent-panel", agentId: "codex", title: "Flush", requestId: requestId() });
  const runtime = manager.runtimes.get(id);
  manager._onItemStarted(id, runtime, { id: "completed-command", type: "commandExecution", command: "fixture", status: "inProgress" });
  manager._onNotification(id, runtime, "item/commandExecution/outputDelta", { threadId: runtime.threadId, itemId: "completed-command", delta: "partial" });
  const completed = runtime.items.get("completed-command");
  manager._onItemCompleted(id, runtime, { id: "completed-command", type: "commandExecution", status: "completed", aggregatedOutput: "complete final output", exitCode: 0 });
  assert.equal(completed.flushTimer, null);
  const latest = () => events(id).filter((event) => event.id === "completed-command" && event.app === "update").at(-1);
  assert.equal(latest().patch.content[0].content.text, "complete final output");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(latest().patch.content[0].content.text, "complete final output", "partial queued flush cannot overwrite final output");
  manager._rememberItem(runtime, { id: "evicted-command", type: "commandExecution" });
  const evicted = runtime.items.get("evicted-command");
  evicted.output = "retained evicted output";
  manager._queueOutputFlush(id, runtime, "evicted-command");
  for (let i = 0; i < 301; i++) manager._rememberItem(runtime, { id: `item-${i}`, type: "agentMessage" });
  assert.equal(runtime.items.has("evicted-command"), false);
  assert.equal(evicted.flushTimer, null);
  assert.ok(events(id).some((event) => event.patch?.content?.[0]?.content?.text === "retained evicted output"));
});

// The double must fail if a future manager regresses the documented handshake.
test("codex fixture rejects requests until initialize and initialized both arrive", async t => {
  const conn = new AcpConnection({ command: process.execPath, args: [fixture], cwd: root, env: process.env });
  t.after(() => conn.close()); conn.start();
  await assert.rejects(conn.request("model/list", {}), /Not initialized/);
  await conn.request("initialize", { clientInfo: { name: "fixture-test", version: "1" } });
  await assert.rejects(conn.request("thread/start", {}), /Not initialized/);
  conn.notify("initialized", {});
  assert.equal((await conn.request("model/list", {})).data.length, 2);
  await assert.rejects(conn.request("initialize", {}), /Already initialized/);
  await assert.rejects(conn.request("thread/resume", { threadId: "fixture" }), /excludeTurns required/);
});
