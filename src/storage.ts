import { t } from "./i18n";

// Session drafts also live in memory: disabled/full storage must not lose a
// first message, or leave a consumed autosend marker behind.
const sessionValues = new Map<string, string>();
let sessionFailed = false;
let privateCleared = false;
const privateKey = (key: string) => (key === "panel-start-draft" || /^panel-(draft|comments|autosend)-/.test(key));
export const storageWarning = () => t("storage.warning");
export const sessionStorageFailed = () => sessionFailed;
export function stored(key: string, fallback = "", session = false) {
  if (session && privateCleared && privateKey(key)) return fallback;
  if (session && sessionValues.has(key)) return sessionValues.get(key)!;
  try { return (session ? sessionStorage : localStorage).getItem(key) ?? fallback; } catch { return fallback; }
}
export function remember(key: string, value: string, session = false) {
  if (session && privateCleared && privateKey(key)) return false;
  if (session) sessionValues.set(key, value);
  try { (session ? sessionStorage : localStorage).setItem(key, value); return true; }
  catch { if (session) sessionFailed = true; return false; }
}

export function clearPrivateStorage() {
  privateCleared = true; // Unmount effects and pending requests cannot restore old drafts.
  sessionValues.clear();
  try {
    for (const key of Object.keys(sessionStorage)) if (privateKey(key)) sessionStorage.removeItem(key);
  } catch { sessionFailed = true; }
}
