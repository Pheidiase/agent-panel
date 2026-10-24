// xterm 6 divides client coordinates by unscaled cell dimensions. Our CSS
// transform preserves PTY geometry, so translate mouse events back into that
// coordinate space before xterm sees them. Keep native events/default actions;
// only these per-event getters change, without touching xterm internals.
export function bindTerminalMouseCoordinates(element: HTMLElement, screen: HTMLElement) {
  const document = element.ownerDocument;
  let dragging = false;
  const normalize = (event: MouseEvent) => {
    const inside = event.target instanceof Node && element.contains(event.target);
    if (event.type === "mousedown") dragging = inside && event.button === 0;
    const active = inside || dragging;
    if (event.type === "mouseup") dragging = false;
    if (!active) return;
    const rect = screen.getBoundingClientRect();
    const scaleX = rect.width / screen.offsetWidth, scaleY = rect.height / screen.offsetHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return;
    if (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001) return;
    Object.defineProperties(event, {
      clientX: { configurable: true, value: rect.left + (event.clientX - rect.left) / scaleX },
      clientY: { configurable: true, value: rect.top + (event.clientY - rect.top) / scaleY },
    });
  };
  // Selection continues outside the terminal until mouseup. Remove every
  // listener on disposal, including when switching sessions.
  const events = ["mousedown", "mousemove", "mouseup", "wheel"] as const;
  // Use object-form capture for removal too: Node 22's EventTarget does not
  // match a boolean `true` removal to a listener added with capture: true.
  const options = { capture: true, passive: true };
  for (const type of events) document.addEventListener(type, normalize, options);
  return () => {
    for (const type of events) document.removeEventListener(type, normalize, options);
  };
}
