// Terminal view preferences. Pure logic only: storage and React stay in the
// view. Every value is validated, so a hand-edited or stale record can never
// put the terminal in an unusable state.
export type Density = "comfortable" | "compact" | "focus";
export type CursorStyle = "block" | "bar" | "underline";
export type ComposerSize = "slim" | "full";
export type SendKey = "enter" | "mod-enter";
export type TermPrefs = {
  density: Density;
  fontSize: number;
  lineHeight: number;
  cursor: CursorStyle;
  fit: boolean;
  maxScale: number;
  composer: ComposerSize;
  showStatus: boolean;
  showHints: boolean;
  sendKey: SendKey;
  showComposer: boolean;
  liveScrollback: boolean;
};
export const PREFS_KEY = "panel-term-prefs";
export const FONT_RANGE = { min: 11, max: 22 } as const;
export const SCALE_RANGE = { min: 1, max: 2 } as const;
export const DEFAULT_PREFS: TermPrefs = {
  density: "compact", fontSize: 14, lineHeight: 1.4, cursor: "block", fit: true, maxScale: 1.5,
  composer: "slim", showStatus: true, showHints: true, sendKey: "enter",
  showComposer: true, liveScrollback: true,
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
export function normalizePrefs(raw: unknown): TermPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    density: oneOf(r.density, ["comfortable", "compact", "focus"], d.density),
    fontSize: Math.round(clamp(r.fontSize, FONT_RANGE.min, FONT_RANGE.max, d.fontSize)),
    lineHeight: Math.round(clamp(r.lineHeight, 1.2, 1.6, d.lineHeight) * 10) / 10,
    cursor: oneOf(r.cursor, ["block", "bar", "underline"], d.cursor),
    fit: bool(r.fit, d.fit),
    maxScale: Math.round(clamp(r.maxScale, SCALE_RANGE.min, SCALE_RANGE.max, d.maxScale) * 10) / 10,
    composer: oneOf(r.composer, ["slim", "full"], d.composer),
    showStatus: bool(r.showStatus, d.showStatus),
    showHints: bool(r.showHints, d.showHints),
    sendKey: oneOf(r.sendKey, ["enter", "mod-enter"], d.sendKey),
    showComposer: bool(r.showComposer, d.showComposer),
    liveScrollback: bool(r.liveScrollback, d.liveScrollback),
  };
}
// `read` returns the raw stored string for a key. Legacy single-value keys
// (font size, fit) seed the first record so existing choices are kept.
export function loadPrefs(read: (key: string) => string): TermPrefs {
  let parsed: unknown;
  try { parsed = JSON.parse(read(PREFS_KEY) || "null"); } catch { parsed = null; }
  if (parsed && typeof parsed === "object") return normalizePrefs(parsed);
  const legacyFont = read("panel-font-size"), legacyFit = read("panel-fit");
  return normalizePrefs({
    fontSize: legacyFont ? Number(legacyFont) : undefined,
    fit: legacyFit ? legacyFit === "true" : undefined,
  });
}
export function serializePrefs(prefs: TermPrefs): string {
  return JSON.stringify(normalizePrefs(prefs));
}
// Scale of the terminal inside its frame. Narrow frames shrink the terminal to
// fit its width. Wide frames may enlarge it up to `maxScale`, but an enlarged
// terminal must also fit the frame height so it never starts to scroll. With
// `fitHeight` (desktop) a terminal that is taller than its frame shrinks as
// well, so the bottom of a TUI, where its prompt lives, is never cut off.
export function computeScale(a: { fit: boolean; fitHeight: boolean; maxScale: number; width: number; height: number; availW: number; availH: number }): number {
  if (!a.fit || !a.width || !a.height) return 1;
  const byWidth = Math.min(a.maxScale, a.availW / a.width);
  if (a.fitHeight) return Math.min(byWidth, a.availH / a.height);
  if (byWidth <= 1) return byWidth;
  return Math.max(1, Math.min(byWidth, a.availH / a.height));
}
