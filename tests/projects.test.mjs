// Workspace project discovery: config entries keep their metadata, new
// directories appear automatically, files/hidden/junk are ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjects, refreshProjects } from "../server/projects.mjs";

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-proj-")));
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(path.join(workspace, "alpha"), { recursive: true });
  const configFile = path.join(dir, "projects.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify([
      { id: "general", name: "Genel", kind: "general" },
      { id: "alpha", name: "Alfa", description: "d", icon: "radar", color: "sage" },
      { id: "gone", name: "Yok" },
    ]),
  );
  return { dir, workspace, configFile, home: dir };
}

test("configured projects keep metadata; missing dirs are dropped", () => {
  const o = setup();
  const ids = loadProjects(o).map((p) => p.id);
  assert.deepEqual(ids, ["general", "alpha"]);
  assert.equal(loadProjects(o)[1].name, "Alfa");
});

test("new directories are discovered; files, hidden and node_modules are not", () => {
  const o = setup();
  fs.mkdirSync(path.join(o.workspace, "yeni-proje"));
  fs.mkdirSync(path.join(o.workspace, ".hidden"));
  fs.mkdirSync(path.join(o.workspace, "node_modules"));
  fs.writeFileSync(path.join(o.workspace, "notes.txt"), "x");
  const list = loadProjects(o);
  assert.deepEqual(list.map((p) => p.id), ["general", "alpha", "yeni-proje"]);
  const added = list[2];
  assert.equal(added.name, "Yeni Proje");
  assert.equal(added.description, "");
  assert.equal(added.path, path.join(o.workspace, "yeni-proje"));
});

test("discovered project names use language-independent capitalization", () => {
  const o = setup();
  fs.mkdirSync(path.join(o.workspace, "infra"));
  assert.equal(loadProjects(o).find((p) => p.id === "infra").name, "Infra");
});

test("refreshProjects updates the shared array in place", () => {
  const o = setup();
  const shared = loadProjects(o);
  fs.mkdirSync(path.join(o.workspace, "beta"));
  refreshProjects(shared, o);
  assert.ok(shared.some((p) => p.id === "beta"));
});
