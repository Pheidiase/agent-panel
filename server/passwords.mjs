import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
export const CURRENT_SCRYPT = Object.freeze({ version: 2, N: 16384, r: 8, p: 5 });
const LEGACY_SCRYPT = Object.freeze({ version: 1, N: 16384, r: 8, p: 1 });
let active = 0;

export function passwordProfile(record) {
  const profile = record?.scrypt;
  if (profile === undefined) return LEGACY_SCRYPT;
  if ([LEGACY_SCRYPT, CURRENT_SCRYPT].some(p => profile && typeof profile === "object" && !Array.isArray(profile) && Object.keys(profile).length === 4 && Object.keys(p).every(k => p[k] === profile[k]))) return profile;
  throw Object.assign(new Error("Parola kaydı okunamadı."), { status: 503, code: "AUTH_INVALID" });
}
export async function derivePassword(password, salt, profile = CURRENT_SCRYPT) {
  // Bound memory/CPU across both login and administration, including rehashes.
  if (active >= 4) throw Object.assign(new Error("Parola işlemleri meşgul. Tekrar dene."), { status: 429, retryAfter: 1, code: "LOGIN_LIMITED" });
  active++;
  try { return await scrypt(password, salt, 64, { N: profile.N, r: profile.r, p: profile.p, maxmem: 32 * 1024 * 1024 }); }
  finally { active--; }
}
export async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await derivePassword(password, salt)).toString("hex"), scrypt: { ...CURRENT_SCRYPT } };
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 200)
    throw Object.assign(new Error("Şifre 12–200 karakter olmalı."), { status: 400, code: "PASSWORD_INVALID" });
  return password;
}
