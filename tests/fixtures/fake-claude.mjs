#!/usr/bin/env node
// Deterministic stand-in for headless Claude Code (`--input-format stream-json
// --output-format stream-json --permission-prompt-tool stdio`). No model, no
// network: the first word of each user message picks a scripted turn. Every
// inbound line and the argv are logged to FIXTURE_LOG for assertions; the
// sessions that ran a turn are remembered in FIXTURE_STATE so `--resume` and
// `--session-id` behave like the real CLI.
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FIXTURE_LOG)
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + "\n");
};
const statePath = process.env.FIXTURE_STATE;
const persisted = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return [];
  }
};
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
log({ argv, env: { CLAUDECODE: process.env.CLAUDECODE ?? null } });

for (const required of ["--input-format", "--output-format", "--permission-prompt-tool"])
  if (!argv.includes(required)) {
    process.stderr.write(`missing ${required}\n`);
    process.exit(2);
  }
if (argv.includes("--dangerously-skip-permissions")) process.exit(2);

const resumeId = flag("--resume");
let sessionId = resumeId || flag("--session-id");
if (resumeId && !persisted().includes(resumeId)) {
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}
if (!resumeId && persisted().includes(sessionId)) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}

const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let serial = 0;
const waiting = new Map();
let interruptTurn = null;
let mode = process.env.FIXTURE_DEFAULT_MODE || "default";
let permissionChanges = 0;
let model = "fixture-claude-default";

function ask(request) {
  const requestId = `cli-${++serial}`;
  out({ type: "control_request", request_id: requestId, request });
  return { requestId, answer: new Promise((resolve) => waiting.set(requestId, resolve)) };
}

function init() {
  log({ activeMode: mode });
  const list = persisted();
  if (!list.includes(sessionId)) {
    list.push(sessionId);
    if (statePath) fs.writeFileSync(statePath, JSON.stringify(list));
  }
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    permissionMode: process.env.FIXTURE_STALE_INIT_MODE || mode,
    tools: ["Bash", "Edit", "Read", "TodoWrite"],
    cwd: process.cwd(),
  });
}

function result(subtype = "success", extra = {}) {
  out({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    session_id: sessionId,
    result: "",
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { [model]: { contextWindow: 200000 } },
    ...extra,
  });
}

function assistant(id, content, usage = null) {
  out({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: {
      id,
      role: "assistant",
      content,
      ...(usage ? { usage } : {}),
    },
  });
}

function toolResult(toolUseId, content, isError = false) {
  out({
    type: "user",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

async function turn(text) {
  const word = text.trim().split(/\s+/)[0];
  init();
  switch (word) {
    case "merhaba": {
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1" } } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Düşünüyorum" } } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Merhaba, " } } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "kullanıcı." } } });
      assistant(
        "msg_1",
        [
          { type: "thinking", thinking: "Düşünüyorum" },
          { type: "text", text: "Merhaba, kullanıcı." },
        ],
        { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 40 },
      );
      // Subagent traffic must not reach the main transcript.
      out({ type: "assistant", parent_tool_use_id: "toolu_sub", message: { id: "msg_sub", content: [{ type: "text", text: "ALT AJAN" }] } });
      return result();
    }
    case "komut": {
      assistant("msg_2", [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls -la", description: "Dosyaları listele" } }]);
      const { answer } = mode === "bypassPermissions" ? { answer: Promise.resolve({ behavior: "allow" }) } : ask({
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la", description: "Dosyaları listele" },
        tool_use_id: "toolu_bash",
        permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" }],
      });
      const decision = await answer;
      if (decision.behavior === "allow") {
        toolResult("toolu_bash", [{ type: "text", text: "a.txt\nb.txt" }]);
        assistant("msg_3", [{ type: "text", text: "İki dosya var." }]);
        return result();
      }
      toolResult("toolu_bash", decision.message || "denied", true);
      if (decision.interrupt) return result("error_during_execution", { is_error: false });
      assistant("msg_3", [{ type: "text", text: "Komut reddedildi." }]);
      return result();
    }
    case "duzenle": {
      assistant("msg_4", [
        { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "/tmp/x.txt", old_string: "eski", new_string: "yeni" } },
      ]);
      toolResult("toolu_edit", "The file /tmp/x.txt has been updated.");
      return result();
    }
    case "plan": {
      assistant("msg_5", [
        { type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: { todos: [{ content: "Birinci", status: "completed" }, { content: "İkinci", status: "in_progress" }] } },
      ]);
      toolResult("toolu_todo", "ok");
      return result();
    }
    case "sorular":
    case "serbest":
    case "gizlisoru":
    case "bozuksoru":
    case "soruiptal": {
      const questions = word === "sorular" ? [
        { header: "Tercih", question: "Hangi tema?", options: [{ label: "Açık", description: "Aydınlık" }, { label: "Koyu" }] },
        { header: "Özellik", question: "Hangi özellikler?", multiSelect: true, options: [{ label: "Günlük" }, { label: "Test" }] },
        { header: "Not", question: "Eklemek istediğin ne?", options: [] },
      ] : word === "bozuksoru" ? Array.from({ length: 4 }, () => ({ question: "Tekrar?", options: [] }))
        : [{ header: "Yanıt", question: "Yanıtın nedir?", options: [], ...(word === "gizlisoru" ? { isSecret: true } : {}) }];
      assistant("msg_question", [{ type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions } }]);
      const { requestId, answer } = ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_question", input: { questions } });
      if (word === "soruiptal") {
        setTimeout(() => {
          out({ type: "control_cancel_request", request_id: requestId });
          waiting.delete(requestId);
          result();
        }, 100);
        return;
      }
      const decision = await answer;
      log({ answered: decision });
      toolResult("toolu_question", JSON.stringify(decision.updatedInput?.answers || decision.message || "Yanıt yok"), decision.behavior !== "allow");
      assistant("msg_question_done", [{ type: "text", text: decision.behavior === "allow" ? "Yanıt alındı." : "Soru yanıtlanmadı." }]);
      return result();
    }
    case "soru": {
      const { answer } = ask({
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Hangisi?", header: "Seçim", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] },
      });
      const decision = await answer;
      log({ answered: decision });
      assistant("msg_6", [{ type: "text", text: `Seçim: ${decision.updatedInput?.answers?.["Hangisi?"] ?? "yok"}` }]);
      return result();
    }
    case "vazgec": {
      const { requestId } = ask({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "sleep 1" } });
      setTimeout(() => {
        out({ type: "control_cancel_request", request_id: requestId });
        waiting.delete(requestId);
        result();
      }, 100);
      return;
    }
    case "yavas": {
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_7" } } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Uzun iş…" } } });
      await new Promise((resolve) => (interruptTurn = resolve));
      return result("error_during_execution", { is_error: true });
    }
    case "olum":
      process.exit(3);
    default:
      assistant("msg_x", [{ type: "text", text: `Yankı: ${text}` }]);
      return result();
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log({ in: message });
  if (message.type === "control_response") {
    const resolve = waiting.get(message.response?.request_id);
    waiting.delete(message.response?.request_id);
    resolve?.(message.response?.response ?? {});
    return;
  }
  if (message.type === "control_request") {
    const request = message.request ?? {};
    const reply = (response) =>
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    if (request.subtype === "initialize")
      return reply({
        commands: [],
        models: [
          { value: "default", displayName: "Default (fixture)", description: "Varsayılan" },
          { value: "sonnet", displayName: "Sonnet (fixture)", description: "Hızlı" },
        ],
      });
    if (request.subtype === "interrupt") {
      reply({});
      interruptTurn?.();
      interruptTurn = null;
      return;
    }
    if (request.subtype === "set_model") {
      if (process.env.FIXTURE_REJECT_MODEL)
        return out({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "fixture model rejected" } });
      model = request.model ?? "fixture-claude-default";
      if (process.env.FIXTURE_DROP_MODEL_RESPONSE) return;
      if (process.env.FIXTURE_MODEL_DELAY_MS)
        return setTimeout(() => reply({}), Number(process.env.FIXTURE_MODEL_DELAY_MS));
      return reply({});
    }
    if (request.subtype === "set_permission_mode") {
      permissionChanges++;
      if ((request.mode === process.env.FIXTURE_REJECT_MODE && permissionChanges > Number(process.env.FIXTURE_REJECT_MODE_AFTER || 0)) ||
          (request.mode === "bypassPermissions" && !argv.includes("--allow-dangerously-skip-permissions")))
        return out({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "permission mode disabled by policy" } });
      mode = request.mode;
      if (process.env.FIXTURE_MODE_DELAY_MS)
        return setTimeout(() => reply({}), Number(process.env.FIXTURE_MODE_DELAY_MS));
      return reply({});
    }
    return out({
      type: "control_response",
      response: { subtype: "error", request_id: message.request_id, error: "unsupported" },
    });
  }
  if (message.type === "user") {
    const content = message.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : String(content ?? "");
    turn(text);
  }
});
rl.on("close", () => process.exit(0));
