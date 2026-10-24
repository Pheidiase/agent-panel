// Passwords enter through a hidden TTY or a single line on stdin, never argv/env.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline/promises";
import { OwnerStore } from "../server/owner-store.mjs";
import { passwordRecord, validatePassword } from "../server/passwords.mjs";
import { validateOwnerName } from "../server/user-lock.mjs";
import { readAuthConfig } from "../server/auth.mjs";
import { AuditLog } from "../server/audit.mjs";

const usage = "Kullanım: npm run set-password -- --owner [--rename <kullanıcı-adı>]";
const passwordLengthMessage = "Parola 12–200 karakter olmalı / Password must be 12–200 characters.";
export function passwordError(error) {
  if (error.code === "PASSWORD_INVALID") return passwordLengthMessage;
  return error.status || ["EACCES", "EPERM", "EIO", "ENOSPC"].includes(error.code) ? "Parola kaydedilemedi; hesap/izin/kilit durumunu kontrol edin." :
    error.code ? "Parola kaydedilemedi." : error.message;
}
export async function passwordInput(input = process.stdin, prompt = process.stderr, confirmation = false) {
  if (!input.isTTY) {
    let value = ""; const decoder = new StringDecoder("utf8");
    for await (const chunk of input) {
      value += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (Buffer.byteLength(value) > 1024) throw new Error(passwordLengthMessage);
    }
    value += decoder.end();
    value = value.replace(/\r?\n$/, "");
    if (/[\r\n]/.test(value)) throw new Error("Stdin yalnız tek parola satırı içermeli.");
    return value;
  }
  return hiddenInput(input, () => ttyPassword(input, prompt, confirmation));
}
async function hiddenInput(input, read) {
  const wasRaw = !!input.isRaw;
  try {
    input.setRawMode(true);
    return await read();
  } finally {
    input.pause(); input.setRawMode(wasRaw);
  }
}
async function ttyPassword(input, prompt, confirmation = false) {
  try {
    return await new Promise((resolve, reject) => {
      let value = "", ready = false, settled = false, quiet = 0, pending;
      const decoder = new StringDecoder("utf8");
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearImmediate(pending); input.pause();
        input.off("data", onData); input.off("end", onEnd); input.off("close", onEnd); input.off("error", onError);
        prompt.off?.("error", onError);
        if (error) reject(error); else resolve(value);
      };
      const onEnd = () => done(new Error("Parola girdisi kesildi."));
      const onError = () => done(new Error("Parola okunamadı."));
      const onData = chunk => {
        if (!ready) {
          quiet = 0;
          if (chunk.includes("\u0003") || chunk.includes("\u0004")) onEnd();
          return;
        }
        for (const char of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
          if (char === "\r" || char === "\n") return done(null, value);
          if (char === "\u0003" || char === "\u0004") return onEnd();
          if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
          else if (char >= " " && char !== "\u007f") value += char;
          if (value.length > 200) return done(new Error(passwordLengthMessage));
        }
      };
      // Drain both stream buffers and pending terminal reads before showing the prompt.
      // Two quiet check phases include a full I/O poll; new data restarts the drain.
      const showPrompt = () => {
        if (++quiet < 2) { pending = setImmediate(showPrompt); return; }
        ready = true;
        try { prompt.write(confirmation ? "Parola tekrar / Confirm password (gizli giriş / hidden input): " : "Parola / Password (gizli giriş / hidden input): "); }
        catch { onError(); }
      };
      input.on("data", onData); input.once("end", onEnd); input.once("close", onEnd); input.once("error", onError);
      prompt.once?.("error", onError);
      if (input.destroyed || input.readableEnded) return onEnd();
      pending = setImmediate(showPrompt);
      try { input.resume(); } catch { onError(); }
    });
  } finally {
    prompt.write("\n");
  }
}
export async function setPassword({ state, args = [], input = process.stdin, output = process.stdout, prompt = process.stderr }) {
  if (args.length && !(args[0] === "--owner" && (args.length === 1 || (args.length === 3 && args[1] === "--rename")))) throw new Error(usage);
  const config = readAuthConfig(state), store = new OwnerStore(state), old = store.read();
  let rename = args[2];
  if (!rename && !old) {
    if (!input.isTTY) throw new Error("İlk kurulum: npm run set-password -- --owner --rename <kullanıcı-adı>");
    const reader = createInterface({ input, output: prompt, terminal: false });
    try { rename = await reader.question("Kullanıcı adı / Username: "); }
    finally { reader.close(); }
  }
  if (rename !== undefined) validateOwnerName(rename);
  const readPasswords = async () => {
    const password = await (input.isTTY ? ttyPassword(input, prompt) : passwordInput(input, prompt)); validatePassword(password);
    if (input.isTTY) {
      const confirmation = await ttyPassword(input, prompt, true);
      if (password !== confirmation) throw new Error("Parolalar eşleşmiyor; kaydedilmedi / Passwords do not match; not saved.");
    }
    return password;
  };
  let password = await (input.isTTY ? hiddenInput(input, readPasswords) : readPasswords());
  const credential = await passwordRecord(password); password = "";
  // Reread the name under the same writer lock as the credential update.
  const owner = store.setOwnerCredential({ ...(rename !== undefined ? { username: rename } : {}), ...credential }, { preserveName: rename === undefined });
  new AuditLog(state).record("owner.password.change", { actor: owner, changes: { password: true } });
  output.write("Sahip parolası kaydedildi; önceki yerel oturumlar geçersiz / Owner password saved; previous local sessions invalidated.\n");
  if (config.mode === "portal") output.write("Portal modu etkin; bu parola yalnız yerel modda kullanılır. Mod değiştirilmedi.\n");
  return owner;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    await setPassword({ state: process.env.PANEL_STATE_DIR || path.resolve(import.meta.dirname, "../var"), args: process.argv.slice(2) });
  } catch (error) {
    // Only fixed validation messages; filesystem exception paths are not printed.
    console.error(passwordError(error));
    process.exitCode = 1;
  }
}
