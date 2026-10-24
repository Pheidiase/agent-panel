import test from "node:test";
import assert from "node:assert/strict";
import { clientModules } from "./fixtures/client-modules.mjs";

const load = clientModules();
load("i18n.ts").setLanguage("tr");
const { fetchJson } = load("revalidation.ts");

test("private revalidation sends a validator and reuses identity on a bodyless 304", async t => {
  const cache = {};
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/scrollback");
    assert.equal(init.cache, "no-cache");
    if (++count === 1) {
      assert.equal(init.headers.has("If-None-Match"), false);
      return new Response('{"text":"private"}', { headers: { ETag: 'W/"one"' } });
    }
    assert.equal(init.headers.get("If-None-Match"), 'W/"one"');
    return new Response(null, { status: 304 });
  });
  const first = await fetchJson("/api/scrollback", {}, cache);
  const next = await fetchJson("/api/scrollback", {}, cache);
  assert.equal(next.response.status, 304);
  assert.equal(next.data, first.data);
});

test("changed response refreshes the validator; auth failures remain errors", async t => {
  const cache = { etag: '"old"', data: { text: "old" } };
  const replies = [new Response('{"text":"new"}', { headers: { ETag: '"new"' } }), new Response('{"error":"denied"}', { status: 401 })];
  t.mock.method(globalThis, "fetch", async () => replies.shift());
  const changed = await fetchJson("/api/scrollback", {}, cache);
  assert.equal(cache.etag, '"new"');
  assert.equal(cache.data, changed.data);
  const denied = await fetchJson("/api/scrollback", {}, cache);
  assert.equal(denied.response.status, 401);
  assert.equal(denied.data.error, "denied");
  assert.equal(cache.data, changed.data);
});

test("ordinary requests keep their method, body and headers without a cache", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(init.body, "payload");
    assert.equal(init.headers.get("X-Panel-CSRF"), "test");
    assert.equal(init.headers.has("If-None-Match"), false);
    assert.equal(init.cache, undefined);
    return new Response('{"ok":true}');
  });
  assert.deepEqual((await fetchJson("/api/action", { method: "POST", body: "payload", headers: { "X-Panel-CSRF": "test" } })).data, { ok: true });
});

test("304 without a previous response fails instead of inventing content", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 304 }));
  await assert.rejects(fetchJson("/api/scrollback", {}, {}), error => {
    assert.equal(error.key, "revalidation.previousResponseMissing");
    assert.match(load("i18n.ts").messageText(error), /Önceki yanıt/);
    return true;
  });
});
