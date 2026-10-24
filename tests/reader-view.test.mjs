import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clientModules } from "./fixtures/client-modules.mjs";

const load = clientModules();
load("i18n.ts").setLanguage("tr");
const { buildBlocks, dayLabel, toolSummary, resultMeta } = await load("convblocks.ts");
const { paletteColor, styleCss, TERM_THEME } = await load("termcolors.ts");

const now = new Date(2026, 9, 10, 18, 0);
const at = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
const u = (id, d, h, text = "soru") => ({ id, role: "user", kind: "text", text, time: at(d, h) });
const a = (id, d, h, text = "yanıt") => ({ id, role: "assistant", kind: "text", text, time: at(d, h) });
const t = (id, d, h, name = "Bash", extra = {}) => ({ id, role: "assistant", kind: "tool", name, summary: "ls", result: "", time: at(d, h), ...extra });

test("conv blocks: consecutive tools fold, day separators mark new days", () => {
  const blocks = buildBlocks([u("u1", 9, 10), t("t1", 9, 10), t("t2", 9, 10, "Read"), a("a1", 9, 11), u("u2", 10, 9), a("a2", 10, 9)], now);
  assert.deepEqual(blocks.map((b) => b.type), ["day", "msg", "tools", "msg", "day", "msg", "msg"]);
  assert.equal(blocks[0].label, "Dün");
  assert.equal(blocks[4].label, "Bugün");
  assert.deepEqual(blocks[2].items.map((i) => i.index), [1, 2]);
});

test("conv blocks: only the reply that closes a turn is its end", () => {
  const blocks = buildBlocks([u("u1", 10, 9), a("a1", 10, 9), t("t1", 10, 9), a("a2", 10, 9), u("u2", 10, 10), a("a3", 10, 10)], now)
    .filter((b) => b.type === "msg" && b.entry.role === "assistant");
  assert.deepEqual(blocks.map((b) => [b.entry.id, b.last]), [["a1", false], ["a2", true], ["a3", true]]);
});

test("conv blocks: entries without a valid time never invent a day", () => {
  const blocks = buildBlocks([{ ...u("u1", 10, 9), time: null }, { ...a("a1", 10, 9), time: "bozuk" }], now);
  assert.deepEqual(blocks.map((b) => b.type), ["msg", "msg"]);
});

test("conv labels: day names, tool summary and result meta", () => {
  assert.equal(dayLabel(new Date(2026, 9, 10, 1), now), "Bugün");
  assert.match(dayLabel(new Date(2026, 9, 1), now), /1 Ekim/);
  assert.match(dayLabel(new Date(2025, 9, 1), now), /2025/);
  assert.equal(toolSummary([{ entry: t("1", 1, 1) }, { entry: t("2", 1, 1, "Read") }, { entry: t("3", 1, 1) }]), "Bash ×2 · Read");
  assert.equal(resultMeta({ isError: true, result: "x" }), "hata");
  assert.equal(resultMeta({ result: "a\nb\nc", truncated: true }), "3+ satır");
  assert.equal(resultMeta({ result: "tek" }), "");
});

test("term colours: palette and style keys", () => {
  assert.equal(paletteColor(1), TERM_THEME.red);
  assert.equal(paletteColor(16), "#000000");
  assert.equal(paletteColor(231), "#ffffff");
  assert.equal(paletteColor(196), "#ff0000");
  assert.equal(paletteColor(232), "#080808");
  assert.deepEqual(styleCss("p1||000000"), { color: TERM_THEME.red });
  // Bold brightens a basic colour, like xterm.
  assert.deepEqual(styleCss("p1||100000"), { color: TERM_THEME.brightRed, fontWeight: 650 });
  // Inverse swaps against the theme defaults when a side is unset.
  assert.deepEqual(styleCss("||000010"), { color: TERM_THEME.background, backgroundColor: TERM_THEME.foreground });
  assert.deepEqual(styleCss("#12ab34|p236|011101"), { color: "#12ab34", backgroundColor: "#303030", opacity: 0.62, fontStyle: "italic", textDecoration: "underline line-through" });
  assert.deepEqual(styleCss("javascript:x|url(x)|000000"), {});
});
