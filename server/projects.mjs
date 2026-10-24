// Project list = config/projects.json (curated metadata) + every real
// directory directly under the workspace, discovered at runtime so a new
// folder shows up without editing config or restarting the panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { optionalJson } from "./config.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKIP = new Set(["node_modules", "lost+found"]);
const COLORS = ["sage", "blue", "purple", "amber"];

function titleOf(id) {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function describe(p, home) {
  const resolved = fs.realpathSync(p.kind === "general" ? home : p.dir);
  return {
    ...p.meta,
    path: resolved,
    displayPath: resolved === home ? "~" : "~/" + path.relative(home, resolved),
  };
}

export function loadProjects({ configFile, workspace, home = os.homedir() }) {
  const configured = optionalJson(configFile, null);
  if (!Array.isArray(configured) || configured.some(meta => !meta || typeof meta !== "object" || !ID_RE.test(meta.id)))
    throw new Error("projects.json: geçerli proje listesi gerekli / expected an array of projects with valid ids.");
  const out = [];
  const seen = new Set();
  for (const meta of configured) {
    const dir = path.join(workspace, meta.id);
    if (meta.kind !== "general" && !fs.existsSync(dir)) continue;
    out.push(describe({ meta, dir, kind: meta.kind }, home));
    seen.add(meta.id);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {}
  const found = entries
    .filter((e) => ID_RE.test(e.name) && !SKIP.has(e.name) && !seen.has(e.name))
    .filter((e) => {
      try {
        return fs.statSync(path.join(workspace, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  found.forEach((id, i) => {
    const meta = {
      id,
      name: titleOf(id),
      description: "",
      icon: "layers",
      color: COLORS[i % COLORS.length],
    };
    out.push(describe({ meta, dir: path.join(workspace, id) }, home));
  });
  return out;
}

// Refresh `list` in place: managers hold this same array and look projects up
// at call time, so no restart is needed.
export function refreshProjects(list, opts) {
  try {
    list.splice(0, list.length, ...loadProjects(opts));
  } catch {}
  return list;
}
