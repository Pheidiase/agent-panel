import fs from "node:fs";
import path from "node:path";

export function loopbackHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

// Exact HTTPS origins only. Separate from the quick tunnel's rotating state.
export function canonicalOrigin(value) {
  if (typeof value !== "string") throw new Error("Invalid origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.port || url.pathname !== "/" || url.search || url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname) ||
      value !== url.origin) throw new Error("Expected an exact HTTPS origin without path");
  return url.origin;
}
export function readOrigins({ state, port }) {
  const origins = loopbackHosts(port).map(host => `http://${host}`);
  try {
    const value = JSON.parse(fs.readFileSync(path.join(state, "public-origin.json"), "utf8")).origin;
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value)) origins.push(value);
  } catch {}
  try {
    const { origins: configured } = JSON.parse(fs.readFileSync(path.join(state, "named-origins.json"), "utf8"));
    if (!Array.isArray(configured) || configured.length > 8) throw new Error("Invalid origins");
    // Reject the entire custom list if any entry is malformed.
    origins.push(...configured.map(canonicalOrigin));
  } catch {}
  return [...new Set(origins)];
}
export function hostAllowed(origins, host) {
  return typeof host === "string" && origins.some(origin => new URL(origin).host === host);
}
export function originAllowed(origins, host, origin) {
  return typeof origin === "string" && origins.includes(origin) && new URL(origin).host === host;
}
