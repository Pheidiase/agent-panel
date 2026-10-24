import { getLocale, t } from "./i18n";
// Kenar çubuğu bölümleri (tasarım v5): Dikkat, Sabitlenenler, Açık, Bugün.
// Her oturum en çok bir bölümde görünür; arşivdekiler hiç görünmez. Saf veri
// kodu (JSX/DOM yok); Node altında birim testiyle de çalışır.
export type SidebarSession = {
  id: string;
  title: string;
  status: "running" | "ended" | "unavailable";
  archived?: boolean;
  pinned?: boolean;
  createdAt: string;
  lastOpenedAt?: string;
  endedAt?: string;
  connection?: string;
};
// Kullanıcıdan bir şey bekleyen oturum: bekleyen onay/soru ya da okunmamış hata.
export type SidebarWait = { sessionId: string; type: "approval" | "question" | "error"; expiresAt: string | null };
export type SidebarGroups<S extends SidebarSession> = {
  attention: S[];
  pinned: S[];
  open: S[];
  today: S[];
  // Bugünden önce biten, kenar çubuğunda gösterilmeyen oturum sayısı.
  older: number;
};

const stamp = (s: SidebarSession) => Date.parse(s.lastOpenedAt || s.createdAt) || 0;
const newestFirst = (a: SidebarSession, b: SidebarSession) => stamp(b) - stamp(a);
const deadline = (w: SidebarWait | undefined) => (w?.expiresAt ? Date.parse(w.expiresAt) : Infinity);

function sameDay(iso: string | undefined, now: Date) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function groupSidebar<S extends SidebarSession>(
  sessions: S[],
  waits: SidebarWait[],
  now: Date,
  query = "",
  limit = 25,
): SidebarGroups<S> {
  const needle = query.trim().toLocaleLowerCase(getLocale());
  const firstWait = new Map<string, SidebarWait>();
  for (const w of waits) {
    const had = firstWait.get(w.sessionId);
    if (!had || deadline(w) < deadline(had)) firstWait.set(w.sessionId, w);
  }
  const groups: SidebarGroups<S> = { attention: [], pinned: [], open: [], today: [], older: 0 };
  for (const s of sessions) {
    if (s.archived || (needle && !s.title.toLocaleLowerCase(getLocale()).includes(needle))) continue;
    if (firstWait.has(s.id)) groups.attention.push(s);
    else if (s.pinned) groups.pinned.push(s);
    else if (s.status === "running") groups.open.push(s);
    else if (sameDay(s.endedAt || s.lastOpenedAt || s.createdAt, now)) groups.today.push(s);
    else groups.older++;
  }
  groups.attention.sort((a, b) => deadline(firstWait.get(a.id)) - deadline(firstWait.get(b.id)) || newestFirst(a, b));
  groups.pinned.sort(newestFirst);
  groups.open.sort(newestFirst);
  groups.today.sort(newestFirst);
  groups.open = groups.open.slice(0, limit);
  groups.today = groups.today.slice(0, limit);
  return groups;
}

// Sohbet oturumunda ajan şu an tur yürütüyor mu? Terminal oturumları bu
// bilgiyi taşımaz; onlar için yalnız "açık" bilinir.
export const isWorking = (s: SidebarSession) => s.connection === "running" || s.connection === "attention";

// "şimdi", "12 dk", "3 sa", "2 gün" biçiminde kısa geçen süre.
export function shortAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return t("time.now");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("time.minutes", { count: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  return t("time.days", { count: Math.floor(hours / 24) });
}
