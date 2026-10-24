#!/usr/bin/env node
// Deterministic ACP fixture agent for the panel's structured-session tests.
// Newline-delimited JSON-RPC on stdio; canned streams only — it never calls a
// model, sends a message, or touches any network. Behaviour is chosen by the
// prompt text: "two-chunks", "needs-approval", "slow", "with-plan",
// "/version"; anything else echoes.
import crypto from "node:crypto";
import fs from "node:fs";

const logPath = process.env.FIXTURE_LOG || null;
function log(line) {
  try {
    if (logPath) fs.appendFileSync(logPath, line + "\n");
  } catch {}
}

let nextId = 0;
let sessionSerial = 0;
const pendingPrompts = new Map(); // sessionId -> resolve(stopReason)
let permissionWaiter = null; // { id, resolve } for the fixture-initiated request

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function update(sessionId, payload) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

function requestPermission(sessionId, toolCall, options) {
  const id = ++nextId;
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId, toolCall, options },
  });
  return new Promise((resolve) => {
    permissionWaiter = { id, resolve };
    setTimeout(() => {
      if (permissionWaiter && permissionWaiter.id === id) {
        permissionWaiter = null;
        resolve(null);
      }
    }, 15000).unref();
  });
}

const MODEL_STATE = {
  currentModelId: "fixture-model-a",
  availableModels: [
    { modelId: "fixture-model-a", name: "Fixture A" },
    { modelId: "fixture-model-b", name: "Fixture B" },
  ],
};
const MODE_STATE = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Ask before edits." },
    { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace edits." },
  ],
};
const CANNED_TOOL_CALL = {
  toolCallId: "fixture-tool-1",
  title: "Clean build dir: rm -rf build",
  kind: "execute",
  status: "pending",
  content: [{ type: "content", content: { type: "text", text: "Clean build dir\n$ rm -rf build" } }],
  rawInput: { command: "rm -rf build", description: "Clean build dir" },
};
const CANNED_OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
  { optionId: "deny", kind: "reject_once", name: "Deny" },
];

async function runPrompt(sessionId, text) {
  const messageId = crypto.randomUUID();
  if (text.includes("slow")) {
    return new Promise((resolve) => {
      pendingPrompts.set(sessionId, resolve);
    });
  }
  if (text.includes("two-chunks")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "Hello " },
    });
    await new Promise((r) => setTimeout(r, 15));
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      messageId: crypto.randomUUID(),
      content: { type: "text", text: "fixture thinking" },
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "world" },
    });
    update(sessionId, { sessionUpdate: "usage_update", size: 1000, used: 77 });
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  }
  if (text.includes("needs-approval")) {
    update(sessionId, { sessionUpdate: "tool_call", ...CANNED_TOOL_CALL });
    const response = await requestPermission(sessionId, CANNED_TOOL_CALL, CANNED_OPTIONS);
    const decision = response?.outcome ?? null; // {outcome:"selected", optionId} | {outcome:"cancelled"}
    const allowed =
      decision?.outcome === "selected" &&
      String(decision.optionId || "").startsWith("allow");
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: CANNED_TOOL_CALL.toolCallId,
      status: allowed ? "completed" : "failed",
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: crypto.randomUUID(),
      content: { type: "text", text: allowed ? "Approved and done." : "Denied." },
    });
    return { stopReason: "end_turn" };
  }
  if (text.includes("with-plan")) {
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Adım bir", priority: "medium", status: "completed" },
        { content: "Adım iki", priority: "medium", status: "in_progress" },
      ],
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "Plan ready" },
    });
    return { stopReason: "end_turn" };
  }
  if (text.includes("with-diff")) {
    const oldText = "line one\nline two\nline three\nline four\nline five";
    const newText = "line one\nline two changed\nline three\nline four added\nline five\nline six";
    const diffs = [
      {
        type: "diff",
        path: "src/example.ts",
        oldText,
        newText,
      },
      {
        type: "diff",
        path: "docs/notlar.md",
        oldText: "eski satır",
        newText: "eski satır\nyeni satır",
      },
    ];
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "fixture-diff-1",
      title: "Edit src/example.ts",
      kind: "edit",
      status: "pending",
      content: diffs,
      locations: [{ path: "src/example.ts" }],
    });
    await new Promise((r) => setTimeout(r, 15));
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "fixture-diff-1",
      status: "completed",
      content: [
        ...diffs,
        { type: "content", content: { type: "text", text: "Updated src/example.ts" } },
      ],
    });
    update(sessionId, { sessionUpdate: "usage_update", size: 1000, used: 420 });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: crypto.randomUUID(),
      content: { type: "text", text: "Diff ready" },
    });
    return { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 } };
  }
  if (text.startsWith("/version")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hermes Agent vfixture" },
    });
    return { stopReason: "end_turn" };
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text: `Echo: ${text}` },
  });
  update(sessionId, { sessionUpdate: "usage_update", size: 1000, used: 10 });
  return { stopReason: "end_turn" };
}

function handle(message) {
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    if (permissionWaiter && permissionWaiter.id === message.id) {
      const waiter = permissionWaiter;
      permissionWaiter = null;
      waiter.resolve(message.result ?? null);
    }
    return;
  }
  if (typeof message.method !== "string") return;
  const { method, id, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false },
        sessionCapabilities: { fork: {}, list: {}, resume: {} },
      },
      agentInfo: { name: "fixture-agent", version: "0.0.1" },
      authMethods: [],
    });
    return;
  }
  if (method === "authenticate") {
    respond(id, {});
    return;
  }
  if (method === "session/new") {
    const sessionId = `fixture-${++sessionSerial}`;
    log(`new ${sessionId} cwd=${params?.cwd}`);
    respond(id, { sessionId, models: MODEL_STATE, modes: MODE_STATE });
    setImmediate(() => {
      update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "version", description: "Show Hermes version" }],
      });
      update(sessionId, { sessionUpdate: "usage_update", size: 1000, used: 5 });
    });
    return;
  }
  if (method === "session/load") {
    const sessionId = params?.sessionId;
    log(`load ${sessionId}`);
    if (String(sessionId).includes("missing")) {
      respond(id, null);
      return;
    }
    if (String(sessionId).endsWith("-gone") || String(sessionId).endsWith("-keep")) {
      // Simulates Hermes' `{}` answer for an id with no persisted record.
      respond(id, {});
      return;
    }
    // Spec order: replay the transcript before the response.
    update(sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "replay-user" },
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "00000000-0000-4000-8000-000000000001",
      content: { type: "text", text: "replay-assistant" },
    });
    respond(id, { models: MODEL_STATE, modes: MODE_STATE });
    setImmediate(() => {
      update(sessionId, { sessionUpdate: "usage_update", size: 1000, used: 42 });
    });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const text = (params?.prompt ?? []).map((block) => block.text || "").join("");
    log(`prompt ${sessionId} ${JSON.stringify(text)}`);
    runPrompt(sessionId, text).then((response) => respond(id, response));
    return;
  }
  if (method === "session/cancel") {
    const sessionId = params?.sessionId;
    log(`cancel ${sessionId}`);
    const pending = pendingPrompts.get(sessionId);
    if (pending) {
      pendingPrompts.delete(sessionId);
      pending({ stopReason: "cancelled" });
    }
    return;
  }
  if (method === "session/set_model" || method === "session/set_mode") {
    log(method);
    respond(id, {});
    return;
  }
  if (method === "session/list") {
    const known = (process.env.FIXTURE_LIST || "").split(",").filter(Boolean);
    respond(id, {
      sessions: known.map((sid) => ({
        sessionId: sid,
        cwd: params?.cwd ?? "",
        title: null,
        updatedAt: null,
      })),
    });
    return;
  }
  if (id !== undefined) respondError(id, -32601, "method not found");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
