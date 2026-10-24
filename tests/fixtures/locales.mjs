// Çekirdek sözlükler artı varsa isteğe bağlı modül sözlükleri (src/locales/modules/*-tr.ts, *-en.ts).
import fs from "node:fs";
import path from "node:path";
import { clientModules } from "./client-modules.mjs";

const modules = path.resolve(import.meta.dirname, "../../src/locales/modules");
export function loadLocales(load = clientModules()) {
  const tr = { ...load("locales/tr.ts").default }, en = { ...load("locales/en.ts").default };
  for (const file of fs.existsSync(modules) ? fs.readdirSync(modules).sort() : []) {
    if (file.endsWith("-tr.ts")) Object.assign(tr, load(`locales/modules/${file}`).default);
    if (file.endsWith("-en.ts")) Object.assign(en, load(`locales/modules/${file}`).default);
  }
  return { tr, en };
}
// server/optional/*.mjs hata kodlarını yükleme sırasında kaydeder; kod-çeviri testleri önce bunları yükler.
export async function loadOptionalServerModules() {
  const dir = path.resolve(import.meta.dirname, "../../server/optional");
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
    if (file.endsWith(".mjs")) await import(path.join(dir, file));
}
