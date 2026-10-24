import { clientModules } from "./fixtures/client-modules.mjs";
// No provider calls, network, or live state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
const read = file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
function compile(source) {
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  const i18n = clientModules()("i18n.ts"); i18n.setLanguage("tr");
  new Function("require", "exports", "getLocale", "t", js)(name => name === "./i18n" ? i18n : require(name), exports, i18n.getLocale, i18n.t);
  return exports;
}

test("#1 advanced options retain agent, kind, project and first message across cancel and submit", async () => {
  const main = read("main.tsx");
  const open = main.slice(main.indexOf("  function openStartOptions("), main.indexOf("  function pickStart("));
  const create = main.slice(main.indexOf("  function closeModal("), main.indexOf('  // Başlangıç kutusu:'));
  const { scenario } = compile(read("input-state.ts") + `
    export function scenario() {
      let creating = false, startText = "  işi incele\\nsonra açıkla  ", modal = false;
      const startAgent = { id: "claude" }, startKind = "structured", startProject = "agent-panel";
      const startPending = { current: "" }, values = {};
      const setNewAgent = x => values.agentId = x, setNewKind = x => values.kind = x,
        setNewProject = x => values.projectId = x, setTitle = x => values.title = x,
        setParallel = x => values.allowParallel = x, setError = () => {}, setModal = x => modal = x,
        setStartText = fn => startText = fn(startText);
      const createSession = async opts => { values.submitted = opts; return true; };
      const { agentId: newAgent, kind: newKind, projectId: newProject, title, allowParallel: parallel } =
        { agentId: "claude", kind: "structured", projectId: "agent-panel", title: "işi incele", allowParallel: false };
      ${open} ${create}
      return { open: openStartOptions, close: closeModal, create: () => create({ preventDefault() {} }),
        state: () => ({ ...values, startText, modal, pending: startPending.current }),
        type: x => startText = x, busy: () => creating = true };
    }
  `);
  const host = scenario();
  host.open();
  assert.deepEqual(host.state(), { agentId: "claude", kind: "structured", projectId: "agent-panel", title: "işi incele", allowParallel: false,
    startText: "  işi incele\nsonra açıkla  ", pending: "  işi incele\nsonra açıkla  ", modal: true });
  host.close();
  assert.equal(host.state().startText, "  işi incele\nsonra açıkla  ");
  assert.equal(host.state().pending, "");
  host.open();
  host.type("beklerken yeni taslak");
  await host.create();
  assert.equal(host.state().submitted.firstMessage, "  işi incele\nsonra açıkla  ");
  assert.equal(host.state().startText, "beklerken yeni taslak");
  host.close(); host.busy(); host.open();
  assert.equal(host.state().modal, false);
});

const chat = read("StructuredView.tsx");
test("#15 insertion reports only the chosen whole group and preserves an overflowing draft", () => {
  const handler = chat.slice(chat.indexOf("  function insertComments("), chat.indexOf('  // "@" mention picker:'));
  const { scenario } = compile(read("changes.ts") + `
    export function scenario(initial) {
      let draft = initial, note = "";
      const setDraft = value => draft = value, setChangesNote = value => note = value;
      const setTimeout = () => 0;
      ${handler}
      return { insert: insertComments, state: () => ({ draft, note }) };
    }
  `);
  const comments = Array.from({ length: 5 }, (_, i) => ({ id: String(i), path: "a.ts", line: i + 1, side: "new", snippet: "line", text: `${i}:` + "ö".repeat(1600) }));
  const { commentBatches } = compile(read("changes.ts"));
  const batches = commentBatches(comments);
  assert.deepEqual(batches.map(batch => batch.length), [2, 2, 1]);
  assert.deepEqual(batches.flat(), comments);
  const host = scenario("");
  host.insert(batches[0]);
  assert.deepEqual(host.state().note, { key: "chat.commentsAdded", params: { count: 2 } });
  assert.equal(i18n.messageText(host.state().note), "2 yorum mesaja eksiksiz eklendi.");
  assert.ok(host.state().draft.includes(comments[1].text));
  assert.ok(!host.state().draft.includes(comments[2].text));
  const full = scenario("x".repeat(7990));
  full.insert(batches[0]);
  assert.equal(full.state().draft.length, 7990);
  assert.match(i18n.messageText(full.state().note), /sığmıyor/);
  assert.doesNotMatch(i18n.messageText(full.state().note), /eklendi/);
});

const { foldApprovals, approvalTimeline, approvalDecision, ApprovalResult } = compile(
  chat.slice(chat.indexOf("function foldApprovals("), chat.indexOf("function ApprovalCard(")) +
  "\nexport { foldApprovals, approvalTimeline, approvalDecision, ApprovalResult };");

test("#10 decision history keeps scope, command and time beside the matching turn's tool", () => {
  const requested = { seq: 3, t: "2026-10-23T12:00:00Z", kind: "approval", requestId: "r", status: "requested",
    toolCall: { toolCallId: "reused", rawInput: { command: "git diff" } }, options: [
      { optionId: "yes", kind: "allow_once" }, { optionId: "session", kind: "allow_always" }, { optionId: "no", kind: "reject_once" },
    ] };
  const before = foldApprovals([requested]);
  for (const [optionId, expected] of [["yes", "Bir kez izin verildi"], ["session", "Bu oturum için izin verildi"], ["no", "Reddedildi"]]) {
    const decision = { seq: 4, t: "2026-10-23T12:00:05Z", kind: "approval", requestId: "r", status: "decided", optionId };
    const after = foldApprovals([decision], false, before);
    assert.equal(approvalDecision(after[0]), expected);
    assert.deepEqual(after, foldApprovals([requested, decision]));
    const html = renderToStaticMarkup(React.createElement(ApprovalResult, { approval: after[0], onRetry: assert.fail }));
    assert.ok(html.includes(expected)); assert.ok(html.includes("git diff"));
    assert.match(html, /dateTime="2026-10-23T12:00:05Z"/);
    const items = [{ key: 1, type: "user" }, { key: 2, type: "tool", tool: { id: "reused" } },
      { key: 5, type: "assistant" }, { key: 6, type: "user" }, { key: 7, type: "tool", tool: { id: "reused" } }];
    assert.deepEqual(approvalTimeline(items, after).map(row => row.item?.key ?? row.approval.requestId), [1, 2, "r", 5, 6, 7]);
    assert.equal(approvalTimeline(items.filter(item => item.type !== "tool"), after)[1].approval.requestId, "r");
  }
  const expired = foldApprovals([], true, before)[0];
  assert.equal(approvalDecision(expired), "Süresi doldu");
  const html = renderToStaticMarkup(React.createElement(ApprovalResult, { approval: expired, onRetry: assert.fail }));
  assert.match(html, /mesaj hazırla/);
  const secret = { ...expired, status: "decided", optionId: "private choice", questions: [{ isSecret: true }],
    toolCall: { title: "private prompt" }, options: [{ optionId: "private choice", name: "private choice" }] };
  const secretHtml = renderToStaticMarkup(React.createElement(ApprovalResult, { approval: secret, onRetry: assert.fail }));
  assert.match(secretHtml, /Soru yanıtlandı/); assert.doesNotMatch(secretHtml, /private/);
  assert.equal(before[0].status, "requested");
});
