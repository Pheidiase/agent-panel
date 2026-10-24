// The server validates titles with String.length (80 UTF-16 units).
export function startTitle(text: string): string {
  const line = text.trim().split("\n")[0].replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  let title = "";
  for (const char of line) {
    if (title.length + char.length > 80) break;
    title += char;
  }
  return title.trim();
}

export const clearSubmitted = (current: string, submitted: string) => current === submitted ? "" : current;

export function radioKeys(event: { key: string; currentTarget: HTMLElement; preventDefault(): void }, ids: string[], current: string, pick: (id: string) => void, schedule = requestAnimationFrame) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if ((!step && event.key !== "Home" && event.key !== "End") || !ids.length) return;
  event.preventDefault();
  const group = event.currentTarget;
  const at = ids.indexOf(current);
  const next = event.key === "Home" ? ids[0] : event.key === "End" ? ids[ids.length - 1] : ids[(at + step! + ids.length) % ids.length];
  pick(next);
  schedule(() => group.querySelector<HTMLElement>(`[data-id="${next}"]`)?.focus());
}

export function closeSuggestions(token: { current: number }, timer: { current: ReturnType<typeof setTimeout> | null }) {
  token.current++;
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
  return { open: false, query: "", start: 0, items: [] as string[], active: 0 };
}

// Retain the operation identity after an uncertain HTTP result; editing any
// creation input starts a new operation. Clear it only after confirmed success.
export function creationAttempt(previous: { signature: string; requestId: string } | null, options: object) {
  const signature = JSON.stringify(options);
  return previous?.signature === signature ? previous : { signature, requestId: crypto.randomUUID() };
}
