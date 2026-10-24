// Exercise production manager wiring and the child start boundary; no real agents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadAgentBinaries } from "../server/config.mjs";
import { AcpConnection } from "../server/acp-client.mjs";
import { StructuredStore } from "../server/structured-store.mjs";
import { StructuredManager, resolveAcpCommand } from "../server/structured-manager.mjs";
import { CodexManager, resolveCodexCommand } from "../server/codex-manager.mjs";
import { ClaudeManager, ClaudeConnection, CLAUDE_STREAM_ARGS, resolveClaudeCommand } from "../server/claude-manager.mjs";
import { childProcessAvailable } from "./fixtures/local-auth-fixture.mjs";

const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const wiring = index.slice(index.indexOf("const structuredStore ="), index.indexOf("const chatManagers ="));
const specs = [
  { id: "hermes", variable: "PANEL_ACP_BINARY", args: ["acp"], fixture: "fake-acp-agent.mjs", Connection: AcpConnection },
  { id: "codex", variable: "PANEL_CODEX_BINARY", args: ["app-server"], fixture: "fake-codex-app-server.mjs", Connection: AcpConnection },
  { id: "claude", variable: "PANEL_CLAUDE_BINARY", args: CLAUDE_STREAM_ARGS, fixture: "fake-claude.mjs", Connection: ClaudeConnection },
];

function fixture(t, spec, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-chat-command-"));
  const bin = path.join(root, "bin with spaces"), project = path.join(root, "other-project"), state = path.join(root, "state");
  for (const dir of [bin, project, state]) fs.mkdirSync(dir);
  const binary = path.join(bin, spec.id), launch = path.join(root, "launch.json");
  const agent = new URL(`./fixtures/${spec.fixture}`, import.meta.url).pathname;
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from "node:fs";\nfs.writeFileSync(process.env.PORTABILITY_LAUNCH, JSON.stringify({ binary: process.argv[1], cwd: process.cwd(), args: process.argv.slice(2) }));\nawait import(${JSON.stringify(agent)});\n`, { mode: 0o700 });
  const relativeBin = path.relative(process.cwd(), bin);
  const env = { HOME: root, PATH: source === "PATH" ? relativeBin : "", PORTABILITY_LAUNCH: launch };
  if (source === "override") env[spec.variable] = `./${path.join(relativeBin, spec.id)}`;
  const binaryConfig = loadAgentBinaries({ stateDir: state, env });
  const managers = new Function("root", "state", "binaryConfig", "process", "projects", "StructuredStore", "StructuredManager", "CodexManager", "ClaudeManager", "resolveAcpCommand", "resolveCodexCommand", "resolveClaudeCommand",
    wiring + "; return [structured, codex, claude];")(
    root, state, binaryConfig, { env }, [{ id: "other", path: project }], StructuredStore, StructuredManager, CodexManager, ClaudeManager,
    opts => resolveAcpCommand({ ...opts, env }), opts => resolveCodexCommand({ ...opts, env }), opts => resolveClaudeCommand({ ...opts, env }));
  const manager = managers[specs.indexOf(spec)];
  t.after(async () => {
    try { for (const m of managers) await m.shutdown(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { manager, project, binary, binaryConfig, launch };
}

for (const spec of specs) for (const source of ["override", "PATH"]) {
  test(`${spec.id}: relative ${source} reaches chat child start as the same absolute terminal binary`, async t => {
    const f = fixture(t, spec, source);
    assert.equal(f.manager.available, true);
    assert.equal(f.binaryConfig[spec.id], f.binary);
    assert.deepEqual(f.manager.agentCommand, { command: f.binary, args: spec.args });
    let started;
    t.mock.method(spec.Connection.prototype, "start", function () {
      started = { command: this.command, args: this.args, cwd: this.cwd };
      throw new Error("portability start intercepted");
    });
    await assert.rejects(f.manager.create({ projectId: "other", agentId: spec.id, title: "Fixture", requestId: crypto.randomUUID() }), /portability start intercepted/);
    assert.equal(started.command, f.binary);
    assert.equal(started.cwd, f.project);
    assert.deepEqual(started.args.slice(0, spec.args.length), spec.args);
  });

  test(`${spec.id}: relative ${source} creates a fixture chat from a different project cwd`, async t => {
    if (!childProcessAvailable(t)) return;
    const f = fixture(t, spec, source);
    const chat = await f.manager.create({ projectId: "other", agentId: spec.id, title: "Fixture", requestId: crypto.randomUUID() });
    assert.equal(chat.agentId, spec.id);
    const launch = JSON.parse(fs.readFileSync(f.launch, "utf8"));
    assert.equal(launch.binary, f.binary);
    assert.equal(launch.cwd, f.project);
    assert.deepEqual(launch.args.slice(0, spec.args.length), spec.args);
  });
}
