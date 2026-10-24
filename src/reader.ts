// Keep an explicit snapshot refresh attached to text, not to a percentage of
// a growing scroll area. Ambiguous or missing context must never move a reader.
export type TextAnchor = { context: string; offset: number; at: number };
export function textAnchor(text: string, at: number): TextAnchor {
  at = Math.max(0, Math.min(at, Math.max(0, text.length - 1)));
  const start = Math.max(0, at - 160), end = Math.min(text.length, at + 240);
  return { context: text.slice(start, end), offset: at - start, at };
}
export function locateAnchor(text: string, anchor: TextAnchor): number | null {
  if (!anchor.context) return null;
  // Same-position repeated blocks are safe only if the surrounding context
  // has a unique occurrence; otherwise retain the existing snapshot.
  const first = text.indexOf(anchor.context);
  if (first < 0 || text.indexOf(anchor.context, first + 1) >= 0) return null;
  return first + anchor.offset;
}
export function characterRect(element: HTMLElement, at: number): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (at < length) {
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      if (rect.height) return rect;
    }
    at -= length;
  }
  return null;
}
export function visibleAnchor(element: HTMLElement, text: string) {
  const top = element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop);
  let low = 0, high = Math.max(0, text.length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const rect = characterRect(element, middle);
    if (!rect || rect.bottom < top) low = middle + 1;
    else high = middle;
  }
  const rect = characterRect(element, low);
  return { ...textAnchor(text, low), pixel: rect ? rect.top - element.getBoundingClientRect().top : 0 };
}
