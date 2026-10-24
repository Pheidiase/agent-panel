import { isIP } from "node:net";

const normalize = value => typeof value === "string" && value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
export function clientIp(req, { trustProxyHeader = false } = {}) {
  const remote = normalize(req.socket?.remoteAddress);
  const header = req.headers["cf-connecting-ip"];
  if (trustProxyHeader && (remote === "127.0.0.1" || remote === "::1") &&
      typeof header === "string" && header.length <= 64 && isIP(header)) return normalize(header);
  return typeof remote === "string" && isIP(remote) ? remote : "?";
}
