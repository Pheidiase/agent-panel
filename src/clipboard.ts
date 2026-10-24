// Both clipboard paths must confirm success before the UI says "copied".
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Try the legacy API. */ }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try { area.select(); return document.execCommand("copy"); }
  catch { return false; }
  finally { area.remove(); previous?.focus(); }
}
