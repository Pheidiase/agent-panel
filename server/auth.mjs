import fs from "node:fs";
import path from "node:path";
import { AuthError } from "./json-store.mjs";
import { createLocalAuth } from "./local-auth.mjs";
import { createPortalAuth } from "./portal-auth.mjs";

export function readAuthConfig(state) {
  let c;
  try {
    const file = path.join(state, "auth.json");
    if (!fs.lstatSync(file).isFile()) throw new Error("Invalid auth file");
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { mode: "local", trustProxyHeader: false };
    throw new AuthError(503, "Giriş yapılandırması okunamadı.", "AUTH_CONFIG_INVALID");
  }
  if (!c || typeof c !== "object" || Array.isArray(c) || !["local", "portal"].includes(c.mode) ||
      (c.trustProxyHeader !== undefined && typeof c.trustProxyHeader !== "boolean") ||
      Object.keys(c).some(k => !["mode", "trustProxyHeader"].includes(k)))
    throw new AuthError(503, "Giriş yapılandırması geçersiz.", "AUTH_CONFIG_INVALID");
  return { mode: c.mode, trustProxyHeader: c.trustProxyHeader ?? false };
}
export function createAuth(options) {
  const config = readAuthConfig(options.state);
  if (config.mode === "local") return createLocalAuth({ ...options, trustProxyHeader: config.trustProxyHeader });
  return { ...createPortalAuth({ ...options, trustProxyHeader: config.trustProxyHeader }),
    mode: "portal", metadata: () => ({ mode: "portal" }) };
}
