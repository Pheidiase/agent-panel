import { useSyncExternalStore } from "react";
import { stored, remember } from "./storage";
import tr from "./locales/tr";
import en from "./locales/en";

export type Language = "tr" | "en";
export type LanguagePreference = Language | "auto";
// İsteğe bağlı modüller anahtarlarını `declare module "../../i18n"` ile buraya ekler.
export interface OptionalTranslations {}
export type TranslationKey = keyof typeof en | keyof OptionalTranslations;
// Çekirdek kodun, modül yokken türde bulunmayan anahtarı kullanabilmesi için; varlığını modül testi doğrular.
export const optionalKey = (key: string) => key as TranslationKey;
export type TranslationParams = Record<string, string | number>;
export const LANGUAGE_KEY = "panel-language";
const dictionaries: Record<Language, Record<string, string>> = { tr, en };
const english: Record<string, string> = en;
// İsteğe bağlı modül sözlükleri (locales/modules/*-tr.ts, *-en.ts) mevcut sözlüğe eklenir; dosya yoksa bir şey değişmez.
type OptionalDictionaries = Record<string, { default: Record<string, string> }>;
const addOptional = (modules: OptionalDictionaries, target: Record<string, string>) => { for (const module of Object.values(modules)) Object.assign(target, module.default); };
addOptional(import.meta.glob<{ default: Record<string, string> }>("./locales/modules/*-tr.ts", { eager: true }), dictionaries.tr);
addOptional(import.meta.glob<{ default: Record<string, string> }>("./locales/modules/*-en.ts", { eager: true }), dictionaries.en);
const listeners = new Set<() => void>();
const warned = new Set<string>();
const normalize = (value: string): LanguagePreference => value === "tr" || value === "en" ? value : "auto";
let preference = normalize(stored(LANGUAGE_KEY, "auto"));
export function getLanguage(): Language {
  return preference === "auto" ? (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en") : preference;
}
export const getLocale = () => getLanguage() === "tr" ? "tr-TR" : "en-US";
function update() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = getLanguage();
    document.title = t("main.documentTitle");
  }
  listeners.forEach(listener => listener());
}
export function setLanguage(value: LanguagePreference) {
  preference = normalize(value);
  remember(LANGUAGE_KEY, preference);
  update();
}
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", update);
  window.addEventListener("storage", event => {
    if (event.key === LANGUAGE_KEY || event.key === null) {
      preference = normalize(stored(LANGUAGE_KEY, "auto"));
      update();
    }
  });
}
update();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const snapshot = () => `${preference}:${getLanguage()}`;
export function useI18n() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { t, language: getLanguage(), locale: getLocale(), preference, setLanguage };
}
export function t(key: TranslationKey, params: TranslationParams = {}): string {
  const singular = `${key}.one`;
  const lookup = params.count === 1 && Object.hasOwn(english, singular) ? singular as TranslationKey : key;
  const dictionary = dictionaries[getLanguage()];
  if (!Object.hasOwn(dictionary, lookup) && import.meta.env?.DEV && !warned.has(lookup)) {
    warned.add(lookup);
    console.warn(`[i18n] Missing translation: ${lookup}`);
  }
  const value = Object.hasOwn(dictionary, lookup) ? dictionary[lookup] : Object.hasOwn(english, lookup) ? english[lookup] : key;
  return value.replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}
export type Message = { key: TranslationKey; params?: TranslationParams };
export type ServerFailure = { code?: string; error?: string; message?: string; retryAfter?: number };
export type UiMessage = string | Message | ServerFailure | { reason: string };
// Store only descriptors/raw failures; resolve them in the current render.
export function messageText(value: UiMessage): string {
  if (typeof value === "string") return value;
  if ("key" in value) return t(value.key, value.params);
  if ("reason" in value) return socketError(value.reason);
  return serverError({ ...value, error: value.error || value.message });
}
export const messageError = (key: TranslationKey, params?: TranslationParams) => Object.assign(new Error(), { key, params });
export const formatPercent = (value: number) => new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
// Unknown/older servers retain their original error text.
export function serverError(value: { code?: string; error?: string; retryAfter?: number }, fallback = t("main.operationFailed")) {
  const key = `server.${value.code}`;
  return value.code && Object.hasOwn(english, key) ? t(key as TranslationKey, { count: value.retryAfter ?? 1 }) : value.error || fallback;
}
// Keep the numeric WebSocket close code for lifecycle handling. The reason
// carries a stable text code followed by the legacy human-readable message.
export function socketError(reason: string) {
  const separator = reason.indexOf("|");
  return separator < 0 ? reason : serverError({ code: reason.slice(0, separator), error: reason.slice(separator + 1) }, reason);
}
