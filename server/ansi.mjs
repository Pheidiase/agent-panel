// Colour for the history reader. `capture-pane -e` returns the pane's text
// with SGR sequences; this turns it into the same plain text the reader has
// always shown plus a compact list of style runs over that text. Only SGR is
// interpreted. Every other escape sequence (OSC hyperlinks, cursor movement)
// is dropped. The plain text is the source of truth: search, anchors and
// copying never see a style.
//
// Result: { text, styles, runs }. `styles` is a table of style keys, `runs` a
// flat [start, length, styleIndex, ...] array in UTF-16 offsets of `text`.
// A colour is "p<0-255>" (palette, themed by the viewer) or "#rrggbb".
export const STYLE_RUN_LIMIT = 80000;

const DEFAULT = Object.freeze({ fg: "", bg: "", b: 0, d: 0, i: 0, u: 0, v: 0, s: 0 });
const hex = (n) => n.toString(16).padStart(2, "0");

function applySgr(state, params) {
  const p = params.length ? params : [0];
  for (let k = 0; k < p.length; k++) {
    const n = p[k];
    if (n === 0) Object.assign(state, DEFAULT);
    else if (n === 1) state.b = 1;
    else if (n === 2) state.d = 1;
    else if (n === 3) state.i = 1;
    else if (n === 4 || n === 21) state.u = 1;
    else if (n === 7) state.v = 1;
    else if (n === 9) state.s = 1;
    else if (n === 22) { state.b = 0; state.d = 0; }
    else if (n === 23) state.i = 0;
    else if (n === 24) state.u = 0;
    else if (n === 27) state.v = 0;
    else if (n === 29) state.s = 0;
    else if (n >= 30 && n <= 37) state.fg = "p" + (n - 30);
    else if (n >= 90 && n <= 97) state.fg = "p" + (n - 82);
    else if (n === 39) state.fg = "";
    else if (n >= 40 && n <= 47) state.bg = "p" + (n - 40);
    else if (n >= 100 && n <= 107) state.bg = "p" + (n - 92);
    else if (n === 49) state.bg = "";
    else if (n === 38 || n === 48 || n === 58) {
      let color = "";
      if (p[k + 1] === 5 && Number.isInteger(p[k + 2])) { color = p[k + 2] >= 0 && p[k + 2] <= 255 ? "p" + p[k + 2] : ""; k += 2; }
      else if (p[k + 1] === 2 && p.length >= k + 5) {
        const [r, g, b] = p.slice(k + 2, k + 5);
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) color = "#" + hex(r) + hex(g) + hex(b);
        k += 4;
      }
      if (n === 38) state.fg = color;
      else if (n === 48) state.bg = color;
    }
  }
}
const keyOf = (s) => (s.fg || s.bg || s.b || s.d || s.i || s.u || s.v || s.s)
  ? `${s.fg}|${s.bg}|${s.b}${s.d}${s.i}${s.u}${s.v}${s.s}` : "";

// One line of escaped text -> its plain characters and [start, end, key] segments.
function parseLine(line, state) {
  let plain = "";
  const segs = [];
  let segStart = 0, segKey = keyOf(state);
  const close = () => { if (segKey && plain.length > segStart) segs.push([segStart, plain.length, segKey]); };
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 0x1b) {
      if (c < 0x20 && c !== 0x09) continue;
      plain += line[i];
      continue;
    }
    const next = line[i + 1];
    if (next === "[") {
      let j = i + 2;
      while (j < line.length && !(line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e)) j++;
      if (j >= line.length) break;
      if (line[j] === "m") {
        const body = line.slice(i + 2, j);
        if (/^[\d;:]*$/.test(body)) {
          const params = body === "" ? [] : body.split(/[;:]/).map((v) => (v === "" ? 0 : Number(v)));
          close();
          applySgr(state, params);
          segStart = plain.length; segKey = keyOf(state);
        }
      }
      i = j;
    } else if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC/DCS/APC/PM: skip to BEL or ST.
      let j = i + 2;
      while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
      i = line[j] === "\x07" ? j : j + 1;
    } else {
      i += 1; // two-byte escape
    }
  }
  close();
  return { plain, segs };
}

export function parseStyled(raw, { limit = Infinity } = {}) {
  const state = { ...DEFAULT };
  const lines = String(raw).split("\n");
  const parsed = lines.map((line) => {
    const { plain, segs } = parseLine(line, state);
    // Match the plain reader: trailing blanks are trimmed per line.
    const trimmed = plain.replace(/[ \t]+$/, "");
    return { plain: trimmed, segs: segs.map(([a, b, k]) => [a, Math.min(b, trimmed.length), k]).filter(([a, b]) => b > a) };
  });
  let text = "", offsets = [];
  parsed.forEach((l, n) => { offsets.push(text.length); text += l.plain + (n < parsed.length - 1 ? "\n" : ""); });
  // Bounded from the top at a line boundary, then trailing whitespace trimmed.
  let shift = 0;
  if (text.length > limit) {
    const cut = text.indexOf("\n", text.length - limit);
    shift = cut < 0 ? text.length - limit : cut + 1;
    text = text.slice(shift);
  }
  text = text.replace(/\s+$/, "");
  const styles = [], index = new Map(), runs = [];
  let tooMany = false;
  parsed.forEach((l, n) => {
    for (const [a, b, key] of l.segs) {
      const start = Math.max(0, offsets[n] + a - shift), end = Math.min(text.length, offsets[n] + b - shift);
      if (end <= start) continue;
      if (runs.length / 3 >= STYLE_RUN_LIMIT) { tooMany = true; return; }
      let id = index.get(key);
      if (id === undefined) { id = styles.length; styles.push(key); index.set(key, id); }
      const last = runs.length - 3;
      if (last >= 0 && runs[last + 2] === id && runs[last] + runs[last + 1] === start) runs[last + 1] += end - start;
      else runs.push(start, end - start, id);
    }
  });
  // Too many runs to send: the plain text alone is still a complete reader.
  return tooMany ? { text, styles: [], runs: [] } : { text, styles, runs };
}
