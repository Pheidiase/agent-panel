// Bounded project file listing behind the chat composer's "@" mention picker.
// Walks only inside the resolved project root, never follows symlinks, skips
// heavy/generated directories and dotfiles, and caps the scan, the cache and
// the result count. Read-only: nothing here writes or executes.
import fsp from "node:fs/promises";
import path from "node:path";

export const FILES_SCAN_LIMIT = 30000;
export const FILES_RESULT_LIMIT = 50;
export const FILES_CACHE_TTL_MS = 30000;
export const FILES_CACHE_ENTRIES = 8;
export const FILES_QUERY_MAX = 200;
const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".cache",
  ".runtime",
  ".venv",
  "venv",
  ".next",
]);

function isSkipped(name) {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

// One walk, deterministic order (breadth-first, then sorted). The scan limit
// bounds both the work and the memory for a pathological tree; `truncated`
// tells the UI the list is partial.
export async function scanProjectFiles(root, { scanLimit = FILES_SCAN_LIMIT } = {}) {
  const files = [];
  const queue = [""];
  let head = 0;
  let scanned = 0;
  let truncated = false;
  while (head < queue.length && scanned < scanLimit) {
    const rel = queue[head++];
    let entries;
    try {
      entries = await fsp.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned++;
      if (scanned >= scanLimit) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (isSkipped(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the root
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  files.sort();
  return { files, truncated };
}

const cache = new Map();

async function cachedScan(root) {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < FILES_CACHE_TTL_MS) return hit.value;
  const value = await scanProjectFiles(root);
  cache.set(root, { at: Date.now(), value });
  if (cache.size > FILES_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

// Ranks matches: basename prefix first, then basename substring, then full
// path prefix/substring; ties break toward shorter, then alphabetical paths.
export function rankFiles(files, query, limit = FILES_RESULT_LIMIT) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let rank;
    if (base.startsWith(q)) rank = 0;
    else if (base.includes(q)) rank = 1;
    else if (lower.startsWith(q)) rank = 2;
    else if (lower.includes(q)) rank = 3;
    else continue;
    scored.push({ rank, length: file.length, file });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.length - b.length || a.file.localeCompare(b.file),
  );
  return scored.slice(0, limit).map((entry) => entry.file);
}

export async function listProjectFiles(root, { query = "", limit = FILES_RESULT_LIMIT } = {}) {
  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    return { files: [], truncated: false, total: 0 };
  }
  if (!stat.isDirectory()) return { files: [], truncated: false, total: 0 };
  const { files, truncated } = await cachedScan(root);
  return { files: rankFiles(files, query, limit), truncated, total: files.length };
}
