import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "@typescript/typescript6";

const js = ts.transpileModule(fs.readFileSync(new URL("../src/reader.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { textAnchor, locateAnchor } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const text = Array.from({ length: 1000 }, (_, i) => `Satır ${i}: Türkçe çıktı — sabit okuma konumu.`).join("\n");

test("reader: appended output leaves the visible character anchored", () => {
  const at = text.indexOf("Satır 500") + 18;
  assert.equal(locateAnchor(text + "\nYeni çıktı", textAnchor(text, at)), at);
});
test("reader: trimmed scrollback shifts the offset but preserves the text", () => {
  const at = text.indexOf("Satır 500") + 18;
  const cut = text.indexOf("Satır 100");
  assert.equal(locateAnchor(text.slice(cut), textAnchor(text, at)), at - cut);
});
test("reader: redraw replacing the visible content cannot relocate it", () => {
  assert.equal(locateAnchor("Tamamen başka bir terminal ekranı", textAnchor(text, 2000)), null);
});
test("reader: repeated status output and empty snapshots are ambiguous", () => {
  const repeated = "Onay bekleniyor\n".repeat(300);
  assert.equal(locateAnchor(repeated, textAnchor(repeated, 2000)), null);
  assert.equal(locateAnchor("", textAnchor("", 0)), null);
});
