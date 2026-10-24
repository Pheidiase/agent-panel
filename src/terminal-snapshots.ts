import type { Styled } from "./ansi";
// Bounded, in-memory reading positions. No terminal contents go to storage.
export let snapshotEpoch = 0;
export function clearTerminalSnapshots() { snapshotEpoch++; snapshots.clear(); }
export const snapshots = new Map<string, { text: string; styled: Styled; top: number }>();
