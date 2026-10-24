// Local login also serves public build assets anonymously. Cache them only
// in the requesting browser; shared public caches are unnecessary.
export function setStaticCache(res, file) {
  const hashed = /[\/]assets[\/][^\/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(file);
  res.setHeader("Cache-Control", hashed ? "private, max-age=31536000, immutable" : "no-store");
}
