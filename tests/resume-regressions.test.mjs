import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StructuredManager } from "../server/structured-manager.mjs";
import { StructuredStore } from "../server/structured-store.mjs";
import { AcpConnection } from "../server/acp-client.mjs";

for (const [label, pages, expected] of [
  ["unfinished third page", [{ nextCursor: "p2" }, { nextCursor: "p3" }, { nextCursor: "p4" }], null],
  ["exhausted third page", [{ nextCursor: "p2" }, { nextCursor: "p3" }, {}], false],
  ["exhausted first page", [{}], false],
  ["found on third page", [{ nextCursor: "p2" }, { nextCursor: "p3" }, { sessions: [{ sessionId: "native" }], nextCursor: "p4" }], true],
]) {
  test(`Hermes existence: ${label}`, async () => {
    const calls = [];
    const connection = { async request(method, params) {
      calls.push([method, params]);
      return pages[calls.length - 1];
    } };
    assert.equal(await StructuredManager.prototype._sessionExists(connection, "native", "/fixture"), expected);
    assert.equal(calls.length, pages.length);
    assert.deepEqual(calls[0], ["session/list", { cwd: "/fixture" }]);
    if (calls.length > 1) assert.deepEqual(calls[1], ["session/list", { cwd: "/fixture", cursor: "p2" }]);
  });
}

test("Hermes existence: a list error remains unknown", async () => {
  assert.equal(await StructuredManager.prototype._sessionExists({ request: async () => { throw new Error("offline"); } }, "native", "/fixture"), null);
});

for (const unfinished of [true, false]) {
  test(`empty Hermes load ${unfinished ? "preserves the original id on incomplete listing" : "can reopen after a complete listing"}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-resume-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new StructuredStore({ stateDir: dir });
    t.after(() => store.closeLogs());
    store.add({ id: "chat", projectId: "p", agentId: "hermes", acpSessionId: "native" });
    const manager = new StructuredManager({ store, projects: [{ id: "p", path: dir }], agentCommand: { command: "unused", args: [] } });
    t.after(() => manager.shutdown());
    const calls = [];
    let pages = 0, closes = 0;
    // Exercise the real resume path with no process, model prompt or network.
    t.mock.method(AcpConnection.prototype, "start", function () { this.child = { exitCode: null }; });
    t.mock.method(AcpConnection.prototype, "close", async function () { closes++; this.child.exitCode = 0; });
    t.mock.method(AcpConnection.prototype, "request", async (method) => {
      calls.push(method);
      if (method === "session/list") {
        pages++;
        return { sessions: [], nextCursor: unfinished || pages < 3 ? `p${pages + 1}` : null };
      }
      if (method === "session/new") return { sessionId: "fresh" };
      return {};
    });
    assert.equal(await manager.ensureConnected("chat"), !unfinished);
    assert.equal(pages, 3);
    assert.equal(calls.filter(method => method === "session/new").length, unfinished ? 0 : 1);
    const reopened = new StructuredStore({ stateDir: dir });
    assert.equal(reopened.get("chat").acpSessionId, unfinished ? "native" : "fresh");
    if (unfinished) {
      assert.match(manager.stateOf("chat").lastError, /yüklenemedi/);
      assert.equal(closes, 1);
      assert.equal(manager.runtimes.size, 0);
      assert.equal(store.readEvents("chat").events.some(event => event.status === "reopened"), false);
    }
  });
}
