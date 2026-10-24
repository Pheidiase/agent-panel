import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const js = ts.transpileModule(fs.readFileSync(new URL("../src/terminal-mouse.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { bindTerminalMouseCoordinates } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const originalNode = globalThis.Node;
class NodeFixture {}
globalThis.Node = NodeFixture;
after(() => { if (originalNode === undefined) delete globalThis.Node; else globalThis.Node = originalNode; });

function setup(t, scale = 0.5) {
  const document = new EventTarget(), inside = new NodeFixture(), outside = new NodeFixture();
  const element = { ownerDocument: document, contains: node => node === inside };
  const screen = { offsetWidth: 100, offsetHeight: 60,
    getBoundingClientRect: () => ({ left: 50, top: 20, width: 100 * scale, height: 60 * scale }) };
  const dispose = bindTerminalMouseCoordinates(element, screen);
  t.after(dispose);
  const fire = (type, target = inside) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      target: { value: target }, clientX: { configurable: true, value: 75 },
      clientY: { configurable: true, value: 35 }, button: { value: 0 }, shiftKey: { value: true },
    });
    document.dispatchEvent(event);
    return event;
  };
  return { fire, outside, dispose };
}

test("scaled terminal mouse events identify the visible cell without cancelling native actions", t => {
  const { fire } = setup(t);
  const event = fire("mousemove");
  assert.equal(event.clientX, 100);
  assert.equal(event.clientY, 50);
  assert.equal(event.shiftKey, true);
  assert.equal(event.defaultPrevented, false);
});

test("unscaled, hidden terminals and unrelated controls keep their mouse coordinates", t => {
  for (const scale of [1, 0]) {
    const { fire, dispose } = setup(t, scale);
    assert.equal(fire("mousemove").clientX, 75);
    dispose();
  }
  const { fire, outside } = setup(t);
  assert.equal(fire("mousedown", outside).clientX, 75);
  assert.equal(fire("wheel", outside).clientY, 35);
});

test("selection follows a drag outside the terminal, releases on mouseup and removes listeners on disposal", t => {
  const { fire, outside, dispose } = setup(t);
  fire("mousedown");
  assert.equal(fire("mousemove", outside).clientX, 100);
  assert.equal(fire("mouseup", outside).clientX, 100);
  assert.equal(fire("mousemove", outside).clientX, 75);
  fire("mousedown"); // Disposing during a drag must also stop all handlers.
  dispose();
  for (const type of ["mousedown", "mousemove", "mouseup", "wheel"]) {
    for (const target of [undefined, outside]) {
      const event = fire(type, target);
      assert.equal(event.clientX, 75, `${type}: x stays native after disposal`);
      assert.equal(event.clientY, 35, `${type}: y stays native after disposal`);
    }
  }
  dispose(); // Cleanup may safely run more than once.
  assert.equal(fire("mousemove").clientX, 75);
});
