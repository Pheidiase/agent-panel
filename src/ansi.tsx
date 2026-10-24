// Coloured history text. The server sends the plain reader text plus style
// runs (server/ansi.mjs); this paints them with the live terminal's palette.
// Text nodes stay in document order and add up to exactly the plain text, so
// the reader's anchoring and search offsets are unaffected by colour.
import React from "react";
import { styleCss, type Styled } from "./termcolors";
export { TERM_THEME, type Styled } from "./termcolors";

// Splits `text` at style and match boundaries. A match that crosses colours is
// several <mark>s sharing one data-match index.
// `glyphs` may replace a plain piece with its own nodes (same characters).
export function renderStyled(text: string, styled: Styled, matches: number[], matchLength: number, current: number, glyphs?: (piece: string, at: number) => React.ReactNode): React.ReactNode[] {
  const runs = styled.runs || [], styles = styled.styles || [];
  const css = styles.map(styleCss);
  const cuts = new Set<number>([0, text.length]);
  for (let k = 0; k < runs.length; k += 3) { cuts.add(runs[k]); cuts.add(Math.min(text.length, runs[k] + runs[k + 1])); }
  for (const m of matches) { cuts.add(m); cuts.add(Math.min(text.length, m + matchLength)); }
  const points = [...cuts].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  let r = 0, m = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (b <= a) continue;
    while (r < runs.length && runs[r] + runs[r + 1] <= a) r += 3;
    while (m < matches.length && matches[m] + matchLength <= a) m++;
    const style = r < runs.length && runs[r] <= a ? css[runs[r + 2]] : undefined;
    const inMatch = m < matches.length && matches[m] <= a;
    const plain = text.slice(a, b), piece = glyphs ? glyphs(plain, a) : plain;
    const node = style ? <span key={`s${a}`} style={style}>{piece}</span> : piece;
    out.push(inMatch ? <mark key={`m${a}`} data-match={m} className={m === current ? "current-match" : ""}>{node}</mark> : style ? node : <React.Fragment key={`t${a}`}>{piece}</React.Fragment>);
  }
  return out;
}

// Box drawing for the live backlog. Geist Mono has no box glyphs and fallback
// fonts do not fill the cell, so lines break apart; like xterm, each glyph is
// drawn edge to edge over its cell. The character stays in the text (copy and
// search see it) but is painted transparent. l/r/u/d are the arms; 1 light,
// 2 heavy, 3 double.
const BOX: Record<string, string> = {
  "─": "l1r1", "│": "u1d1", "┌": "r1d1", "┐": "l1d1", "└": "r1u1", "┘": "l1u1", "├": "u1d1r1", "┤": "u1d1l1",
  "┬": "l1r1d1", "┴": "l1r1u1", "┼": "l1r1u1d1", "╭": "r1d1", "╮": "l1d1", "╰": "r1u1", "╯": "l1u1",
  "╴": "l1", "╵": "u1", "╶": "r1", "╷": "d1",
  "━": "l2r2", "┃": "u2d2", "┏": "r2d2", "┓": "l2d2", "┗": "r2u2", "┛": "l2u2", "┣": "u2d2r2", "┫": "u2d2l2",
  "┳": "l2r2d2", "┻": "l2r2u2", "╋": "l2r2u2d2",
  "═": "l3r3", "║": "u3d3", "╔": "r3d3", "╗": "l3d3", "╚": "r3u3", "╝": "l3u3", "╠": "u3d3r3", "╣": "u3d3l3",
  "╦": "l3r3d3", "╩": "l3r3u3", "╬": "l3r3u3d3",
};
const BOX_RE = new RegExp(`[${Object.keys(BOX).join("")}]+`, "g");
const boxCss = new Map<string, React.CSSProperties>();
function boxStyle(spec: string): React.CSSProperties {
  let css = boxCss.get(spec);
  if (css) return css;
  const line = "linear-gradient(currentColor, currentColor)", images: string[] = [], sizes: string[] = [], positions: string[] = [];
  for (let i = 0; i < spec.length; i += 2) {
    const arm = spec[i], weight = Number(spec[i + 1]), across = arm === "l" || arm === "r";
    const t = weight === 2 ? "2px" : "1px";
    const size = across ? `calc(50% + ${t}) ${t}` : `${t} calc(50% + ${t})`;
    const at = { l: "left", r: "right", u: "top", d: "bottom" }[arm]!;
    const offsets = weight === 3 ? ["- 2px", "+ 1px"] : ["+ 0px"];
    for (const o of offsets) {
      images.push(line); sizes.push(size);
      positions.push(across ? `${at} calc(50% ${o})` : `calc(50% ${o}) ${at}`);
    }
  }
  css = { backgroundImage: images.join(","), backgroundSize: sizes.join(","), backgroundPosition: positions.join(","), backgroundRepeat: "no-repeat" };
  boxCss.set(spec, css);
  return css;
}
export function boxGlyphs(piece: string, at: number): React.ReactNode {
  BOX_RE.lastIndex = 0;
  if (!BOX_RE.test(piece)) return piece;
  BOX_RE.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of piece.matchAll(BOX_RE)) {
    if (m.index! > last) out.push(piece.slice(last, m.index));
    for (let i = 0; i < m[0].length;) {
      const start = i, char = m[0][i++];
      // A horizontal rule needs one background across the whole run, rather
      // than hundreds of elements. Keep corners and junctions in single cells.
      if (char === "─" || char === "━" || char === "═") while (m[0][i] === char) i++;
      const count = i - start;
      const style = count === 1 ? boxStyle(BOX[char]) : { ...boxStyle(BOX[char]), width: `calc(var(--cell-w, 1ch) * ${count})` };
      out.push(<span key={`b${at + m.index! + start}`} className="bx" style={style}>{m[0].slice(start, i)}</span>);
    }
    last = m.index! + m[0].length;
  }
  if (last < piece.length) out.push(piece.slice(last));
  return out;
}
