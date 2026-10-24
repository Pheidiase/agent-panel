// Deterministic `codex app-server` fixture for unit tests and acceptance.
// Newline-delimited JSON-RPC on stdin/stdout, scripted per prompt text; it
// never calls a model and never touches the network. FIXTURE_LOG records the
// methods it receives (and approval decisions) so tests can assert.
// FIXTURE_RESUME: "ok" (any thread resumes) | "missing" (resume fails with
// "thread not found", the panel then starts a fresh thread visibly).
import fs from "node:fs";
import readline from "node:readline";

const logFile = process.env.FIXTURE_LOG || null;
function log(line) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}
const resumeMode = process.env.FIXTURE_RESUME || "ok";

let serverReqSeq = 1;
const pendingServer = new Map();
const threads = new Map();
let threadSeq = 0;
let turnSeq = 0;
let initialized = false, initializeReceived = false;
const turns = new Map();

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const respond = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serverRequest(method, params) {
  const id = `srv-${serverReqSeq++}`;
  return new Promise((resolve) => {
    pendingServer.set(id, resolve);
    send({ id, method, params });
  });
}

function threadObj(t) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: t.id,
    sessionId: t.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "paginated",
    modelProvider: "fixture",
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    status: { type: "idle" },
    cwd: t.cwd,
    path: `/tmp/fixture/rollout-${t.id}.jsonl`,
    name: null,
  };
}

const threadResult = (t) => ({
  thread: threadObj(t),
  model: t.model,
  modelProvider: "fixture",
  approvalPolicy: t.approvalPolicy ?? "on-request",
  approvalsReviewer: "user",
  cwd: t.cwd,
  sandbox: { type: t.sandbox === "danger-full-access" ? "dangerFullAccess" : t.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
  reasoningEffort: t.reasoningEffort ?? "medium",
  instructionSources: [],
  disabledPluginIds: [],
});

const itemId = (label) => `item-${label}-${turnSeq}`;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  handleLine(line).catch((error) => log("ERROR " + String((error && error.message) || error)));
});
rl.on("close", () => process.exit(0));

async function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Responses to our server-initiated requests (approvals / user input).
  if (msg.id !== undefined && typeof msg.method !== "string") {
    const resolve = pendingServer.get(msg.id);
    if (resolve) {
      pendingServer.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  const { id, method, params = {} } = msg;
  log(method);
  log(`params ${method} ${JSON.stringify(params)}`);
  if (method === "initialized") {
    if (initializeReceived && id === undefined) initialized = true;
    return;
  }
  if (method !== "initialize" && !initialized) {
    fail(id, -32000, "Not initialized");
    return;
  }
  switch (method) {
    case "initialize":
      if (initializeReceived) { fail(id, -32000, "Already initialized"); return; }
      initializeReceived = true;
      respond(id, {
        userAgent: "fake-codex-app-server/0.0.1",
        codexHome: "/tmp/fixture-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            id: "fixture-model-a",
            displayName: "Fixture A",
            description: "Deterministic fixture model",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Dengeli" }, { reasoningEffort: "high", description: "Derin" }],
          },
          {
            id: "fixture-model-b",
            displayName: "Fixture B",
            description: "Second fixture model",
            hidden: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Hızlı" }, { reasoningEffort: "high", description: "Derin" }],
          },
        ],
      });
      return;
    case "thread/start": {
      const t = { id: `th-${++threadSeq}`, cwd: params.cwd ?? null, model: params.model ?? "fixture-model-a", sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, reasoningEffort: params.config?.model_reasoning_effort };
      threads.set(t.id, t);
      respond(id, threadResult(t));
      notify("thread/started", { thread: threadObj(t) });
      return;
    }
    case "thread/resume": {
      if (params.excludeTurns !== true) { fail(id, -32602, "excludeTurns required"); return; }
      if (process.env.FIXTURE_RESUME_DELAY_MS) await sleep(Number(process.env.FIXTURE_RESUME_DELAY_MS));
      if (process.env.FIXTURE_REJECT_FULL === "1" && params.sandbox === "danger-full-access") {
        fail(id, -32000, "fixture policy refuses full access");
        return;
      }
      if (resumeMode === "ok") {
        const t = threads.get(params.threadId) ?? {
          id: params.threadId,
          cwd: params.cwd ?? null,
          model: "fixture-model-a",
        };
        t.model = params.model ?? t.model;
        t.sandbox = params.sandbox ?? t.sandbox;
        t.approvalPolicy = params.approvalPolicy ?? t.approvalPolicy;
        t.reasoningEffort = params.config?.model_reasoning_effort ?? t.reasoningEffort;
        if (process.env.FIXTURE_COERCE_FULL === "1" && params.sandbox === "danger-full-access") {
          t.sandbox = "workspace-write";
          t.approvalPolicy = "on-request";
        }
        if (process.env.FIXTURE_COERCE_MODEL === "1" && params.model === "fixture-model-b") t.model = "fixture-model-a";
        if (process.env.FIXTURE_COERCE_READONLY_FULL === "1" && params.sandbox === "read-only") {
          t.sandbox = "danger-full-access";
          t.approvalPolicy = "never";
        }
        threads.set(t.id, t);
        respond(id, threadResult(t));
      } else {
        fail(id, -32000, `thread not found: ${params.threadId}`);
      }
      return;
    }
    case "thread/read": {
      const t = threads.get(params.threadId);
      if (t) respond(id, { thread: threadObj(t) });
      else fail(id, -32000, "not found");
      return;
    }
    case "turn/start":
      return runTurn(id, params);
    case "turn/interrupt": {
      const t = turns.get(params.turnId);
      if (t) {
        t.cancelled = true;
        log(`interrupt ${params.turnId}`);
      }
      respond(id, {});
      return;
    }
    default:
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }
}

async function runTurn(reqId, params) {
  const threadId = params.threadId;
  const thread = threads.get(threadId) ?? { id: threadId, cwd: null, model: "fixture-model-a" };
  const prompt = (Array.isArray(params.input) ? params.input : [])
    .map((part) => part?.text ?? "")
    .join(" ");
  const turnId = `turn-${++turnSeq}`;
  const turn = { id: turnId, status: "inProgress", items: [], startedAt: Date.now() };
  turns.set(turnId, { threadId, prompt, cancelled: false });
  log(`turn ${prompt}`);
  respond(reqId, { turn });
  notify("turn/started", { threadId, turn });

  const cancelled = () => turns.get(turnId)?.cancelled === true;
  const finish = (status = "completed") => {
    notify("turn/completed", {
      threadId,
      turn: { ...turn, status, completedAt: Date.now(), durationMs: 5 },
    });
    turns.delete(turnId);
  };
  const say = async (text) => {
    const id = itemId("msg");
    notify("item/started", {
      threadId,
      turnId,
      item: { id, type: "agentMessage", text: "" },
      startedAtMs: Date.now(),
    });
    for (const chunk of text.match(/.{1,12}/gs) ?? [text]) {
      if (cancelled()) return false;
      await sleep(5);
      notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: chunk });
    }
    notify("item/completed", { threadId, turnId, item: { id, type: "agentMessage", text } });
    return true;
  };
  const usage = (used = 42) =>
    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: used,
          inputTokens: used - 2,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        total: {
          totalTokens: used,
          inputTokens: used - 2,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        modelContextWindow: 200000,
      },
    });

  if (prompt.includes("yavaş")) {
    const id = itemId("msg");
    notify("item/started", {
      threadId,
      turnId,
      item: { id, type: "agentMessage", text: "" },
      startedAtMs: Date.now(),
    });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: "uzun iş başladı…" });
    const started = Date.now();
    while (!cancelled() && Date.now() - started < 20000) await sleep(50);
    if (cancelled()) return finish("interrupted");
    notify("item/completed", {
      threadId,
      turnId,
      item: { id, type: "agentMessage", text: "uzun iş bitti" },
    });
    return finish();
  }
  if (prompt.includes("komut")) {
    const id = itemId("cmd");
    const item = {
      id,
      type: "commandExecution",
      command: "touch fixture-output.txt",
      cwd: thread.cwd,
      status: "inProgress",
      commandActions: [],
    };
    notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
    await sleep(10);
    const reply = await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: id,
      command: "touch fixture-output.txt",
      cwd: thread.cwd,
      reason: "Fixture komutu çalıştırmak istiyor",
      startedAtMs: Date.now(),
    });
    const decision = reply?.result?.decision ?? "decline";
    log(`decision ${decision}`);
    const accepted = decision === "accept" || decision === "acceptForSession";
    notify("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: id,
      delta: accepted ? "çalıştırıldı\n" : "atlandı\n",
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        ...item,
        status: accepted ? "completed" : "declined",
        exitCode: accepted ? 0 : null,
        aggregatedOutput: accepted ? "çalıştırıldı\n" : "atlandı\n",
      },
    });
    await say(accepted ? "komut onaylandı" : "komut reddedildi");
    usage();
    return finish();
  }
  if (prompt.includes("dosya")) {
    const id = itemId("file");
    const diff = [
      "@@ -1,3 +1,3 @@",
      "-eski satır bir",
      "+yeni satır bir",
      " bağlam satırı",
      "-eski satır iki",
      "+yeni satır iki",
    ].join("\n");
    const changes = [{ path: "src/fixture.txt", kind: { type: "update" }, diff }];
    notify("item/started", {
      threadId,
      turnId,
      item: { id, type: "fileChange", status: "inProgress", changes },
      startedAtMs: Date.now(),
    });
    await sleep(10);
    notify("item/completed", {
      threadId,
      turnId,
      item: { id, type: "fileChange", status: "completed", changes },
    });
    await say("dosya güncellendi");
    return finish();
  }
  if (prompt.includes("özel kimlik")) {
    const reply = await serverRequest("item/tool/requestUserInput", {
      threadId, turnId, itemId: itemId("special-ids"), isBlocking: true,
      questions: [
        { id: "constructor", header: "Seçim", question: "Güvenli seçeneği seç", options: [{ label: "A" }, { label: "B" }], isOther: false },
        { id: "toString", header: "Serbest", question: "Serbest metni yaz", options: [] },
        { id: "__proto__", header: "Gizli", question: "Gizli metni yaz", options: [], isSecret: true },
      ],
    });
    const answers = reply?.result?.answers;
    const exact = Object.hasOwn(answers ?? {}, "constructor") && Object.hasOwn(answers ?? {}, "toString") && Object.hasOwn(answers ?? {}, "__proto__")
      && answers.constructor?.answers?.[0] === "A" && answers.toString?.answers?.[0] === " serbest " && answers.__proto__?.answers?.[0] === " secret ";
    // Assert exact protocol values without echoing or logging form contents.
    await say(exact ? "özel kimlik yanıtları birebir korundu" : "özel kimlik yanıtları bozuldu");
    return finish();
  }
  if (prompt.includes("form soruları")) {
    const reply = await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: itemId("form"),
      isBlocking: true,
      questions: [
        { id: "q1", header: "Serbest", question: "Özel yanıtını yaz", options: null, isSecret: true },
        { id: "q2", header: "Çoklu", question: "Seçenekleri işaretle", options: [{ label: "A", description: "İlk" }, { label: "B" }, { label: "C" }], multiSelect: true },
        { id: "q3", header: "Diğer", question: "Bir seçenek seç veya yaz", options: [{ label: "Bir" }, { label: "İki" }], isOther: true },
      ],
    });
    const answers = reply?.result?.answers;
    const empty = answers && ["q1", "q2", "q3"].every((key) => Array.isArray(answers[key]?.answers) && answers[key].answers.length === 0);
    log(empty ? "form rejected" : "form answered");
    await say(empty ? "form reddedildi" : "form yanıtları alındı");
    return finish();
  }
  if (prompt.includes("soru")) {
    const id = itemId("ask");
    const reply = await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: id,
      isBlocking: true,
      questions: [
        {
          id: "q1",
          header: "Seçim",
          question: "Hangi seçenek?",
          options: [{ label: "Seçenek A" }, { label: "Seçenek B" }],
          isOther: false,
          isSecret: false,
        },
      ],
    });
    const answer = reply?.result?.answers?.q1?.answers?.[0] ?? "(boş)";
    await say(`seçim: ${answer}`);
    return finish();
  }
  if (prompt.includes("plan")) {
    notify("turn/plan/updated", {
      threadId,
      turnId,
      plan: [
        { step: "Adım bir", status: "completed" },
        { step: "Adım iki", status: "inProgress" },
      ],
    });
    await say("plan güncellendi");
    return finish();
  }
  if (prompt.includes("sohbet")) {
    const thinkId = itemId("think");
    notify("item/started", {
      threadId,
      turnId,
      item: { id: thinkId, type: "reasoning" },
      startedAtMs: Date.now(),
    });
    notify("item/reasoning/textDelta", {
      threadId,
      turnId,
      itemId: thinkId,
      delta: "düşünüyorum…",
    });
    await sleep(5);
    const sent = await say("Merhaba fixture dünya");
    if (!sent) return finish("interrupted");
    usage(42);
    return finish();
  }
  const sent = await say(`fixture yanıtı: ${prompt || "(boş)"}`);
  if (!sent) return finish("interrupted");
  usage();
  return finish();
}
