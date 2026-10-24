// Bounded project file index behind the "@" mention picker: skipping rules,
// scan caps, ranking and containment. Filesystem-only, no server, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProjectFiles, rankFiles, listProjectFiles } from "../server/files-index.mjs";

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-files-"));
  const put = (rel, content = "x") => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put("package.json");
  put("src/main.tsx");
  put("src/nested/deep.txt");
  put("docs/notlar.md");
  put("node_modules/pkg/index.js");
  put(".hidden/secret.txt");
  put(".gitignore");
  put("dist/bundle.js");
  return dir;
}

test("scanProjectFiles: skips heavy dirs, dotfiles and symlinks; scan cap flags truncation", async () => {
  const dir = makeTree();
  fs.symlinkSync(path.join(dir, "package.json"), path.join(dir, "linked.json"));
  const { files, truncated } = await scanProjectFiles(dir);
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("src/main.tsx"));
  assert.ok(files.includes("src/nested/deep.txt"));
  assert.ok(files.includes("docs/notlar.md"));
  assert.ok(!files.some((file) => file.includes("node_modules")));
  assert.ok(!files.some((file) => file.startsWith(".")));
  assert.ok(!files.includes("dist/bundle.js"));
  assert.ok(!files.includes("linked.json"));
  assert.equal(truncated, false);
  const limited = await scanProjectFiles(dir, { scanLimit: 3 });
  assert.equal(limited.truncated, true);
  assert.ok(limited.files.length <= 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rankFiles: basename prefix beats substring; empty query lists the head", () => {
  const files = [
    "src/readme-notes.md",
    "docs/readme.md",
    "src/sub/deep-readme.txt",
    "a.txt",
    "readme.md",
  ];
  const ranked = rankFiles(files, "readme", 10);
  assert.equal(ranked[0], "readme.md");
  assert.equal(ranked[1], "docs/readme.md");
  assert.ok(ranked.indexOf("src/sub/deep-readme.txt") > ranked.indexOf("docs/readme.md"));
  const browsed = rankFiles(files, "", 3);
  assert.deepEqual(browsed, files.slice(0, 3));
  assert.equal(rankFiles(files, "nope-nothing", 10).length, 0);
});

test("listProjectFiles: stays inside the root, respects the query, tolerates a missing root", async () => {
  const dir = makeTree();
  const result = await listProjectFiles(dir, { query: "package" });
  assert.deepEqual(result.files, ["package.json"]);
  assert.equal(result.truncated, false);
  for (const file of result.files) {
    assert.ok(!file.startsWith("/") && !file.includes(".."));
    assert.ok(path.resolve(dir, file).startsWith(dir + path.sep));
  }
  const traversal = await listProjectFiles(dir, { query: "../" });
  assert.ok(!traversal.files.some((file) => file.includes("..")));
  const missing = await listProjectFiles(path.join(dir, "nope"));
  assert.deepEqual(missing.files, []);
  assert.equal(missing.total, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
