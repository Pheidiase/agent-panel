import { AuthError } from "./json-store.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Failed-password budgets are separate from short burst/concurrency limits.
export class LoginLimits {
  constructor(now = Date.now, pause = delay) {
    this.now = now; this.failures = new Map(); this.bursts = new Map();
    this.pending = new Map(); this.active = 0; this.pause = pause;
  }
  keys(ip, username) {
    const account = typeof username === "string" ? username.trim().toLowerCase() : "";
    return { account: JSON.stringify(["account", account]), pair: JSON.stringify(["pair", ip, account]), ip: JSON.stringify(["ip", ip]) };
  }
  recent(map, key, window) {
    const times = (map.get(key) || []).filter(t => t > this.now() - window);
    if (times.length) map.set(key, times); else map.delete(key);
    return times;
  }
  blocked(map, key, window, limit) {
    const times = this.recent(map, key, window);
    return times.length >= limit ? Math.max(1, Math.ceil((times[times.length - limit] + window - this.now()) / 1000)) : 0;
  }
  error(retry, message) {
    const error = new AuthError(429, `${message} ${retry} saniye sonra tekrar dene.`, "LOGIN_LIMITED");
    error.retryAfter = retry; return error;
  }
  add(map, key, window) { const times = this.recent(map, key, window); times.push(this.now()); map.set(key, times); }
  reservedWait(key, limit) {
    const pending = this.pending.get(key) || 0;
    const failures = this.recent(this.failures, key, 600000);
    if (failures.length + pending < limit) return 0;
    return failures.length >= limit ? this.blocked(this.failures, key, 600000, limit) : 1;
  }
  async run(ip, username, operation) {
    this.cleanup();
    const k = this.keys(ip, username);
    const burst = Math.max(this.blocked(this.bursts, k.ip, 60000, 60), this.blocked(this.bursts, "all", 60000, 300));
    if (burst) throw this.error(burst, "Çok hızlı giriş isteği gönderildi.");
    this.add(this.bursts, k.ip, 60000); this.add(this.bursts, "all", 60000);
    const checkFailures = () => {
      const wait = Math.max(this.reservedWait(k.pair, 6), this.reservedWait(k.ip, 24));
      if (wait) throw this.error(wait, "Çok fazla hatalı giriş denemesi.");
    };
    checkFailures();
    // Distributed account risk adds a bounded delay; it never locks out a valid password.
    const mistakes = this.recent(this.failures, k.account, 600000).length;
    if (mistakes >= 3) await this.pause(Math.min(1000, 100 * 2 ** Math.min(4, mistakes - 3)));
    checkFailures();
    if (this.active >= 4 || (this.pending.get(k.ip) || 0) >= 2) throw this.error(1, "Giriş işlemi sürüyor.");
    this.active++;
    for (const key of [k.ip, k.pair]) this.pending.set(key, (this.pending.get(key) || 0) + 1);
    try {
      const result = await operation();
      this.failures.delete(k.account); this.failures.delete(k.pair);
      return result;
    } catch (error) {
      if (error.status === 401) for (const key of [k.pair, k.account, k.ip]) this.add(this.failures, key, 600000);
      throw error;
    } finally {
      this.active--;
      for (const key of [k.ip, k.pair]) {
        const left = this.pending.get(key) - 1;
        if (left) this.pending.set(key, left); else this.pending.delete(key);
      }
    }
  }
  cleanup() {
    for (const [map, window] of [[this.failures, 600000], [this.bursts, 60000]])
      for (const key of map.keys()) this.recent(map, key, window);
    // The short global burst limit bounds key growth without a shared password lockout.
  }
}
