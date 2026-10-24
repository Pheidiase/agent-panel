import { t } from "./i18n";

// Preserve opening order even when a portal/palette occurs earlier in the DOM.
export function dialogStack<T>(previous: T[], visible: T[]) {
  return [...previous.filter(dialog => visible.includes(dialog)), ...visible.filter(dialog => !previous.includes(dialog))];
}

export function installDialogFocus() {
  const selector = '[role="dialog"][aria-modal="true"]';
  const records = new Map<HTMLElement, { back: HTMLElement | null; last: HTMLElement | null; host: HTMLElement; z: string }>();
  const blocked = new Map<HTMLElement, boolean>();
  let stack: HTMLElement[] = [];
  let outside = document.activeElement as HTMLElement | null;
  const visible = (element: HTMLElement) => !!element.getClientRects().length;
  const top = () => stack.at(-1);
  const fields = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter(element => visible(element) && element.tabIndex >= 0);
  const focus = (dialog: HTMLElement) => {
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === t("common.cancel"));
    (records.get(dialog)?.last || dialog.querySelector<HTMLElement>('[data-dialog-initial]') || cancel || fields(dialog)[0] || dialog).focus();
  };
  const unblock = () => { for (const [element, inert] of blocked) element.inert = inert; blocked.clear(); };
  const sync = () => {
    unblock();
    const previousTop = top();
    const next = dialogStack(stack, [...document.querySelectorAll<HTMLElement>(selector)].filter(visible));
    let back: HTMLElement | null = null;
    for (const dialog of [...stack].reverse()) if (!next.includes(dialog)) {
      const record = records.get(dialog)!;
      record.host.style.zIndex = record.z;
      if (dialog === previousTop) back = record.back;
      records.delete(dialog);
    }
    for (const dialog of next) if (!records.has(dialog)) {
      const previous = records.get(previousTop!);
      const host = dialog.closest<HTMLElement>('.modal-overlay, .palette-overlay') || dialog;
      records.set(dialog, { back: previous?.last || outside, last: dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null, host, z: host.style.zIndex });
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    }
    stack = next;
    stack.forEach((dialog, index) => { records.get(dialog)!.host.style.zIndex = String(100 + index * 2); });
    const dialog = top();
    if (dialog) {
      // Inert siblings on the whole ancestor path, including portal siblings.
      // Keep the drawer's pointer-only backdrop available for dismissal.
      let branch: HTMLElement = dialog;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) if (sibling !== branch && sibling instanceof HTMLElement && !sibling.matches('.drawer-backdrop')) {
          blocked.set(sibling, sibling.inert); sibling.inert = true;
        }
        branch = branch.parentElement;
        if (branch === document.body) break;
      }
      if (back?.isConnected && dialog.contains(back)) back.focus();
      if (!dialog.contains(document.activeElement)) focus(dialog);
    } else if (back?.isConnected) back.focus();
  };
  const onFocus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    // React autoFocus may run before the mutation observer registers a new dialog.
    const incoming = target.closest<HTMLElement>(selector);
    if (incoming && !records.has(incoming)) return;
    const dialog = top();
    if (dialog) {
      if (dialog.contains(target)) records.get(dialog)!.last = target;
      else focus(dialog);
    } else outside = target;
  };
  const onKey = (event: KeyboardEvent) => {
    const dialog = top();
    if (!dialog) return;
    if (event.key === "Escape") {
      const close = dialog.querySelector<HTMLButtonElement>(`[data-dialog-close], .modal-close, button[aria-label="${t("dialog.closeShort")}"], button[aria-label="${t("dialog.closeWindow")}"]`)
        || [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === t("common.cancel"));
      // Palettes can handle Escape themselves when they have no close button.
      if (close) { event.preventDefault(); event.stopImmediatePropagation(); close.click(); }
    } else if (event.key === "Tab") {
      const list = fields(dialog), first = list[0], last = list.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !list.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !list.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first.focus();
      }
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal"] });
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("keydown", onKey, true);
  sync();
  return () => {
    observer.disconnect(); unblock();
    for (const record of records.values()) record.host.style.zIndex = record.z;
    document.removeEventListener("focusin", onFocus, true); window.removeEventListener("keydown", onKey, true);
  };
}
