import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("tests #16 metadata history fixture suite (three providers, read-only, filters, caps, corrupt DB)", () => {
  const result = spawnSync("python3", [new URL("./history-list.py", import.meta.url).pathname], { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
