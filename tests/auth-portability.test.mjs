import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAuth } from "../server/auth.mjs";
import { tempState, request } from "./fixtures/local-auth-fixture.mjs";

test("local auth imports only Panel files and Node builtins, never the portal repository", async t => {
  const names = ["auth", "local-auth", "local-identity", "owner-store", "passwords", "login-limits", "user-lock", "json-store", "audit", "client-ip"];
  for (const name of names) {
    const text = fs.readFileSync(new URL(`../server/${name}.mjs`, import.meta.url), "utf8");
    for (const [, specifier] of text.matchAll(/from\s+"([^"]+)"/g)) assert.match(specifier, /^(?:node:|\.\/)/);
    assert.doesNotMatch(text, /PORTAL_STATE_DIR|[/]home[/]|\.\.\/\.\.\//);
  }
  const state = tempState(t); t.mock.method(globalThis, "fetch", assert.fail);
  const auth = createAuth({ state, app: "panel", port: 4317 });
  assert.equal(await auth.session(request()), null); assert.equal(auth.portal(), null);
  assert.deepEqual(fs.readdirSync(state), [], "creating auth does not create credentials or consult another repo");
});
test("CLI resolves PANEL_STATE_DIR or project var and never accepts password env/argv", () => {
  const cli = fs.readFileSync(new URL("../ops/set-password.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /process\.env\.(?:PASSWORD|PASS|PORTAL_)|--password|--from-panel/);
  assert.match(cli, /process\.env\.PANEL_STATE_DIR/); assert.match(cli, /path\.resolve\(import\.meta\.dirname, "\.\.\/var"\)/);
});


test("portability guard rejects a synthetic fixed home path and parent-repo traversal", () => {
  const guard = /PORTAL_STATE_DIR|[/]home[/]|\.\.\/\.\.\//;
  assert.match(`function locate() { return "${["", "home", "example", "private-state"].join("/")}"; }`, guard);
  assert.match('import "../../other/state.mjs";', guard);
});
