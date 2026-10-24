import { t, useI18n, serverError } from "./i18n";
import { useEffect, useState } from "react";
import { type AuthConfig, type AuthFailure, type LoginGrant } from "./auth-text";

export function Login({ config, submit, onLogin }: { config: AuthConfig;
  submit: (username: string, password: string) => Promise<LoginGrant>; onLogin: (grant: LoginGrant) => void }) {
  useI18n();
  const [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<AuthFailure | null>(null);
  const [waitUntil, setWaitUntil] = useState(0), [remaining, setRemaining] = useState(0);
  useEffect(() => { if (config.mode === "portal") window.location.replace("/"); }, [config.mode]);
  useEffect(() => {
    if (!waitUntil) return;
    const update = () => setRemaining(Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [waitUntil]);
  async function login(event: React.FormEvent) {
    event.preventDefault(); if (busy || remaining) return;
    setBusy(true); setError(null);
    try {
      const grant = await submit(username, password);
      setPassword(""); onLogin(grant);
    } catch (value) {
      const failure = value as AuthFailure;
      if (failure.status === 429) {
        const seconds = Math.max(1, failure.retryAfter || 1);
        setRemaining(seconds); setWaitUntil(Date.now() + seconds * 1000);
      } else setError(failure);
    } finally { setPassword(""); setBusy(false); }
  }
  if (config.mode === "portal") return <main className="login-page">{t("auth.redirect")}</main>;
  return <main className="login-page"><form className="login-card" method="post" action="/api/login" onSubmit={login}>
    <h1>{t("auth.title")}</h1>
    {!config.configured ? <p role="status">{t("auth.setup")}</p> : <>
      <label>{t("auth.username")}<input name="username" autoComplete="username" autoFocus required maxLength={100}
        value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>{t("auth.password")}<input name="password" type="password" autoComplete="current-password" required maxLength={200}
        value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button type="submit" disabled={busy || remaining > 0}>{busy ? t("auth.busy") : t("auth.submit")}</button>
    </>}
    {(error || remaining > 0) && <p role="alert">{remaining > 0 ? t("auth.limited", { count: remaining }) : error && (error.code ? serverError({ code: error.code, error: error.message }) : error.status === 401 ? t("auth.failed") : error.status === 400 ? t("auth.invalid") : t("auth.unavailable"))}</p>}
  </form></main>;
}
