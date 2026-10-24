import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const [agent, cwd, executable, mode = "project"] = process.argv.slice(2);
if (
  !["hermes", "codex", "claude", "shell"].includes(agent) ||
  !executable ||
  !path.isAbsolute(executable) ||
  !fs.existsSync(executable)
) {
  console.error("Agent çalıştırılamadı.");
  process.exit(1);
}
// The shell is a login shell so PATH and profile match a normal Ubuntu terminal.
const args = agent === "shell"
  ? ["-l"]
  : mode === "general"
    ? agent === "hermes"
      ? ["--cli"]
      : agent === "codex"
        ? ["--no-alt-screen"]
        : []
    : agent === "hermes"
      ? ["--cli", "--in", cwd]
      : agent === "codex"
        ? ["-C", cwd, "--no-alt-screen"]
        : [];
const env = {
  ...process.env,
  HOME: os.homedir(),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};
// Keep Claude Code on the main screen so tmux retains scrollback for "Geçmişi oku".
if (agent === "claude") env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
// Service controls and parent terminal identity must not leak into a new agent.
for (const key of Object.keys(env))
  if (
    key.startsWith("PANEL_") ||
    key.startsWith("HERMES_SUPERVISED") ||
    [
      "TMUX",
      "TMUX_PANE",
      "NOTIFY_SOCKET",
      "INVOCATION_ID",
      "JOURNAL_STREAM",
      "CODEX_THREAD_ID",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
      "TERMINAL_CWD",
      "HERMES_TUI_RESUME",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SSE_PORT",
    ].includes(key)
  )
    delete env[key];
// The panel runs with umask 077; a shell needs the normal Ubuntu umask so that
// `sudo npm install -g` and similar leave system files readable by everyone.
if (agent === "shell") process.umask(0o022);
const child = spawn(executable, args, { cwd, env, stdio: "inherit" });
child.on("error", () => {
  console.error("Agent başlatılamadı.");
  process.exit(1);
});
child.on("exit", (code, signal) => {
  console.log("\nSession sona erdi. Çıktı bu ekranda korunuyor.");
  process.exit(code ?? (signal ? 1 : 0));
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
