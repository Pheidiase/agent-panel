import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createLocalAuth } from "../server/local-auth.mjs";
import { localFixture, request } from "./fixtures/local-auth-fixture.mjs";

const index = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const source = index.slice(index.indexOf("  const ticket = tickets.get(token);"), index.indexOf("  wss.handleUpgrade"));
const upgrade = new Function("tickets", "token", "portalAuth", "req", "fail", "url", `return (async () => {${source} return 101;})()`);
test("expired/missing/replayed tickets are consumed before auth, valid tickets bind cookie and route", async t => {
  const { state, password } = localFixture(t), auth = createLocalAuth({ state, app: "panel", port: 4317 });
  const { grant, cookie } = await auth.login(request(), { username: "synthetic", password });
  const req = request(cookie.split(";")[0]); let calls = 0;
  const counted = { session: r => { calls++; return auth.session(r); } };
  const check = (map, r = req, route = "/live") => upgrade(map, "ticket", counted, r, (status = 403) => status, new URL("http://localhost" + route));
  for (const record of [undefined, { expires: 0 }, { expires: Date.now() }]) {
    const map = new Map([["ticket", record]]); assert.equal(await check(map), 401); assert.equal(map.size, 0);
  }
  assert.equal(calls, 0);
  const valid = route => new Map([["ticket", { id: route === "/live" ? "live" : "session", route, grant, expires: Date.now() + 30000 }]]);
  const one = valid("/live"); assert.equal(await check(one), 101); assert.equal(await check(one), 401);
  assert.equal(await check(valid("/live"), request()), 401);
  for (const route of ["/terminal", "/structured", "/live"]) {
    assert.equal(await check(valid(route), req, route), 101);
    for (const wrong of ["/terminal", "/structured", "/live"].filter(r => r !== route)) assert.equal(await check(valid(route), req, wrong), 403);
  }
  await auth.logout(req, grant); assert.equal(await check(valid("/live")), 401);
  assert.match(index, /expires: Date\.now\(\) \+ 30000/);
});
test("wrong Origin is rejected before ticket consumption or authentication", async () => {
  const source = index.slice(index.indexOf('  if (\n    !["/terminal"'), index.indexOf('  const token = String(req.headers["sec-websocket-protocol"]'));
  const gate = new Function("url", "hostOK", "originOK", "req", "fail", source + "; return 101;");
  assert.equal(gate(new URL("http://localhost/live"), () => true, () => false, {}, () => 403), 403);
});
