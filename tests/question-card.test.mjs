// Render the actual TSX in memory, using the installed TypeScript and React.
// This catches valid protocol ids accidentally resolving Object.prototype
// members before the user can interact with the question form.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "@typescript/typescript6";
import { clientModules } from "./fixtures/client-modules.mjs";

const source = fs.readFileSync(new URL("../src/QuestionCard.tsx", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  fileName: "QuestionCard.tsx",
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const modules = clientModules({ react: React });
modules("i18n.ts").setLanguage("tr");
const uxExports = modules("ux-state.ts");
const exports = {};
new Function("require", "exports", js)(name => name.endsWith(".css") ? {} : name === "./ux-state" ? uxExports : name === "./i18n" ? modules("i18n.ts") : createRequire(import.meta.url)(name), exports);

test("question card: protocol ids matching prototype properties render as ordinary questions", () => {
  const questions = ["constructor", "toString", "__proto__"].map((id, index) => ({
    id,
    header: id,
    question: `Soru ${index + 1}?`,
    options: [{ label: "A" }, { label: "B" }],
    multiSelect: index === 1,
    isOther: true,
  }));
  const markup = renderToStaticMarkup(React.createElement(exports.QuestionCard, {
    questions, status: "requested", onAnswer() {}, onReject() {},
  }));
  assert.equal((markup.match(/<fieldset/g) || []).length, 3);
  assert.equal((markup.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((markup.match(/type="radio"/g) || []).length, 6);
  assert.ok(!markup.includes(" checked="), "prototype properties must not preselect an answer");
  assert.ok(!markup.includes("<textarea"), "prototype properties must not open the custom-answer field");
});
