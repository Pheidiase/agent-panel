import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Sessions, exec } from "../server/session-store.mjs";
const root = path.resolve(import.meta.dirname, "..");
test("private tmux sessions: persistence, idempotency, validation and parallel guard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-test-"));
  const socket = path.join(dir, "tmux.sock");
  const server = spawn(
    "/usr/bin/tmux",
    ["-D", "-S", socket, "-f", path.join(root, "config/tmux.conf")],
    { stdio: "ignore" },
  );
  const fixture = path.join(dir, "fixture");
  fs.writeFileSync(
    fixture,
    `#!${process.execPath}\nconsole.log("FIXTURE_READY",JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.stdin.on("data",d=>process.stdout.write(d));setInterval(()=>{},10000);`,
    { mode: 0o700 },
  );
  const store = new Sessions({
    root,
    stateDir: dir,
    socket,
    projects: [{ id: "agent-panel", name: "Panel", path: root }, { id: "general", name: "Ubuntu", path: os.homedir(), kind: "general" }],
    agents: [
      { id: "hermes", name: "Hermes", available: true, executable: fixture },
      { id: "claude", name: "Claude", available: false },
      { id: "codex", name: "Codex", available: true, executable: fixture },
    ],
  });
  const input = {
    projectId: "agent-panel",
    agentId: "hermes",
    title: "Test $(touch SHOULD_NOT_EXIST)",
    requestId: "test-idempotency-0001",
  };
  try {
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(socket)) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.deepEqual(await store.list(), []);
    const [a, b] = await Promise.all([
      store.create(input),
      store.create(input),
    ]);
    assert.equal(a.id, b.id);
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.list())[0].status, "running");
    assert.deepEqual((await store.list())[0].geometry, { cols: 120, rows: 34 });
    await assert.rejects(
      store.create({ ...input, requestId: "test-parallel-0002" }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      store.create({
        ...input,
        projectId: "../brain",
        requestId: "test-project-0003",
      }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      store.create({
        ...input,
        agentId: "claude",
        requestId: "test-agent-case-0004",
      }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      store.create({
        ...input,
        title: "bad\nname",
        requestId: "test-name-case-0005",
      }),
      (e) => e.status === 400,
    );
    assert.equal(fs.existsSync(path.join(root, "SHOULD_NOT_EXIST")), false);
    const reloaded = new Sessions({
      root,
      stateDir: dir,
      socket,
      projects: store.projects,
      agents: store.agents,
    });
    assert.equal((await reloaded.list())[0].pid, (await store.list())[0].pid);
    const second = await store.create({
      ...input,
      requestId: "test-parallel-ok-0006",
      allowParallel: true,
    });
    assert.notEqual(a.id, second.id);
    await store.end(a.id);
    assert.equal((await store.list()).length, 1);
    await store.end(second.id);
    assert.equal((await store.list()).length, 0);
    const general = await store.create({...input, projectId: "general", agentId: "codex", requestId: "general-home-test-0007"});
    let output = "";
    for (let i = 0; i < 50; i++) {
      output = (await store.tmux(["capture-pane", "-p", "-t", general.tmux])).stdout;
      if (output.includes("FIXTURE_READY")) break;
      await new Promise(r => setTimeout(r, 40));
    }
    // Codex stays on the main screen in general mode too, so tmux keeps its history.
    assert.ok(output.includes(JSON.stringify({cwd:os.homedir(),args:["--no-alt-screen"]})), output);
    // While the pane is live, history reads tmux's own emulated screen; the
    // append-only transcript is the fallback when a pane is gone.
    const transcript = store.transcriptPath(general.id);
    for (let i = 0; i < 60 && !(fs.existsSync(transcript) && fs.statSync(transcript).size > 0); i++)
      await new Promise(r => setTimeout(r, 40));
    assert.ok(fs.existsSync(transcript), "transcript was not created");
    assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
    const piped = await store.output(general.id);
    assert.equal(piped.source, "screen");
    assert.ok(piped.text.includes("FIXTURE_READY"));
    // An explicit, user-requested change is the only resize the panel performs.
    await store.setGeometry(general.id, 80, 30);
    assert.deepEqual((await store.list()).find(s => s.id === general.id).geometry, { cols: 80, rows: 30 });
    const pane = (await store.tmux(["display-message", "-p", "-t", general.tmux, "#{pane_width}x#{pane_height}"])).stdout.trim();
    assert.equal(pane, "80x30");
    await assert.rejects(store.setGeometry(general.id, 5000, 30), e => e.status === 400);
    await assert.rejects(
      store.create({...input, projectId:"general", agentId:"codex", requestId:"geometry-invalid-0008", geometry:{cols:1,rows:1}}),
      e => e.status === 400,
    );
    const originalPid = (await store.list()).find(s => s.id === general.id).pid;
    await Promise.all([
      store.update(general.id, {title: "Renamed $(touch SHOULD_NOT_EXIST)"}),
      store.update(general.id, {archived: true, pinned: true, opened: true}),
    ]);
    let updated = (await store.list()).find(s => s.id === general.id);
    assert.equal(updated.pid, originalPid);
    assert.equal(updated.archived, true);
    assert.equal(updated.pinned, true);
    assert.ok(updated.lastOpenedAt);
    assert.equal(updated.title, "Renamed $(touch SHOULD_NOT_EXIST)");
    await assert.rejects(store.update(general.id, {title: "bad\nname"}), e => e.status === 400);
    await assert.rejects(store.update(general.id, {tmux: "other-pane"}), e => e.status === 400);
    await assert.rejects(store.update(general.id, {archived: "yes"}), e => e.status === 400);
    const captured = await store.output(general.id);
    assert.ok(captured.text.includes("FIXTURE_READY"));
    assert.ok(Array.isArray(captured.runs) && Array.isArray(captured.styles));
    // The mapped agent log is remembered on the record (id and folder only).
    await store.rememberLog(general.id, { id: "11111111-2222-4333-8444-555555555555", cwd: "/tmp/x" });
    assert.deepEqual(store.get(general.id).log, { id: "11111111-2222-4333-8444-555555555555", cwd: "/tmp/x" });
    await store.stop(general.id);
    assert.equal((await store.list()).find(s => s.id === general.id).status, "ended");
    assert.equal((await store.output(general.id)).text, captured.text);
    assert.equal(fs.statSync(store.snapshotPath(general.id)).mode & 0o777, 0o600);
    await store.stop(general.id); // Repeated stop is harmless.
    const persisted = new Sessions({root, stateDir:dir, socket, projects:store.projects, agents:store.agents});
    assert.equal((await persisted.list()).find(s => s.id === general.id).archived, true);
    assert.equal((await persisted.output(general.id)).text, captured.text);
    assert.deepEqual((await persisted.list()).find(s => s.id === general.id).log?.cwd, "/tmp/x");
    // A colour sidecar is used only when it matches the snapshot text.
    fs.writeFileSync(store.stylePath(general.id), JSON.stringify({ length: captured.text.length, styles: ["p1||000000"], runs: [0, 3, 0] }));
    assert.deepEqual((await store.output(general.id)).runs, [0, 3, 0]);
    fs.writeFileSync(store.stylePath(general.id), JSON.stringify({ length: 1, styles: ["p1||000000"], runs: [0, 3, 0] }));
    assert.equal((await store.output(general.id)).runs, undefined);
    const snapshot = store.snapshotPath(general.id), sidecar = store.stylePath(general.id);
    await store.end(general.id);
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.existsSync(sidecar), false);
    assert.equal(fs.existsSync(transcript), false);
    assert.deepEqual(await store.list(), []);
    // With the pane gone (tmux server stopped), output() falls back to the
    // append-only transcript instead of failing.
    const orphan = await store.create({ ...input, agentId: "codex", requestId: "test-fallback-0009" });
    const orphanTranscript = store.transcriptPath(orphan.id);
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(orphanTranscript) && fs.readFileSync(orphanTranscript, "utf8").includes("FIXTURE_READY")) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    await exec("/usr/bin/tmux", ["-S", socket, "kill-server"]).catch(() => {});
    const fallback = await store.output(orphan.id);
    assert.equal(fallback.source, "transcript");
    assert.ok(fallback.text.includes("FIXTURE_READY"));
    await store.end(orphan.id);
  } finally {
    await exec("/usr/bin/tmux", ["-S", socket, "kill-server"]).catch(() => {});
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
