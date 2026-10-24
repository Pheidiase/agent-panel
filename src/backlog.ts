import type { Styled } from "./termcolors";

export type BacklogRow = { id: number; signature: string; text: string; styled: Styled };
export type BacklogBlock = { id: number; rows: BacklogRow[] };
export type BacklogDocument = { text: string; styled: Styled; rows: BacklogRow[]; blocks: BacklogBlock[]; nextId: number };
const BLOCK_ROWS = 64;

// Canonical row colours, independent of the server's palette indexes and of
// offsets shifted by trimming history. Unchanged rows and whole blocks retain
// their identity, so React leaves their DOM (and text selections) in place.
export function updateBacklog(previous: BacklogDocument | undefined, text: string, styled: Styled): BacklogDocument {
  const rows: BacklogRow[] = [], runs = styled.runs || [], palette = styled.styles || [];
  const oldRuns = previous?.styled.runs || [], oldPalette = previous?.styled.styles || [];
  let colourChangeAt = 0;
  if (palette.length === oldPalette.length && palette.every((key, i) => key === oldPalette[i])) {
    let k = 0;
    while (k < runs.length && k < oldRuns.length && runs[k] === oldRuns[k]) k++;
    const triple = k - k % 3;
    colourChangeAt = k === runs.length && k === oldRuns.length ? Infinity : Math.min(runs[triple] ?? Infinity, oldRuns[triple] ?? Infinity);
  }
  // Most updates append/change the tail. Reuse the unchanged prefix without
  // allocating/parsing signatures or colour arrays for its thousands of rows.
  let pool: Map<string, { rows: BacklogRow[]; at: number }> | undefined;
  let offset = 0, run = 0, nextId = previous?.nextId || 0;
  for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = match[0], end = offset + line.length;
    const prefix = previous?.rows[rows.length];
    if (!pool && prefix?.text === line && end <= colourChangeAt) {
      rows.push(prefix); offset = end; continue;
    }
    if (!pool) {
      pool = new Map();
      for (const row of previous?.rows.slice(rows.length) || []) {
        let bucket = pool.get(row.signature);
        if (!bucket) { bucket = { rows: [], at: 0 }; pool.set(row.signature, bucket); }
        bucket.rows.push(row);
      }
    }
    const styles: string[] = [], local: number[] = [];
    while (run < runs.length && runs[run] + runs[run + 1] <= offset) run += 3;
    for (let k = run; k < runs.length && runs[k] < end; k += 3) {
      const key = palette[runs[k + 2]];
      if (!key) continue;
      const a = Math.max(offset, runs[k]) - offset, b = Math.min(end, runs[k] + runs[k + 1]) - offset;
      if (b <= a) continue;
      let index = styles.indexOf(key);
      if (index < 0) { index = styles.length; styles.push(key); }
      // Merge equivalent adjacent runs even if the server encoded them apart.
      const last = local.length - 3;
      if (last >= 0 && local[last] + local[last + 1] === a && local[last + 2] === index) local[last + 1] += b - a;
      else local.push(a, b - a, index);
    }
    const signature = JSON.stringify([line, styles, local]);
    const bucket = pool.get(signature), old = bucket?.rows[bucket.at++];
    rows.push(old || { id: nextId++, signature, text: line, styled: { styles, runs: local } });
    offset = end;
  }
  if (previous && rows.length === previous.rows.length && rows.every((row, i) => row === previous.rows[i])) return previous;

  const positions = new Map(rows.map((row, i) => [row, i]));
  const reusable = new Map<number, BacklogBlock>();
  const owners = new Map<BacklogRow, BacklogBlock>();
  for (const block of previous?.blocks || []) {
    for (const row of block.rows) owners.set(row, block);
    const at = positions.get(block.rows[0]);
    if (at !== undefined && block.rows.every((row, j) => row === rows[at + j])) reusable.set(at, block);
  }
  const claimed = new Set([...reusable.values()].map(block => block.id));
  const blocks: BacklogBlock[] = [];
  let pending: BacklogRow[] = [];
  const flush = () => {
    if (!pending.length) return;
    // Keep the parent key of a partly changed block as well, so the unchanged
    // rows inside it keep their actual DOM nodes and any active selection.
    const owner = pending.map(row => owners.get(row)).find(block => block && !claimed.has(block.id));
    const id = owner?.id ?? nextId++;
    claimed.add(id); blocks.push({ id, rows: pending }); pending = [];
  };
  for (let i = 0; i < rows.length;) {
    const old = reusable.get(i);
    if (old) {
      flush(); blocks.push(old); i += old.rows.length;
    } else {
      pending.push(rows[i++]);
      if (pending.length === BLOCK_ROWS) flush();
    }
  }
  flush();
  return { text, styled, rows, blocks, nextId };
}
