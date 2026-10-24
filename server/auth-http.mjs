import { errorCode } from "./error-codes.mjs";
import express from "express";
import { AuthError } from "./json-store.mjs";

export const publicGrant = g => ({ username: g.username, userId: g.userId, owner: g.owner, csrf: g.csrf });
export function mountAuthRoutes(app, provider, { originOK, revokeConnections = () => {} }) {
  app.get("/api/auth/config", (_req, res, next) => {
    try { res.json(provider.metadata()); } catch (error) { next(error); }
  });
  app.post("/api/login", (req, res, next) => {
    if (provider.mode !== "local") return next();
    if (!originOK(req)) return next(new AuthError(403, "İstek doğrulanamadı.", "ORIGIN_INVALID"));
    if (!req.is("application/json")) return next(new AuthError(415, "JSON içerik türü gerekli.", "LOGIN_CONTENT_TYPE"));
    next();
  }, express.json({ limit: provider.mode === "local" ? "16kb" : "64kb", inflate: false }), async (req, res, next) => {
    if (provider.mode !== "local") return res.status(410).json({ error: "Giriş ana sayfadan yapılır.", code: "PORTAL_LOGIN_REQUIRED" });
    try {
      const result = await provider.login(req, req.body);
      if (result.revokedToken) revokeConnections(result.revokedToken);
      res.setHeader("Set-Cookie", result.cookie); res.json(publicGrant(result.grant));
    } catch (error) { next(error); }
  });
}
// Only the public build shell is anonymous. Source maps and arbitrary files stay private.
export function anonymousAsset(urlPath) {
  return ["/", "/index.html", "/favicon.ico", "/favicon.svg"].includes(urlPath) ||
    /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2?|ttf|svg|png|ico)$/.test(urlPath);
}
export function authFailure(err, _req, res, next) {
  if (err.type === "encoding.unsupported") return res.status(415).json({ error: "Sıkıştırılmış istek gövdesi desteklenmiyor.", code: "LOGIN_ENCODING" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "İstek çok büyük. İçeriği kısaltarak yeniden dene.", code: "BODY_TOO_LARGE" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Geçersiz istek.", code: "BODY_INVALID" });
  if (![400, 401, 403, 415, 429, 503].includes(err.status)) return next(err);
  const retryAfter = err.status === 429 ? Math.max(1, Math.ceil(err.retryAfter || 1)) : undefined;
  if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
  res.status(err.status).json({ error: err.message, code: err.code || errorCode(err.message, err.status), ...(retryAfter ? { retryAfter } : {}) });
}
