export type ChatEvent = { seq: number; kind: string; [key: string]: unknown };

const MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder();

// Keep the newest text, starting at a whole UTF-8 character. Apply this while
// merging too, so a single replay batch cannot build an unbounded answer.
function textTail(text: string) {
  const bytes = encoder.encode(text);
  if (bytes.length <= MESSAGE_MAX_BYTES) return text;
  let start = bytes.length - MESSAGE_MAX_BYTES;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}

export function retainChatEvents(source: ChatEvent[]) {
  const events: ChatEvent[] = [], chunks = new Map<string, ChatEvent>();
  let truncated = false;
  function limitText(event: ChatEvent) {
    if (typeof event.text !== "string") return;
    const text = textTail(event.text);
    if (text !== event.text) { event.text = text; truncated = true; }
  }
  for (const original of source) {
    const event = { ...original };
    limitText(event);
    if (event.kind === "user") chunks.clear();
    if (["assistant", "thought"].includes(event.kind) && typeof event.id === "string") {
      const key = `${event.kind}:${event.id}`, previous = chunks.get(key);
      if (previous) {
        previous.text = String(previous.text ?? "") + String(event.text ?? "");
        limitText(previous);
        continue;
      }
      chunks.set(key, event);
    }
    events.push(event);
  }
  let cut = 0;
  if (events.length > 4000) {
    const target = events.length - 3000;
    for (let index = 0; index <= target; index++) if (events[index].kind === "user") cut = index;
  }
  // Prefer whole turns for count-based trimming. The byte budget below may
  // also trim an active turn, with an incomplete-history notice to the viewer.
  if (!cut && events.length > 12000) cut = events.length - 9000;
  // Include nested tool content and metadata, not only message text. Retain a
  // contiguous tail; an exceptional oversized event is omitted as a whole.
  const sizes = events.map(event => encoder.encode(JSON.stringify(event)).length + 1);
  let bytes = 2;
  for (let index = cut; index < events.length; index++) bytes += sizes[index];
  while (bytes > HISTORY_MAX_BYTES && cut < events.length) bytes -= sizes[cut++];
  return { events: events.slice(cut), truncated: truncated || cut > 0 };
}
