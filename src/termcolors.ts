// Terminal palette and the reader's style keys (server/ansi.mjs) as CSS.
// Pure: no React or DOM, so the mapping is unit tested.
export type Styled = { styles?: string[]; runs?: number[] };
// Defter: a dark object on paper — warm, low-saturation ANSI palette.
export const TERM_THEME = {
  background: "#1c1b19", foreground: "#e6e1d6", cursor: "#e6e1d6", cursorAccent: "#1c1b19", selectionBackground: "#3d3a33",
  black: "#1c1b19", red: "#e0705a", green: "#8fbf7f", yellow: "#d9a74a", blue: "#7fa6d9", magenta: "#c48fc7", cyan: "#6fbdbf", white: "#d9d3c7",
  brightBlack: "#6f695d", brightRed: "#ec8d79", brightGreen: "#a7d197", brightYellow: "#e8c06a", brightBlue: "#9bbce6", brightMagenta: "#d6a8d8", brightCyan: "#8fd0d2", brightWhite: "#f2eee4",
};
const T = TERM_THEME;
const BASE16 = [T.black, T.red, T.green, T.yellow, T.blue, T.magenta, T.cyan, T.white,
  T.brightBlack, T.brightRed, T.brightGreen, T.brightYellow, T.brightBlue, T.brightMagenta, T.brightCyan, T.brightWhite];
const LEVELS = [0, 95, 135, 175, 215, 255];
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
export function paletteColor(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) { const i = n - 16; return "#" + hex2(LEVELS[Math.floor(i / 36)]) + hex2(LEVELS[Math.floor(i / 6) % 6]) + hex2(LEVELS[i % 6]); }
  const g = 8 + (n - 232) * 10; return "#" + hex2(g) + hex2(g) + hex2(g);
}
const color = (c: string) => (/^p\d{1,3}$/.test(c) && Number(c.slice(1)) < 256 ? paletteColor(Number(c.slice(1))) : /^#[0-9a-f]{6}$/.test(c) ? c : "");
// Same key format as the server: "fg|bg|bdiuvs".
export type StyleCss = { color?: string; backgroundColor?: string; fontWeight?: number; opacity?: number; fontStyle?: "italic"; textDecoration?: string };
export function styleCss(key: string): StyleCss {
  const [f = "", b = "", flags = ""] = key.split("|");
  let fg = color(f), bg = color(b);
  const [bold, dim, italic, under, inverse, strike] = [...flags].map(c => c === "1");
  if (inverse) { const t = fg || T.foreground; fg = bg || T.background; bg = t; }
  // Bold on a basic colour brightens it, as xterm does by default.
  if (bold && f.startsWith("p") && Number(f.slice(1)) < 8) fg = paletteColor(Number(f.slice(1)) + 8);
  const css: StyleCss = {};
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (bold) css.fontWeight = 650;
  if (dim) css.opacity = 0.62;
  if (italic) css.fontStyle = "italic";
  if (under || strike) css.textDecoration = [under && "underline", strike && "line-through"].filter(Boolean).join(" ");
  return css;
}

