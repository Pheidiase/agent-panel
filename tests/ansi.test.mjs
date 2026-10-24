import test from "node:test";
import assert from "node:assert/strict";
import { parseStyled, STYLE_RUN_LIMIT } from "../server/ansi.mjs";

const styleAt = (r, at) => {
  for (let k = 0; k < r.runs.length; k += 3) if (at >= r.runs[k] && at < r.runs[k] + r.runs[k + 1]) return r.styles[r.runs[k + 2]];
  return "";
};

test("ansi: plain text matches the uncoloured reader text", () => {
  const raw = "\x1b[38;5;73m╭──╮\x1b[39m   \n\x1b[1mBold\x1b[0m tail  \t\n\n\n";
  const r = parseStyled(raw);
  assert.equal(r.text, "╭──╮\nBold tail");
  assert.equal(styleAt(r, 0), "p73||000000");
  assert.equal(styleAt(r, 5), "||100000");
  assert.equal(styleAt(r, 10), "");
});

test("ansi: state carries across lines and resets clear it", () => {
  const r = parseStyled("\x1b[31mred\nstill red\x1b[0m plain");
  assert.equal(r.text, "red\nstill red plain");
  assert.equal(styleAt(r, 4), "p1||000000");
  assert.equal(styleAt(r, r.text.length - 1), "");
  // The newline itself is never styled; the two lines are separate runs.
  assert.equal(styleAt(r, 3), "");
});

test("ansi: 16/256/truecolour, background and attribute codes", () => {
  const r = parseStyled("\x1b[92ma\x1b[48;5;236mb\x1b[38;2;255;0;16mc\x1b[2;3;4;7;9md\x1b[22;23;24;27;29;39;49me");
  assert.equal(r.text, "abcde");
  assert.equal(styleAt(r, 0), "p10||000000");
  assert.equal(styleAt(r, 1), "p10|p236|000000");
  assert.equal(styleAt(r, 2), "#ff0010|p236|000000");
  assert.equal(styleAt(r, 3), "#ff0010|p236|011111");
  assert.equal(styleAt(r, 4), "");
});

test("ansi: non-SGR escapes and control characters are dropped", () => {
  const r = parseStyled("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[2Kx\x07y\x1b=z\x1b]0;title\x07!");
  assert.equal(r.text, "link xyz!");
  assert.deepEqual(r.runs, []);
});

test("ansi: trailing blanks are trimmed and runs never pass the text", () => {
  const r = parseStyled("\x1b[7mbar   \x1b[0m\nnext");
  assert.equal(r.text, "bar\nnext");
  assert.deepEqual(r.runs, [0, 3, 0]);
});

test("ansi: limit cuts from the top at a line boundary and shifts runs", () => {
  const r = parseStyled("old line\n\x1b[31mkeep\x1b[0m this", { limit: 12 });
  assert.equal(r.text, "keep this");
  assert.equal(styleAt(r, 0), "p1||000000");
  assert.equal(styleAt(r, 5), "");
});

test("ansi: adjacent runs of one style merge; an excess drops colour, not text", () => {
  const merged = parseStyled("\x1b[31ma\x1b[31mb\x1b[0m");
  assert.deepEqual(merged.runs, [0, 2, 0]);
  const many = Array.from({ length: STYLE_RUN_LIMIT + 5 }, (_, i) => `\x1b[3${i % 2 + 1}mx`).join("");
  const r = parseStyled(many);
  assert.equal(r.text.length, STYLE_RUN_LIMIT + 5);
  assert.deepEqual(r.runs, []);
});
