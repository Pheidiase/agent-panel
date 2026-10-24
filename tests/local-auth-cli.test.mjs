import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, PassThrough } from "node:stream";
import { setPassword, passwordInput, passwordError } from "../ops/set-password.mjs";
import { LocalIdentity } from "../server/local-identity.mjs";
import { OwnerStore } from "../server/owner-store.mjs";
import { tempState, localFixture, password, runPassword, childProcessAvailable } from "./fixtures/local-auth-fixture.mjs";

function cli(state, args = [], value = password + "\n") {
  let output = "";
  return { run: () => setPassword({ state, args, input: Readable.from([value]), output: { write: v => { output += v; } } }), output: () => output };
}
test("npm script, first setup, name preservation and rename retain owner identity", async t => {
  const state = tempState(t), store = new OwnerStore(state);
  assert.equal(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).scripts["set-password"], "node ops/set-password.mjs");
  await assert.rejects(cli(state).run(), /İlk kurulum/); assert.equal(store.read(), null);
  const first = cli(state, ["--owner", "--rename", "synthetic"]), owner = await first.run();
  assert.equal(owner.authVersion, 1); assert.equal(owner.scrypt.version, 2); assert.doesNotMatch(first.output(), new RegExp(password));
  assert.match(first.output(), /Sahip parolası kaydedildi.*Owner password saved; previous local sessions invalidated/);
  await cli(state).run(); assert.equal(store.read().username, "synthetic"); assert.equal(store.read().authVersion, 2);
  await cli(state, ["--owner", "--rename", "renamed"]).run();
  assert.equal(store.read().id, owner.id); assert.equal(store.read().createdAt, owner.createdAt);
  assert.equal(store.read().username, "renamed"); assert.equal(store.read().authVersion, 3);
  assert.equal(fs.existsSync(path.join(state, "credentials.json")), false);
  assert.equal(fs.existsSync(path.join(state, "auth.json")), false);
});
test("invalid argv, multiline stdin, invalid names and length never create an account", async t => {
  const state = tempState(t), args = ["--owner", "--rename", "synthetic"];
  for (const invalid of [["--password", password], [password], ["--from-panel"], ["--owner", "extra"], ["--owner", "--rename", " spaced "]])
    await assert.rejects(cli(state, invalid).run());
  for (const input of ["x".repeat(11), "x".repeat(201), "x\ny\n", "x".repeat(1025)]) await assert.rejects(cli(state, args, input).run());
  assert.equal(new OwnerStore(state).read(), null);
  await cli(state, args, "x".repeat(12) + "\n").run();
  await cli(state, ["--owner"], "x".repeat(200) + "\n").run();
});
test("plain interactive set-password asks for the first owner's name before the hidden password", async t => {
  const state = tempState(t), input = new PassThrough(), modes = []; let printed = "";
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = raw => { modes.push(raw); input.isRaw = raw; };
  const prompt = new PassThrough();
  prompt.on("data", chunk => {
    const text = chunk.toString(); printed += text;
    if (text.includes("Username:")) setImmediate(() => input.write("synthetic\n"));
    if (text.includes("gizli giriş")) setImmediate(() => input.write(password + "\r"));
  });
  try {
    const owner = await setPassword({ state, input, prompt, output: { write: v => { printed += v; } } });
    assert.equal(owner.username, "synthetic"); assert.equal(owner.authVersion, 1);
    assert.deepEqual(modes, [true, false]); assert.equal(printed.includes(password), false);
    assert.match(printed, /Parola \/ Password/); assert.match(printed, /Parola tekrar \/ Confirm password/);
  } finally { input.destroy(); prompt.destroy(); }
});
test("CLI never overwrites corrupt state or ignores an owner lock; portal mode stays portal", async t => {
  const { state, store } = localFixture(t), before = fs.readFileSync(store.file, "utf8");
  fs.mkdirSync(path.join(state, "owner.json.lock"));
  await assert.rejects(cli(state).run(), { status: 503 });
  assert.equal(fs.readFileSync(store.file, "utf8"), before); fs.rmdirSync(path.join(state, "owner.json.lock"));
  fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ mode: "portal" }), { mode: 0o600 });
  const portal = cli(state); await portal.run(); assert.match(portal.output(), /Portal modu etkin/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "auth.json"))), { mode: "portal" });
  fs.writeFileSync(store.file, "broken"); await assert.rejects(cli(state).run(), { status: 503 });
  assert.equal(fs.readFileSync(store.file, "utf8"), "broken");
});
test("TTY input requests raw mode, never echoes secrets, supports erase and restores on cancel", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(), modes = []; let printed = "";
    input.isTTY = true; input.isRaw = false; input.setRawMode = raw => { modes.push(raw); input.isRaw = raw; };
    const promise = passwordInput(input, { write: value => {
      printed += value;
      if (value.includes("hidden input")) {
        assert.equal(input.isRaw, true);
        input.write(cancel ? "cancelled-secret\u0003" : "synthetic-x\u007fpassword\r");
      }
    } });
    if (cancel) await assert.rejects(promise, /kesildi/); else assert.equal(await promise, "synthetic-password");
    assert.deepEqual(modes, [true, false]); assert.doesNotMatch(printed, /cancelled-secret|synthetic-password/); input.destroy();
  }
});
test("CLI writes revoke a login paused outside the owner lock", async t => {
  const { state, password } = localFixture(t);
  let release, entered;
  const wait = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { derivePassword } = await import("../server/passwords.mjs");
  const identity = new LocalIdentity(state, new Map(), { derive: async (...args) => { const hash = await derivePassword(...args); entered(); await gate; return hash; } });
  const login = identity.login("synthetic", password); await wait;
  await cli(state, ["--owner"], "new synthetic password\n").run(); release();
  await assert.rejects(login, { status: 401 }); assert.equal(identity.grants.size, 0);
});
test("two real CLI processes never lose an update or leak their stdin", async t => {
  if (!childProcessAvailable(t)) return;
  const { state, store } = localFixture(t);
  const results = await Promise.all([runPassword(state), runPassword(state)]);
  // Lock contention may fail closed; successful writers must each advance exactly once.
  const successful = results.filter(r => r.code === 0).length;
  assert.ok(successful >= 1); assert.equal(store.read().authVersion, 1 + successful);
  for (const result of results) assert.equal(result.output.includes(password), false);
});


test("interactive confirmation mismatch/cancel never creates or updates credentials or audit", async t => {
  for (const existing of [false, true]) for (const cancel of [false, true]) {
    const state = existing ? localFixture(t).state : tempState(t);
    const snapshot = () => fs.readdirSync(state).sort().map(file => [file, fs.readFileSync(path.join(state, file), "utf8")]);
    const before = snapshot(), input = new PassThrough(), prompt = new PassThrough(), modes = [];
    let printed = "";
    input.isTTY = true; input.isRaw = false;
    input.setRawMode = raw => { input.isRaw = raw; modes.push(raw); };
    prompt.on("data", chunk => {
      const text = chunk.toString(); printed += text;
      if (text.includes("Parola / Password")) setImmediate(() => input.write(password + "\r"));
      if (text.includes("Confirm password")) setImmediate(() => input.write(cancel ? "\u0003" : "different synthetic secret\r"));
    });
    try {
      await assert.rejects(setPassword({ state, args: ["--owner", "--rename", "synthetic"], input, prompt,
        output: { write: value => { printed += value; } } }), cancel ? /kesildi/ : /eşleşmiyor.*Passwords do not match/);
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(modes, [true, false]);
      assert.equal(printed.includes(password), false); assert.equal(printed.includes("different synthetic secret"), false);
      assert.equal(input.listenerCount("data"), 0); assert.equal(input.isRaw, false);
    } finally { input.destroy(); prompt.destroy(); }
  }
});

test("short and long password errors explicitly state the length rule without echoing input", async t => {
  const state = tempState(t);
  for (const value of ["short", "z".repeat(201), "z".repeat(1025)]) {
    await assert.rejects(cli(state, ["--owner", "--rename", "synthetic"], value).run(), error => {
      const message = passwordError(error);
      assert.match(message, /12–200/); assert.match(message, /Password must be/);
      assert.equal(message.includes(value), false); return true;
    });
  }
  assert.equal(new OwnerStore(state).read(), null);
});

test("TTY discards typeahead and restores the previous mode on read, prompt and validation errors", async t => {
  for (const failure of ["none", "read", "end", "close", "prompt", "length"]) for (const wasRaw of [false, true]) {
    const input = new PassThrough(); let printed = "";
    input.isTTY = true; input.isRaw = wasRaw; input.setRawMode = raw => { input.isRaw = raw; };
    input.write("stale synthetic typeahead\n");
    const run = passwordInput(input, { write: value => {
      if (!value.includes("hidden input")) return;
      assert.equal(input.isRaw, true); printed += value;
      if (failure === "prompt") throw new Error("synthetic output failure");
      if (failure === "read") input.emit("error", new Error("synthetic input failure"));
      else if (failure === "end") input.end();
      else if (failure === "close") input.destroy();
      else input.write(failure === "length" ? "x".repeat(201) : "fresh synthetic password\r");
    } });
    if (failure === "none") assert.equal(await run, "fresh synthetic password");
    else await assert.rejects(run, /okunamadı|kesildi|12–200/);
    assert.equal(input.isRaw, wasRaw);
    for (const event of ["data", "end", "close", "error"]) assert.equal(input.listenerCount(event), 0);
    assert.equal(printed.includes("stale synthetic typeahead"), false); input.destroy();
  }
  const state = tempState(t), prompt = { write: () => assert.fail("non-TTY must not prompt or echo") };
  await setPassword({ state, args: ["--owner", "--rename", "synthetic"], input: Readable.from([password + "\n"]), prompt, output: { write() {} } });
});

test("real PTY immediate replies never echo passwords and all exit paths restore terminal state", t => {
  if (process.platform === "win32") { t.skip("POSIX PTY regression requires termios"); return; }
  const result = spawnSync("python3", [path.resolve(import.meta.dirname, "fixtures/password-tty.py"), process.execPath], { encoding: "utf8", timeout: 30000 });
  if (["ENOENT", "EPERM"].includes(result.error?.code)) { t.skip(`PTY helper unavailable: ${result.error.code}`); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.cases, 16); assert.equal(summary.echoLeaks, 0); assert.equal(summary.restored, 16);
});

test("cancel and stream errors during the pre-prompt drain restore the terminal without showing a prompt", async () => {
  for (const failure of ["cancel", "read", "output", "ended"]) {
    const input = new PassThrough(), prompt = new PassThrough(); let printed = "";
    input.isTTY = true; input.isRaw = false; input.setRawMode = raw => { input.isRaw = raw; };
    prompt.on("data", chunk => { printed += chunk; });
    if (failure === "ended") { input.end(); input.resume(); await new Promise(resolve => input.once("end", resolve)); }
    const run = passwordInput(input, prompt);
    if (failure === "cancel") input.write("\u0003");
    if (failure === "read") input.emit("error", new Error("synthetic input failure"));
    if (failure === "output") prompt.emit("error", new Error("synthetic output failure"));
    await assert.rejects(run, /kesildi|okunamadı/);
    assert.equal(input.isRaw, false); assert.equal(printed, "\n");
    assert.equal(input.listenerCount("data"), 0); assert.equal(prompt.listenerCount("error"), 0);
    input.destroy(); prompt.destroy();
  }
});
