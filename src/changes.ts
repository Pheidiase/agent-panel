import { getLocale, t } from "./i18n";

// "Değişiklikler" data helpers: folds the diffs the agent reported in its chat
// tool cards into one entry per changed file and renders collected inline
// comments as one message block. Pure data code (no JSX, no DOM) so it is
// unit-testable under plain Node as well as imported by the panel.
export type ChangeFile = {
  blockId: string;
  path: string;
  oldText: string;
  newText: string;
  edits: number;
};
export type InlineComment = {
  blockId?: string;
  id: string;
  path: string;
  side: "old" | "new";
  line: number;
  snippet: string;
  text: string;
  at: string;
};

// Agent edits may describe unrelated fragments of the same file. Keep each
// fragment separate; their line numbers are local to the reported fragment.
export function collectChanges(items: Array<{ type: string; key?: number; tool?: { id: string; content?: unknown[] | null } }>): ChangeFile[] {
  const files: ChangeFile[] = [];
  for (const item of items) {
    if (item.type !== "tool" || !item.tool) continue;
    const content = Array.isArray(item.tool.content) ? item.tool.content : [];
    for (const [index, block] of content.entries()) {
      if (!block || typeof block !== "object") continue;
      const diff = block as { type?: string; path?: string; oldText?: string; newText?: string };
      if (diff.type !== "diff" || typeof diff.path !== "string" || !diff.path) continue;
      // Tool identity, start sequence and position inside that tool survive
      // removal of earlier turns. Never reuse a file's displayed ordinal.
      files.push({ blockId: `${JSON.stringify([diff.path, item.tool.id, item.key ?? null])}::${index + 1}`, path: diff.path,
        oldText: typeof diff.oldText === "string" ? diff.oldText : "",
        newText: typeof diff.newText === "string" ? diff.newText : "", edits: 1 });
    }
  }
  return files;
}
export function commentMatchesFile(comment: InlineComment, file: ChangeFile): boolean {
  if (comment.path !== file.path || comment.blockId !== file.blockId) return false;
  const text = comment.side === "old" ? file.oldText : file.newText;
  return text.replace(/\r\n?/g, "\n").split("\n")[comment.line - 1] === comment.snippet;
}

export function buildCommentBlock(comments: InlineComment[]): string {
  const body = comments
    .map(
      (comment) =>
        `- ${comment.path}:${comment.line}${comment.blockId ? ` [${t("changes.chunk")} ${comment.blockId.split("::").at(-1)}]` : ""} (${t(comment.side === "old" ? "changes.old" : "changes.new").toLocaleLowerCase(getLocale())} ${t("changes.line")}) "${comment.snippet
          .trim()
          .slice(0, 120)}" → ${comment.text.trim()}`,
    )
    .join("\n");
  const block = `${t("changes.comments")}:\n${body}`;
  return block;
}

// Whole comments only. Each group can be added to a separate message.
export function commentBatches(comments: InlineComment[]): InlineComment[][] {
  const batches: InlineComment[][] = [];
  let batch: InlineComment[] = [];
  for (const comment of comments) {
    const next = buildCommentBlock([...batch, comment]);
    if (batch.length && (next.length > 4000 || new TextEncoder().encode(next).length > 8000)) {
      batches.push(batch); batch = [];
    }
    batch.push(comment);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function insertCommentBlock(draft: string, comments: InlineComment[]): string | null {
  const next = (draft.trim() ? draft.replace(/\s+$/, "") + "\n\n" : "") + buildCommentBlock(comments);
  return next.length <= 8000 && new TextEncoder().encode(next).length <= 16000 ? next : null;
}
