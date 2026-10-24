import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AcpConnection } from "../server/acp-client.mjs";
import { ClaudeConnection } from "../server/claude-manager.mjs";
import { StructuredStore, EVENT_LOG_LIMIT } from "../server/structured-store.mjs";
import { Sessions } from "../server/session-store.mjs";
import { TranscriptWriter, TRANSCRIPT_LIMIT, TRANSCRIPT_KEEP } from "../server/transcript-writer.mjs";
import { createUsageReader } from "../server/usage.mjs";

const root = path.resolve(import.meta.dirname, "..");
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-server-perf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const Connection of [AcpConnection, ClaudeConnection]) {
  test(`${Connection.name}: fragmented large lines copy only once and preserve UTF-8/order`, t => {
    const connection = new Connection({ command: "unused" });
    const texts = [];
    connection.onNotification = (_method, params) => texts.push(params.text);
    connection.onMessage = message => texts.push(message.params.text);
    const text = "界".repeat(350_000);
    const line = Buffer.from(JSON.stringify({ method: "notice", params: { text } }) + "\n");
    const concat = Buffer.concat;
    let copied = 0, joins = 0;
    t.mock.method(Buffer, "concat", (parts, length) => {
      copied += parts.reduce((sum, part) => sum + part.length, 0);
      joins++;
      return concat(parts, length);
    });
    for (let i = 0; i < line.length; i += 1024) connection._onStdout(line.subarray(i, i + 1024));
    connection._onStdout(Buffer.from('\n{"method":"notice","params":{"text":"next"}}\n'));
    assert.deepEqual(texts, [text, "next"]);
    assert.ok(copied <= line.length, `copied ${copied} bytes for ${line.length} input bytes`);
    assert.ok(joins <= 2);
    assert.equal(connection.lineReader.bytes, 0);
    assert.equal(connection.lineReader.parts.length, 0);
  });

  test(`${Connection.name}: byte limit holds for complete and unfinished fragmented lines`, () => {
    const max = 8 * 1024 * 1024;
    for (const chunks of [
      [Buffer.alloc(max + 1, 120), Buffer.from("\n")],
      [Buffer.alloc(max, 120), Buffer.from("x\n")],
      [Buffer.alloc(max + 1, 120)],
    ]) {
      const connection = new Connection({ command: "unused" });
      let kills = 0, handled = 0;
      connection._kill = () => kills++;
      connection._handleLine = () => handled++;
      for (const chunk of chunks) connection._onStdout(chunk);
      assert.equal(kills, 1);
      assert.equal(handled, 0);
      assert.equal(connection.lineReader.bytes, 0);
      assert.equal(connection.lineReader.parts.length, 0);
    }
    const connection = new Connection({ command: "unused" });
    let length;
    connection._handleLine = line => { length = line.length; };
    connection._onStdout(Buffer.alloc(max, 120));
    connection._onStdout(Buffer.from("\n"));
    assert.equal(length, max, "exactly the limit is allowed");
  });
}

test("event burst reuses one descriptor and does not query file size per event", t => {
  const store = new StructuredStore({ stateDir: directory(t) });
  t.after(() => store.closeLogs());
  const open = t.mock.method(fs, "openSync");
  const stat = t.mock.method(fs, "statSync");
  const fstat = t.mock.method(fs, "fstatSync");
  const appended = [];
  for (let i = 0; i < 100; i++) appended.push(store.appendEvent("chat", { kind: "assistant", text: String(i) }));
  assert.equal(open.mock.callCount(), 1);
  assert.equal(stat.mock.callCount(), 1, "only initial torn-line/sequence recovery queries the path");
  assert.equal(fstat.mock.callCount(), 1);
  open.mock.restore(); stat.mock.restore(); fstat.mock.restore();
  const persisted = fs.readFileSync(store.logPath("chat"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(persisted, appended, "return means written, with matching order/sequence");
});

test("open event descriptor follows compaction, closes on removal and is bounded", t => {
  const store = new StructuredStore({ stateDir: directory(t) });
  t.after(() => store.closeLogs());
  for (let i = 0; i < 45; i++) store.appendEvent("chat", { kind: "assistant", text: "x".repeat(240_000) });
  const last = store.appendEvent("chat", { kind: "assistant", text: "after compaction" });
  assert.ok(fs.statSync(store.logPath("chat")).size <= EVENT_LOG_LIMIT);
  assert.deepEqual(store.readEvents("chat").events.at(-1), last);
  const fd = store.logWriters.get("chat").fd;
  store.removeFiles("chat");
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  for (let i = 0; i < 55; i++) store.appendEvent(String(i), { kind: "turn" });
  assert.equal(store.logWriters.size, 50);
  store.closeLogs();
  assert.equal(store.logWriters.size, 0);
});

test("a failed descriptor append reports the same error, closes it and recovers a torn line in order", t => {
  const store = new StructuredStore({ stateDir: directory(t) });
  t.after(() => store.closeLogs());
  store.appendEvent("chat", { kind: "assistant", text: "before" });
  const fd = store.logWriters.get("chat").fd;
  const error = Object.assign(new Error("disk failure"), { code: "EIO" });
  const append = t.mock.method(fs, "appendFileSync", (handle, line) => {
    fs.writeSync(handle, line.slice(0, 12));
    throw error;
  });
  assert.throws(() => store.appendEvent("chat", { kind: "assistant", text: "lost" }), value => value === error);
  assert.equal(store.logWriters.size, 0);
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  append.mock.restore();
  const retry = store.appendEvent("chat", { kind: "assistant", text: "retry" });
  assert.equal(retry.seq, 2);
  const read = store.readEvents("chat");
  assert.deepEqual(read.events.map(event => event.text), ["before", "retry"]);
  assert.equal(read.truncated, true);
});

test("transcript never crosses 16 MiB while capturing, including huge single chunks", t => {
  const file = path.join(directory(t), "transcript.log");
  const writer = new TranscriptWriter(file);
  try {
    const chunk = Buffer.from(("x".repeat(1023) + "\n").repeat(64));
    for (let i = 0; i < 800; i++) {
      writer.append(chunk);
      assert.ok(fs.statSync(file).size <= TRANSCRIPT_LIMIT, `chunk ${i}`);
    }
    writer.append(Buffer.from("old\n" + "z".repeat(TRANSCRIPT_LIMIT * 2) + "\nLATEST\n"));
    assert.ok(fs.statSync(file).size <= TRANSCRIPT_KEEP);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("LATEST\n"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { writer.close(); }
});

test("tmux writer runs on stdin alone and compacts an oversized legacy file before appending", async t => {
  const file = path.join(directory(t), "transcript ' with spaces.log");
  fs.writeFileSync(file, Buffer.alloc(TRANSCRIPT_LIMIT + 1, 120));
  const child = spawn(process.execPath, [path.join(root, "server/transcript-writer.mjs"), file], { stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end("\nFINAL\n");
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.ok(fs.statSync(file).size <= TRANSCRIPT_LIMIT);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("FINAL\n"));
});

test("capture seeds are bounded and a web restart replaces the legacy pipe without touching the pane", async t => {
  const store = new Sessions({ root, stateDir: directory(t) });
  const record = { id: "chat", tmux: "panel-chat" };
  store.records.push(record);
  const commands = [];
  store.tmux = async args => {
    commands.push(args);
    return { stdout: args[0] === "capture-pane" ? "x".repeat(TRANSCRIPT_LIMIT + 1) + "\nseed\n" : "" };
  };
  const live = new Map([[record.tmux, { status: "running", pipe: true }]]);
  await store.ensureTranscripts(live);
  await store.ensureTranscripts(live);
  assert.ok(fs.statSync(store.transcriptPath(record.id)).size <= TRANSCRIPT_LIMIT);
  assert.deepEqual(commands.map(c => c[0]), ["capture-pane", "pipe-pane", "pipe-pane"]);
  assert.equal(commands[1].length, 3, "close only the legacy output pipe");
  assert.match(commands[2].at(-1), /transcript-writer\.mjs/);
  assert.doesNotMatch(commands[2].at(-1), /cat >>/);
});

test("legacy ended and unavailable transcripts are included in cleanup", async t => {
  const store = new Sessions({ root, stateDir: directory(t) });
  store.list = async () => [{ id: "ended", status: "ended" }, { id: "gone", status: "unavailable" }];
  for (const id of ["ended", "gone"]) fs.writeFileSync(store.transcriptPath(id), Buffer.alloc(TRANSCRIPT_LIMIT + 1, 120));
  await store.trimTranscripts();
  for (const id of ["ended", "gone"]) assert.ok(fs.statSync(store.transcriptPath(id)).size <= TRANSCRIPT_KEEP);
});

test("three usage consumers share one async scan and refresh together after TTL", async t => {
  const home = directory(t), stateDir = directory(t);
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(home, ".codex");
  t.after(() => { if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome; });
  const dir = path.join(home, ".codex/sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-fixture.jsonl");
  const write = used => fs.writeFileSync(file, JSON.stringify({ payload: { rate_limits: { primary: { used_percent: used } } } }) + "\n");
  write(10);
  let clock = 1000;
  const scan = t.mock.method(fsp, "readdir");
  const usage = createUsageReader({ home, stateDir, ttlMs: 5000, now: () => clock });
  const first = usage(), second = usage(), third = usage();
  assert.equal(first, second);
  assert.equal(first, third);
  const results = await Promise.all([first, second, third]);
  assert.equal(scan.mock.callCount(), 1);
  assert.equal(results[0].codex.fiveHour.usedPercent, 10);
  write(20);
  assert.equal(await usage(), results[0]);
  assert.equal(scan.mock.callCount(), 1);
  clock += 5000;
  const refreshed = await Promise.all([usage(), usage(), usage()]);
  assert.equal(scan.mock.callCount(), 2);
  assert.equal(refreshed[0].codex.fiveHour.usedPercent, 20);
  assert.equal(refreshed[0], refreshed[2]);
});

test("a failed shared usage read rejects all callers and can be retried", async () => {
  let calls = 0;
  const usage = createUsageReader({ load: async () => {
    if (++calls === 1) throw new Error("EIO");
    return { codex: { available: false }, claude: { available: false } };
  } });
  const failed = await Promise.allSettled([usage(), usage(), usage()]);
  assert.ok(failed.every(result => result.status === "rejected" && result.reason.message === "EIO"));
  assert.equal(calls, 1);
  assert.equal((await usage()).codex.available, false);
  assert.equal(calls, 2);
});
