import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectPrefs } from "../server/project-prefs.mjs";

test("hidden projects persist, general is never hidden, bad input rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  const a = new ProjectPrefs(dir);
  assert.deepEqual(a.snapshot(), { hidden: [] });
  a.setHidden({ hidden: ["sample-game", "general", "sample-web"] });
  assert.deepEqual(new ProjectPrefs(dir).snapshot().hidden.sort(), ["sample-game", "sample-web"]);
  assert.throws(() => a.setHidden({ hidden: ["../x"] }));
  assert.throws(() => a.setHidden({}));
  assert.equal(fs.statSync(path.join(dir, "project-prefs.json")).mode & 0o777, 0o600);
});
