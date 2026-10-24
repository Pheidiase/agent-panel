import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions, TRANSCRIPT_LIMIT } from "../server/session-store.mjs";

const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

test("tests #17 private tmux output pipe keeps appending after bounded Unicode compaction", { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-pipe-"));
  const store = new Sessions({ root: path.resolve(import.meta.dirname, ".."), stateDir: dir, socket: path.join(dir, "tmux.sock") });
  let started = false;
  t.after(async () => {
    if (started) await store.tmux(["kill-server"]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const fixture = path.join(dir, "output.mjs");
  fs.writeFileSync(fixture, `import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', line => {
      if (line === 'burst') {
        const chunk = ('界ğ😀'.repeat(60) + '\\n').repeat(100);
        for (let i = 0; i < 400; i++) process.stdout.write(chunk);
        process.stdout.write('BURST_FINISHED\\n');
      } else if (line === 'next') process.stdout.write('UNIQUE_AFTER_TRIM_界ğ😀\\n');
    });
    console.log('FIXTURE_READY');`);
  await store.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "fixture", `${quote(process.execPath)} ${quote(fixture)}`]);
  started = true;
  const record = { id: "fixture", tmux: "fixture" };
  const pid = async () => (await store.tmux(["display-message", "-p", "-t", "fixture", "#{pane_pid}"])).stdout.trim();
  const before = await pid();
  await store.startTranscript(record);
  const file = store.transcriptPath(record.id);
  const waitText = async marker => {
    for (let i = 0; i < 300; i++) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`fixture output missing: ${marker}`);
  };
  await store.tmux(["send-keys", "-t", "fixture", "burst", "Enter"]);
  await waitText("BURST_FINISHED");
  assert.ok(fs.statSync(file).size <= TRANSCRIPT_LIMIT);
  await store.tmux(["send-keys", "-t", "fixture", "next", "Enter"]);
  await waitText("UNIQUE_AFTER_TRIM_界ğ😀");
  assert.equal(await pid(), before, "compaction preserves the fixture process");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("\uFFFD"), "UTF-8 characters survive chunk boundaries and compaction");
  assert.ok(fs.statSync(file).size <= TRANSCRIPT_LIMIT);
});
