// Minimal line diff for the chat "Değişiklikler" panel: common prefix/suffix
// trim, then an LCS table on the remainder, with hard caps — a very large
// change reports that a line view is unavailable instead of blocking the UI.
export type DiffLine = {
  type: "ctx" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};
export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  tooLarge: boolean;
  oldLines: number;
  newLines: number;
};

const MAX_MID_LINES = 1500;
const MAX_CELLS = 1_200_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const oldAll = splitLines(oldText);
  const newAll = splitLines(newText);
  let start = 0;
  while (start < oldAll.length && start < newAll.length && oldAll[start] === newAll[start])
    start++;
  let oldEnd = oldAll.length;
  let newEnd = newAll.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldAll[oldEnd - 1] === newAll[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const oldMid = oldAll.slice(start, oldEnd);
  const newMid = newAll.slice(start, newEnd);
  const n = oldMid.length;
  const m = newMid.length;
  if (n > MAX_MID_LINES || m > MAX_MID_LINES || n * m > MAX_CELLS)
    return {
      lines: [],
      added: 0,
      removed: 0,
      tooLarge: true,
      oldLines: oldAll.length,
      newLines: newAll.length,
    };
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        oldMid[i] === newMid[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let k = 0; k < start; k++)
    lines.push({ type: "ctx", text: oldAll[k], oldNo: oldNo++, newNo: newNo++ });
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      lines.push({ type: "ctx", text: oldMid[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({ type: "del", text: oldMid[i], oldNo: oldNo++, newNo: null });
      i++;
      removed++;
    } else {
      lines.push({ type: "add", text: newMid[j], oldNo: null, newNo: newNo++ });
      j++;
      added++;
    }
  }
  while (i < n) {
    lines.push({ type: "del", text: oldMid[i], oldNo: oldNo++, newNo: null });
    i++;
    removed++;
  }
  while (j < m) {
    lines.push({ type: "add", text: newMid[j], oldNo: null, newNo: newNo++ });
    j++;
    added++;
  }
  for (let k = oldEnd; k < oldAll.length; k++)
    lines.push({ type: "ctx", text: oldAll[k], oldNo: oldNo++, newNo: newNo++ });
  return { lines, added, removed, tooLarge: false, oldLines: oldAll.length, newLines: newAll.length };
}

// A session owns this cache. Header totals and the open panel share results;
// evicted fragments (including their source strings) leave the cache together.
export function retainDiffs(
  cache: Map<string, { oldText: string; newText: string; result: DiffResult }>,
  files: Array<{ blockId: string; oldText: string; newText: string }>,
  compute = diffLines,
): Map<string, DiffResult> {
  const retained = new Set(files.map(file => file.blockId));
  for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
  const results = new Map<string, DiffResult>();
  for (const file of files) {
    let cached = cache.get(file.blockId);
    if (!cached || cached.oldText !== file.oldText || cached.newText !== file.newText) {
      cached = { oldText: file.oldText, newText: file.newText, result: compute(file.oldText, file.newText) };
      cache.set(file.blockId, cached);
    }
    results.set(file.blockId, cached.result);
  }
  return results;
}
