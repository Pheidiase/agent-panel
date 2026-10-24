import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { OwnerStore } from "../../server/owner-store.mjs";
import { CURRENT_SCRYPT } from "../../server/passwords.mjs";

export const password = crypto.randomBytes(16).toString("hex");
const salt = crypto.randomBytes(16).toString("hex");
let credential;
export function tempState(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "panel-local-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  return state;
}
export function localFixture(t, { legacy = false } = {}) {
  const state = tempState(t), store = new OwnerStore(state);
  credential ||= { salt, hash: crypto.scryptSync(password, salt, 64, { ...CURRENT_SCRYPT, maxmem: 32 * 1024 * 1024 }).toString("hex"), scrypt: { ...CURRENT_SCRYPT } };
  const c = legacy ? { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") } : credential;
  const owner = store.setOwnerCredential({ username: "synthetic", ...c });
  return { state, store, owner, password, credential: c };
}
export function runPassword(state, args = ["--owner"], input = password + "\n") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../ops/set-password.mjs"), ...args], {
      env: { PATH: process.env.PATH, PANEL_STATE_DIR: state }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { output += c; });
    child.once("error", reject); child.once("close", code => resolve({ code, output }));
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
export function childProcessAvailable(t) {
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" });
  if (probe.error?.code === "EPERM") { t.skip("Sandbox denies child process execution (EPERM)"); return false; }
  if (probe.error) throw probe.error;
  if (probe.status !== 0 || probe.stdout !== "ok") throw new Error("Child process probe failed");
  return true;
}
export const request = (cookie, host = "127.0.0.1:4317", ip = "127.0.0.1") => ({
  url: "/", headers: { host, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: ip },
});
