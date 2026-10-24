// Claude Code structured tier: resolver and child environment, manager
// lifecycle, stream-json normalization (streamed text/thinking, tools, edits,
// todo plan, usage), the can_use_tool approval bridge, questions, cancel,
// resume/reopen, and store sharing with the other tiers — all against the
// deterministic stream-json fixture (no model, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  ClaudeManager,
  CLAUDE_STREAM_ARGS,
  claudeChildEnv,
  claudeToolDiffs,
  claudeToolTitle,
  resolveClaudeCommand,
} from "../server/claude-manager.mjs";
import { CodexManager } from "../server/codex-manager.mjs";
import { StructuredManager } from "../server/structured-manager.mjs";
import { StructuredStore } from "../server/structured-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/fake-claude.mjs");

function setup({ dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-claude-")), store, env = {} } = {}) {
  const fixtureLog = path.join(dir, "fixture.log");
  const manager = new ClaudeManager({
    root,
    stateDir: dir,
    agentCommand: { command: process.execPath, args: [fixture, ...CLAUDE_STREAM_ARGS] },
    projects: [{ id: "agent-panel", name: "Panel", path: dir }],
    env: {
      ...process.env,
      FIXTURE_LOG: fixtureLog,
      FIXTURE_STATE: path.join(dir, "fixture-state.json"),
      CLAUDECODE: "1",
      ...env,
    },
    store,
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
  const logged = () =>
    fs.existsSync(fixtureLog)
      ? fs.readFileSync(fixtureLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  return { dir, manager, wait, events, logged };
}

function cleanup(dir, ...managers) {
  for (const manager of managers) manager.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

const requestId = () => crypto.randomUUID().replace(/-/g, "").padEnd(24, "x");
const create = (manager, title = "Fixture sohbet") =>
  manager.create({ projectId: "agent-panel", agentId: "claude", title, requestId: requestId() });
const turnDone = (events, id, count = 1) => () =>
  events(id).filter((e) => e.kind === "turn").length >= count;

test("claude: the resolver always carries the stream-json protocol flags", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-claude-resolve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveClaudeCommand({ stateDir: dir, env: {} }), null);
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ claude: process.execPath }));
  const resolved = resolveClaudeCommand({ stateDir: dir, env: {} });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, CLAUDE_STREAM_ARGS);
  assert.ok(resolved.args.includes("--permission-prompt-tool"));
  assert.ok(!resolved.args.some((arg) => /dangerously|bypass/i.test(arg)));
  const override = path.join(dir, "claude-override");
  fs.writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(
    resolveClaudeCommand({ stateDir: dir, env: { PANEL_CLAUDE_BINARY: override } }).command,
    override,
  );
  assert.equal(resolveClaudeCommand({ stateDir: dir, env: { PANEL_CLAUDE_BINARY: path.join(dir, "missing") } }), null);
});

test("claude: child env drops nested-session and service markers", () => {
  const env = claudeChildEnv({
    HOME: "/tmp/example-home",
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    PANEL_PORT: "1",
    TMUX: "x",
    ANTHROPIC_MODEL: "kept",
  });
  assert.deepEqual(env, { HOME: "/tmp/example-home", PATH: "/bin", ANTHROPIC_MODEL: "kept" });
});

test("claude: tool titles and edit diffs", () => {
  assert.equal(claudeToolTitle("Bash", { command: "ls", description: "Listele" }), "Listele");
  assert.equal(claudeToolTitle("Read", { file_path: "/a/b.txt" }), "Read: /a/b.txt");
  assert.equal(claudeToolTitle("Grep", { pattern: "foo" }), "Ara: foo");
  assert.deepEqual(claudeToolDiffs("Edit", { file_path: "f", old_string: "a", new_string: "b" }), [
    { type: "diff", path: "f", oldText: "a", newText: "b" },
  ]);
  assert.equal(claudeToolDiffs("Write", { file_path: "f", content: "x" })[0].oldText, "");
  assert.equal(claudeToolDiffs("MultiEdit", { file_path: "f", edits: [{}, {}] }).length, 2);
  assert.equal(claudeToolDiffs("Bash", { command: "ls" }), null);
});

test("claude: create, streamed chat, thinking, usage; subagent text stays out", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await create(manager);
  assert.equal(created.agentId, "claude");
  assert.equal(created.kind, "structured");
  assert.equal(created.claudeStarted, false);
  assert.match(created.claudeSessionId, /^[0-9a-f-]{36}$/);
  const id = created.id;
  const first = logged()[0];
  assert.deepEqual(first.argv.slice(-2), ["--session-id", created.claudeSessionId]);
  assert.ok(first.argv.includes("--allow-dangerously-skip-permissions"));
  assert.ok(!first.argv.includes("--dangerously-skip-permissions"));
  assert.equal(first.env.CLAUDECODE, null, "nested-session marker must not leak");

  const info = await manager.sessionInfo(id);
  assert.equal(info.state.status, "idle");
  assert.deepEqual(
    info.models.availableModels.map((m) => m.modelId),
    ["default", "sonnet"],
  );
  assert.equal(info.state.modes.currentModeId, "default");
  assert.ok(info.state.modes.availableModes.some((m) => m.id === "bypassPermissions" && m.name === "Tam erişim"));

  await manager.prompt(id, "merhaba dünya");
  await wait(turnDone(events, id));
  const list = events(id);
  assert.equal(list[0].kind, "user");
  const assistantText = list.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.equal(assistantText, "Merhaba, kullanıcı.", "streamed deltas only, no duplicate full message");
  assert.equal(list.filter((e) => e.kind === "thought").map((e) => e.text).join(""), "Düşünüyorum");
  assert.ok(!JSON.stringify(list).includes("ALT AJAN"));
  const usage = list.find((e) => e.kind === "usage");
  assert.equal(usage.used, 2040);
  assert.equal(usage.size, 200000);
  assert.equal(list.find((e) => e.kind === "turn").stopReason, "end_turn");
  assert.equal(manager.get(id).claudeStarted, true);
  assert.equal(manager.stateOf(id).status, "idle");
  const sent = logged().find((e) => e.in?.type === "user").in;
  assert.equal(sent.message.content[0].text, "merhaba dünya");
});

test("claude: a second prompt during a running turn is refused", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "yavas");
  await wait(() => events(id).some((e) => e.kind === "assistant"));
  await assert.rejects(manager.prompt(id, "tekrar"), (e) => e.status === 409);
  const cancelled = await manager.cancel(id);
  assert.equal(cancelled.cancelled, true);
  await wait(turnDone(events, id));
  const turn = events(id).find((e) => e.kind === "turn");
  assert.equal(turn.stopReason, "cancelled");
  assert.ok(!events(id).some((e) => e.kind === "error"), "a user stop is not an error");
  assert.equal(manager.stateOf(id).status, "idle");
});

test("claude: approval bridge allows once and for the session only", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "komut");
  await wait(() => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  const request = events(id).find((e) => e.kind === "approval");
  assert.equal(request.toolCall.rawInput.command, "ls -la");
  // Panel "Onay bekliyor"u araç satırına bu kimlikle bağlar.
  assert.equal(request.toolCall.toolCallId, "toolu_bash");
  assert.ok(events(id).some((e) => e.kind === "tool" && e.id === "toolu_bash"));
  assert.deepEqual(
    request.options.map((o) => o.optionId),
    ["allow", "allowSession", "deny", "denyStop"],
  );
  assert.equal(manager.stateOf(id).status, "attention");
  await assert.rejects(manager.approve(id, request.requestId, "bogus"), (e) => e.status === 400);
  await manager.approve(id, request.requestId, "allowSession");
  await wait(turnDone(events, id));
  const response = logged().find((e) => e.in?.type === "control_response").in.response;
  assert.equal(response.response.behavior, "allow");
  assert.deepEqual(response.response.updatedInput, { command: "ls -la", description: "Dosyaları listele" });
  assert.equal(response.response.updatedPermissions[0].destination, "session");
  const tool = events(id).filter((e) => e.kind === "tool" && e.id === "toolu_bash");
  assert.equal(tool[0].app, "start");
  assert.equal(tool[0].data.kind, "execute");
  assert.equal(tool.at(-1).patch.status, "completed");
  assert.equal(tool.at(-1).patch.content[0].content.text, "a.txt\nb.txt");
});

test("claude: deny-and-stop interrupts without an error note", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "komut");
  await wait(() => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  const request = events(id).find((e) => e.kind === "approval");
  await manager.approve(id, request.requestId, "denyStop");
  await wait(turnDone(events, id));
  const response = logged().find((e) => e.in?.type === "control_response").in.response.response;
  assert.equal(response.behavior, "deny");
  assert.equal(response.interrupt, true);
  assert.equal(events(id).find((e) => e.kind === "turn").stopReason, "cancelled");
  assert.ok(!events(id).some((e) => e.kind === "error"));
  const tool = events(id).filter((e) => e.kind === "tool" && e.id === "toolu_bash");
  assert.equal(tool.at(-1).patch.status, "failed");
});

test("claude: edits keep their diff, TodoWrite becomes the plan", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "duzenle");
  await wait(turnDone(events, id));
  const edit = events(id).filter((e) => e.kind === "tool" && e.id === "toolu_edit");
  assert.equal(edit[0].data.kind, "edit");
  assert.deepEqual(edit[0].data.content, [
    { type: "diff", path: "/tmp/x.txt", oldText: "eski", newText: "yeni" },
  ]);
  assert.deepEqual(edit.at(-1).patch, { status: "completed" });
  await manager.prompt(id, "plan");
  await wait(turnDone(events, id, 2));
  const plan = events(id).find((e) => e.kind === "plan");
  assert.deepEqual(plan.entries, [
    { content: "Birinci", status: "completed" },
    { content: "İkinci", status: "in_progress" },
  ]);
  assert.ok(!events(id).some((e) => e.kind === "tool" && e.id === "toolu_todo"));
});

test("claude: a single-choice question becomes a card and answers the tool", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "soru");
  await wait(() => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  const card = events(id).find((e) => e.kind === "approval");
  assert.equal(card.toolCall.title, "Seçim · Hangisi?");
  assert.deepEqual(card.options.map((o) => o.optionId), ["A", "B", "__answer", "__deny"]);
  await manager.approve(id, card.requestId, "B");
  await wait(turnDone(events, id));
  const answered = logged().find((e) => e.answered).answered;
  assert.equal(answered.behavior, "allow");
  assert.deepEqual(answered.updatedInput.answers, { "Hangisi?": "B" });
  assert.match(events(id).filter((e) => e.kind === "assistant").at(-1).text, /Seçim: B/);
});

test("claude: a cancelled permission request expires its card", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "vazgec");
  await wait(turnDone(events, id));
  const statuses = events(id).filter((e) => e.kind === "approval").map((e) => e.status);
  assert.deepEqual(statuses, ["requested", "expired"]);
  assert.equal(manager.stateOf(id).pendingApprovalCount, 0);
});

test("claude: one form answers multiple questions, multi-select and custom text", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "sorular");
  await wait(() => events(id).some((e) => e.kind === "approval"));
  const card = events(id).find((e) => e.kind === "approval");
  assert.equal(card.questions.length, 3);
  assert.equal(card.questions[1].multiSelect, true);
  assert.equal(card.questions[2].options.length, 0);
  assert.equal(card.questions[0].isOther, true);
  for (const answers of [undefined, {}, { q1: "Açık" }, { q1: "Açık", q2: [], q3: "not" },
    { q1: ["Açık", "Koyu"], q2: ["Test"], q3: "not" }, { q1: "Açık", q2: ["Test", "Test"], q3: "not" },
    { q1: "Açık", q2: ["Test"], q3: "   " }, { q1: "Açık", q2: ["Test"], q3: "a".repeat(4001) },
    { q1: "Açık", q2: ["Test"], q3: "not", extra: "fazla" }]) {
    await assert.rejects(manager.approve(id, card.requestId, "__answer", answers), (e) => e.status === 400);
    assert.equal(manager.stateOf(id).pendingApprovalCount, 1);
  }
  const note = "fixture özel kullanıcı notu";
  await manager.approve(id, card.requestId, "__answer", { q1: "Özel tema", q2: ["Günlük", "Test"], q3: note });
  await wait(turnDone(events, id));
  assert.deepEqual(logged().find((e) => e.answered).answered.updatedInput.answers, {
    "Hangi tema?": "Özel tema", "Hangi özellikler?": "Günlük, Test", "Eklemek istediğin ne?": note,
  });
  assert.ok(!JSON.stringify(events(id)).includes(note), "tool_result must not copy submitted forms into the panel log");
  const decided = events(id).find((e) => e.kind === "approval" && e.status === "decided");
  assert.equal(decided.optionId, "__answer");
  await assert.rejects(manager.approve(id, card.requestId, "__answer", { q1: "yeni" }), (e) => e.status === 409);
});

test("claude: free text and secret answers are forwarded without panel event payloads", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  for (const [index, prompt] of ["serbest", "gizlisoru"].entries()) {
    await manager.prompt(id, prompt);
    await wait(() => events(id).filter((e) => e.kind === "approval" && e.status === "requested").length === index + 1);
    const card = events(id).filter((e) => e.kind === "approval" && e.status === "requested").at(-1);
    assert.equal(card.questions[0].isSecret, prompt === "gizlisoru");
    const value = `fixture-answer-never-in-panel-${index}`;
    await manager.approve(id, card.requestId, "__answer", { q1: value });
    await wait(turnDone(events, id, index + 1));
    assert.ok(!fs.readFileSync(manager.store.logPath(id), "utf8").includes(value));
    assert.equal(logged().filter((e) => e.answered).at(-1).answered.updatedInput.answers["Yanıtın nedir?"], value);
  }
});

test("claude: question rejection, cancellation, expiry and stop stay closed", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "serbest");
  await wait(() => manager.stateOf(id).pendingApprovalCount === 1);
  let card = events(id).find((e) => e.kind === "approval");
  await manager.approve(id, card.requestId, "__deny");
  await wait(turnDone(events, id));
  assert.equal(logged().find((e) => e.answered).answered.behavior, "deny");
  await manager.prompt(id, "soruiptal");
  await wait(turnDone(events, id, 2));
  card = events(id).filter((e) => e.kind === "approval" && e.status === "requested").at(-1);
  await assert.rejects(manager.approve(id, card.requestId, "__answer", { q1: "geç" }), (e) => e.status === 409);
  await manager.prompt(id, "serbest");
  await wait(() => manager.stateOf(id).pendingApprovalCount === 1);
  card = events(id).filter((e) => e.kind === "approval" && e.status === "requested").at(-1);
  manager.runtimes.get(id).pendingApprovals.get(card.requestId).timer._onTimeout();
  await wait(turnDone(events, id, 3));
  await assert.rejects(manager.approve(id, card.requestId, "__answer", { q1: "geç" }), (e) => e.status === 409);
  await manager.prompt(id, "serbest");
  await wait(() => manager.stateOf(id).pendingApprovalCount === 1);
  card = events(id).filter((e) => e.kind === "approval" && e.status === "requested").at(-1);
  await manager.stop(id);
  await assert.rejects(manager.approve(id, card.requestId, "__answer", { q1: "geç" }), (e) => e.status === 409);
});

test("claude: oversized and duplicate question forms are visibly denied", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "bozuksoru");
  await wait(turnDone(events, id));
  assert.equal(logged().find((e) => e.answered).answered.behavior, "deny");
  assert.ok(!events(id).some((e) => e.kind === "approval"));
  assert.ok(events(id).some((e) => e.kind === "status" && /geçersiz/.test(e.detail)));
  const denied = await manager._permissionRequest(id, manager.runtimes.get(id), {
    tool_name: "AskUserQuestion", input: { questions: [{ question: "Aynı?" }, { question: "Aynı?" }] },
  }, "duplicate-fixture");
  assert.equal(denied.behavior, "deny");
});

test("claude: model and mode switches go through control requests", async (t) => {
  const { dir, manager, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.setModel(id, "sonnet");
  await manager.setMode(id, "acceptEdits");
  await assert.rejects(manager.setMode(id, "unknown"), (e) => e.status === 400);
  const controls = logged().filter((e) => e.in?.type === "control_request").map((e) => e.in.request);
  assert.deepEqual(controls.find((r) => r.subtype === "set_model"), { subtype: "set_model", model: "sonnet" });
  assert.deepEqual(controls.filter((r) => r.subtype === "set_permission_mode").at(-1), {
    subtype: "set_permission_mode",
    mode: "acceptEdits",
  });
  const state = manager.stateOf(id);
  assert.equal(state.model, "sonnet");
  assert.equal(state.modes.currentModeId, "acceptEdits");
  assert.ok(events(id).some((e) => e.kind === "mode" && e.currentModeId === "acceptEdits"));
});

test("claude: full access is an explicit per-chat choice and returns to default", async (t) => {
  const { dir, manager, wait, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const full = await create(manager);
  const other = await create(manager);
  await manager.setMode(full.id, "bypassPermissions");
  assert.equal(manager.stateOf(full.id).modes.currentModeId, "bypassPermissions");
  assert.equal(manager.stateOf(other.id).modes.currentModeId, "default");
  assert.equal(manager.get(full.id).claudePermissionMode, "bypassPermissions");
  await manager.prompt(full.id, "komut");
  await wait(turnDone(events, full.id));
  assert.ok(!events(full.id).some((e) => e.kind === "approval"));
  assert.equal(logged().filter((e) => e.activeMode).at(-1).activeMode, "bypassPermissions");
  await manager.setMode(full.id, "default");
  await manager.prompt(full.id, "komut");
  await wait(() => events(full.id).some((e) => e.kind === "approval" && e.status === "requested"));
  const card = events(full.id).find((e) => e.kind === "approval");
  await manager.approve(full.id, card.requestId, "deny");
  await wait(turnDone(events, full.id, 2));
  assert.equal(manager.get(full.id).claudePermissionMode, "default");
});

test("claude: settings bypass and a stale init snapshot cannot grant full access", async (t) => {
  const { dir, manager, wait, events, logged } = setup({ env: {
    FIXTURE_DEFAULT_MODE: "bypassPermissions", FIXTURE_STALE_INIT_MODE: "bypassPermissions",
  } });
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "merhaba");
  await wait(turnDone(events, id));
  assert.equal(logged().find((e) => e.activeMode).activeMode, "default");
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
  assert.equal(manager.get(id).claudePermissionMode, "default");
});

test("claude: policy rejection never publishes or persists a successful mode change", async (t) => {
  const { dir, manager, events } = setup({ env: { FIXTURE_REJECT_MODE: "bypassPermissions" } });
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 503 && /policy/.test(e.message));
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
  assert.equal(manager.get(id).claudePermissionMode, "default");
  assert.ok(!events(id).some((e) => e.kind === "mode"));
  assert.equal(await manager.ensureConnected(id), true);
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
});

test("claude: persistence failure rolls the live child back before accepting prompts", async (t) => {
  const { dir, manager, events, logged } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  const originalSave = manager.store.save;
  manager.store.save = () => { throw new Error("fixture disk failure"); };
  try {
    await assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 503 && /kaydedilemedi/.test(e.message));
  } finally {
    manager.store.save = originalSave;
  }
  assert.equal(manager.stateOf(id).status, "idle");
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
  assert.equal(manager.get(id).claudePermissionMode, "default");
  assert.ok(!events(id).some((e) => e.kind === "mode"));
  assert.deepEqual(logged().filter((e) => e.in?.request?.subtype === "set_permission_mode").map((e) => e.in.request.mode),
    ["default", "bypassPermissions", "default"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "structured.json"), "utf8"))[0].claudePermissionMode, "default");
});

test("claude: mode changes wait for the active turn and pending approval", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "komut");
  await wait(() => events(id).some((e) => e.kind === "approval" && e.status === "requested"));
  await assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 409);
  const card = events(id).find((e) => e.kind === "approval");
  await manager.approve(id, card.requestId, "deny");
  await wait(turnDone(events, id));
});

test("claude: a failed persistence rollback closes the uncertain child", async (t) => {
  const { dir, manager, events } = setup({ env: { FIXTURE_REJECT_MODE: "default", FIXTURE_REJECT_MODE_AFTER: "1" } });
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  const originalSave = manager.store.save;
  manager.store.save = () => { throw new Error("fixture disk failure"); };
  try {
    await assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 503);
  } finally {
    manager.store.save = originalSave;
  }
  assert.equal(manager.stateOf(id).status, "offline");
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
  assert.ok(!events(id).some((e) => e.kind === "mode"));
  assert.equal(await manager.ensureConnected(id), true);
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
});

test("claude: prompts and overlapping mode changes wait for control acknowledgment", async (t) => {
  const { dir, manager, wait, logged } = setup({ env: { FIXTURE_MODE_DELAY_MS: "100" } });
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  const switchMode = manager.setMode(id, "bypassPermissions");
  await wait(() => logged().some((e) => e.in?.request?.mode === "bypassPermissions"));
  assert.equal(manager.stateOf(id).settingsChanging, true);
  await assert.rejects(manager.prompt(id, "merhaba"), (e) => e.status === 409);
  await assert.rejects(manager.setMode(id, "plan"), (e) => e.status === 409);
  await assert.rejects(manager.setModel(id, "sonnet"), (e) => e.status === 409);
  assert.equal(manager.stateOf(id).modes.currentModeId, "default");
  await switchMode;
  assert.equal(manager.stateOf(id).settingsChanging, false);
  assert.equal(manager.stateOf(id).modes.currentModeId, "bypassPermissions");
  assert.ok(!logged().some((e) => e.in?.type === "user"));
});

test("claude: model changes share the idle and settings lock with permission changes", async (t) => {
  const { dir, manager, wait, events, logged } = setup({ env: { FIXTURE_MODEL_DELAY_MS: "100" } });
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  const setting = manager.setModel(id, "sonnet");
  await wait(() => logged().some((e) => e.in?.request?.subtype === "set_model"));
  assert.equal(manager.stateOf(id).settingsChanging, true);
  await assert.rejects(manager.prompt(id, "merhaba"), (e) => e.status === 409);
  await assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 409);
  await assert.rejects(manager.setModel(id, "default"), (e) => e.status === 409);
  await setting;
  assert.equal(manager.stateOf(id).settingsChanging, false);
  assert.equal(manager.stateOf(id).model, "sonnet");
  await manager.prompt(id, "komut");
  await wait(() => manager.stateOf(id).pendingApprovalCount === 1);
  await assert.rejects(manager.setModel(id, "default"), (e) => e.status === 409);
  const card = events(id).find((e) => e.kind === "approval");
  await manager.approve(id, card.requestId, "deny");
  await wait(turnDone(events, id));
});

test("claude: a rejected or lost model acknowledgment goes offline with a visible error", async (t) => {
  for (const flag of ["FIXTURE_REJECT_MODEL", "FIXTURE_DROP_MODEL_RESPONSE"]) {
    const { dir, manager, logged } = setup({ env: { [flag]: "1" } });
    t.after(() => cleanup(dir, manager));
    const { id } = await create(manager);
    const connection = manager.runtimes.get(id).conn;
    const originalControl = connection.control.bind(connection);
    connection.control = (request, options) => originalControl(request, request.subtype === "set_model" ? { timeoutMs: 40 } : options);
    await assert.rejects(manager.setModel(id, "sonnet"), (error) => error.status === 503 && /Model değiştirilemedi/.test(error.message));
    assert.equal(manager.stateOf(id).status, "offline");
    assert.match(manager.stateOf(id).lastError, /Model değiştirilemedi/);
    assert.equal(manager.stateOf(id).settingsChanging, false);
    assert.equal(await manager.ensureConnected(id), true);
    assert.equal(manager.stateOf(id).model, "default");
    assert.equal(manager.stateOf(id).lastError, null);
    assert.ok(!logged().some((entry) => entry.in?.type === "user"));
  }
});

test("claude: stop and delete during mode acknowledgment cannot persist a new permission", async (t) => {
  const { dir, manager, wait, logged } = setup({ env: { FIXTURE_MODE_DELAY_MS: "100" } });
  t.after(() => cleanup(dir, manager));
  for (const action of ["stop", "delete"]) {
    const { id } = await create(manager);
    const previous = logged().filter((e) => e.in?.request?.mode === "bypassPermissions").length;
    const changing = assert.rejects(manager.setMode(id, "bypassPermissions"), (e) => e.status === 503 || e.status === 409 || e.status === 404);
    await wait(() => logged().filter((e) => e.in?.request?.mode === "bypassPermissions").length > previous);
    await manager[action](id);
    await changing;
    if (action === "stop") assert.equal(manager.get(id).claudePermissionMode, "default");
    else assert.throws(() => manager.get(id), (e) => e.status === 404);
    assert.ok(!manager.store.records.some((record) => record.id === id && record.claudePermissionMode === "bypassPermissions"));
  }
});

test("claude: a late successful acknowledgment cannot update a stopped session", async (t) => {
  const { dir, manager, events } = setup();
  t.after(() => cleanup(dir, manager));
  for (const setting of ["mode", "model"]) {
    const { id } = await create(manager);
    const connection = manager.runtimes.get(id).conn;
    const originalControl = connection.control.bind(connection);
    connection.control = async (request, options) => {
      const response = await originalControl(request, options);
      await manager.stop(id);
      return response;
    };
    await assert.rejects(setting === "mode" ? manager.setMode(id, "bypassPermissions") : manager.setModel(id, "sonnet"),
      (error) => error.status === 409);
    assert.equal(manager.get(id).claudePermissionMode, "default");
    assert.ok(!events(id).some((event) => event.kind === "mode"));
  }
});

test("claude: full access restores on resume and old records safely default", async (t) => {
  const first = setup();
  const { dir } = first;
  const used = await create(first.manager);
  const old = await create(first.manager);
  delete first.manager.store.get(old.id).claudePermissionMode;
  first.manager.store.save();
  await first.manager.setMode(used.id, "bypassPermissions");
  await first.manager.prompt(used.id, "merhaba");
  await first.wait(turnDone(first.events, used.id));
  await first.manager.shutdown();
  const second = setup({ dir, env: { FIXTURE_DEFAULT_MODE: "bypassPermissions" } });
  t.after(() => cleanup(dir, second.manager));
  assert.equal(second.manager.stateOf(used.id).modes.currentModeId, "bypassPermissions");
  assert.equal(await second.manager.ensureConnected(used.id), true);
  assert.equal(await second.manager.ensureConnected(old.id), true);
  assert.equal(second.manager.stateOf(used.id).modes.currentModeId, "bypassPermissions");
  assert.equal(second.manager.stateOf(old.id).modes.currentModeId, "default");
  const controls = second.logged().filter((e) => e.in?.request?.subtype === "set_permission_mode").map((e) => e.in.request.mode);
  assert.deepEqual(controls.slice(-2), ["bypassPermissions", "default"]);
  assert.ok(second.logged().some((e) => e.argv?.includes("--resume")));
});

test("claude: restart resumes a started chat and starts an unused one with its id", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-claude-resume-"));
  const first = setup({ dir });
  const used = await create(first.manager, "Kullanılan");
  const unused = await create(first.manager, "Boş");
  await first.manager.prompt(used.id, "merhaba");
  await first.wait(turnDone(first.events, used.id));
  await first.manager.shutdown();

  const second = setup({ dir });
  t.after(() => cleanup(dir, second.manager));
  assert.equal(second.manager.list().length, 2);
  assert.equal(await second.manager.ensureConnected(used.id), true);
  assert.equal(await second.manager.ensureConnected(unused.id), true);
  const argvs = second.logged().filter((e) => e.argv).map((e) => e.argv.slice(-2));
  assert.ok(argvs.some((a) => a[0] === "--resume" && a[1] === used.claudeSessionId));
  assert.ok(argvs.some((a) => a[0] === "--session-id" && a[1] === unused.claudeSessionId));
  assert.ok(second.events(used.id).some((e) => e.kind === "status" && e.status === "resumed"));
});

test("claude: a transcript Claude no longer has reopens fresh, visibly", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const created = await create(manager);
  await manager.prompt(created.id, "merhaba");
  await wait(turnDone(events, created.id));
  await manager.shutdown();
  fs.writeFileSync(path.join(dir, "fixture-state.json"), "[]");
  assert.equal(await manager.ensureConnected(created.id), true);
  const record = manager.get(created.id);
  assert.notEqual(record.claudeSessionId, created.claudeSessionId);
  assert.equal(record.claudeStarted, false);
  assert.ok(events(created.id).some((e) => e.kind === "status" && e.status === "reopened"));
});

test("claude: an unexpected exit goes offline and the next prompt reconnects", async (t) => {
  const { dir, manager, wait, events } = setup();
  t.after(() => cleanup(dir, manager));
  const { id } = await create(manager);
  await manager.prompt(id, "merhaba");
  await wait(turnDone(events, id));
  await manager.prompt(id, "olum");
  await wait(() => manager.stateOf(id).status === "offline");
  assert.ok(events(id).some((e) => e.kind === "status" && e.status === "offline"));
  assert.ok(events(id).some((e) => e.kind === "error"));
  await manager.prompt(id, "selam");
  await wait(turnDone(events, id, 2));
  assert.match(events(id).filter((e) => e.kind === "assistant").at(-1).text, /Yankı: selam/);
});

test("claude: validation, stop/delete and tier isolation in a shared store", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-claude-shared-"));
  const store = new StructuredStore({ stateDir: dir });
  const { manager } = setup({ dir, store });
  const projects = [{ id: "agent-panel", name: "Panel", path: dir }];
  const hermes = new StructuredManager({ root, stateDir: dir, agentCommand: null, projects, env: {}, store });
  const codex = new CodexManager({ root, stateDir: dir, agentCommand: null, projects, env: {}, store });
  t.after(() => cleanup(dir, manager, hermes, codex));
  await assert.rejects(
    manager.create({ projectId: "agent-panel", agentId: "codex", title: "", requestId: requestId() }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    manager.create({ projectId: "yok", agentId: "claude", title: "", requestId: requestId() }),
    (e) => e.status === 400,
  );
  const key = requestId();
  const a = await manager.create({ projectId: "agent-panel", agentId: "claude", title: "", requestId: key });
  const again = await manager.create({ projectId: "agent-panel", agentId: "claude", title: "", requestId: key });
  assert.equal(again.id, a.id, "idempotent create");
  assert.equal(a.title, "Claude · Panel");
  await assert.rejects(manager.prompt(a.id, ""), (e) => e.status === 400);
  await assert.rejects(manager.prompt(a.id, "a\x01b"), (e) => e.status === 400);
  assert.deepEqual(hermes.list(), []);
  assert.deepEqual(codex.list(), []);
  assert.throws(() => hermes.get(a.id), (e) => e.status === 404);
  assert.throws(() => codex.get(a.id), (e) => e.status === 404);
  const stopped = await manager.stop(a.id);
  assert.equal(stopped.status, "ended");
  await assert.rejects(manager.prompt(a.id, "x"), (e) => e.status === 409);
  await manager.delete(a.id);
  assert.throws(() => manager.get(a.id), (e) => e.status === 404);
  const unavailable = new ClaudeManager({ root, stateDir: dir, agentCommand: null, projects, env: {}, store });
  await assert.rejects(
    unavailable.create({ projectId: "agent-panel", agentId: "claude", title: "", requestId: requestId() }),
    (e) => e.status === 503,
  );
});
