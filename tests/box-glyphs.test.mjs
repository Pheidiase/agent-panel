import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "@typescript/typescript6";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function compile(name, dependencies = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", js)(name => dependencies[name] || require(name), exports);
  return exports;
}
const colors = compile("termcolors.ts");
const { boxGlyphs, renderStyled } = compile("ansi.tsx", { "./termcolors": colors });
const markup = node => renderToStaticMarkup(React.createElement(React.Fragment, null, node));
const text = html => html.replace(/<[^>]*>/g, "");

test("long terminal rules stay bounded and preserve every copied character", () => {
  const rule = "─".repeat(120);
  const source = Array.from({ length: 5000 }, () => rule).join("\n");
  const html = markup(boxGlyphs(source, 0));
  assert.equal((html.match(/class="bx"/g) || []).length, 5000);
  assert.equal(text(html), source);
  assert.ok(html.includes("width:calc(var(--cell-w, 1ch) * 120)"));
});

test("corners, junctions and different line weights keep their cell positions", () => {
  const source = "╭──┬━━╮\n│  │  │\n╰══╧──╯";
  const html = markup(boxGlyphs(source, 17));
  assert.equal(text(html), source);
  assert.match(html, /class="bx"[^>]*>╭<\/span>/);
  for (const rule of ["──", "━━", "══"]) assert.ok(html.includes(`>${rule}</span>`));
});

test("a rule crossing colour boundaries retains both colours and exact text", () => {
  const source = "────────";
  const html = markup(renderStyled(source, { styles: ["p1||000000", "p2||000000"], runs: [0, 4, 0, 4, 4, 1] }, [], 0, -1, boxGlyphs));
  assert.equal(text(html), source);
  assert.equal((html.match(/class="bx"/g) || []).length, 2);
  assert.ok(html.includes(colors.styleCss("p1||000000").color));
  assert.ok(html.includes(colors.styleCss("p2||000000").color));
});

test("successive pieces never inherit the global regex cursor", () => {
  for (const source of ["prefix ──", "plain", "│", "── suffix", "┌──┐"]) {
    assert.equal(text(markup(boxGlyphs(source, 0))), source);
  }
});
