// "Değişiklikler": per-file diff view with an inline comment flow, built on
// the pure helpers in ./changes. Comments are collected in the panel and can
// be appended to the next message with one action; nothing here writes
// anything by itself.
import React, { useMemo, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { useI18n } from "./i18n";

const SIGN: Record<string, string> = { add: "+", del: "−", ctx: "" };

function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
import type { DiffResult } from "./diff";
import { commentBatches, commentMatchesFile, type ChangeFile, type InlineComment } from "./changes";

export default function ChangesPanel({
  files,
  diffs,
  comments,
  onCommentsChange,
  onInsert,
  onClose,
}: {
  files: ChangeFile[];
  diffs: Map<string, DiffResult>;
  comments: InlineComment[];
  onCommentsChange: (comments: InlineComment[]) => void;
  onInsert: (comments: InlineComment[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    path: string;
    blockId: string;
    side: "old" | "new";
    line: number;
    snippet: string;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [batchIndex, setBatchIndex] = useState(0);
  const batches = useMemo(() => commentBatches(comments), [comments]);
  const selectedBatch = Math.min(batchIndex, Math.max(0, batches.length - 1));
  const batch = batches[selectedBatch] ?? [];
  const orphaned = comments.filter(comment => !files.some(file => commentMatchesFile(comment, file)));
  const active = files.find((file) => file.blockId === selected) ?? files[0] ?? null;
  const attached = comments.filter(comment => active && commentMatchesFile(comment, active));
  const totals = useMemo(
    () =>
      new Map(
        files.map((file) => {
          const result = diffs.get(file.blockId)!;
          return [
            file.blockId,
            { added: result.tooLarge ? null : result.added, removed: result.tooLarge ? null : result.removed },
          ] as const;
        }),
      ),
    [files, diffs],
  );
  const activeDiff = useMemo(
    () => (active ? diffs.get(active.blockId) : null),
    [active?.blockId, diffs],
  );

  function saveComment() {
    if (!editor || !draftText.trim()) return;
    const id: string =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    onCommentsChange(
      [
        ...comments,
        {
          id,
          ...editor,
          text: draftText.trim().slice(0, 2000),
          at: new Date().toISOString(),
        },
      ].slice(-200),
    );
    setEditor(null);
    setDraftText("");
  }

  return (
    <section className="changes-panel" aria-label={t("changes.ariaLabel")}>
      <header className="changes-head">
        <strong>{t("changes.title")}</strong>
        <span className="changes-count">
          {t("changes.fileCount", { count: files.length })}
          {comments.length > 0 ? ` · ${t("changes.commentCount", { count: comments.length })}` : ""}
        </span>
        <span className="changes-actions">
          {batches.length > 1 && <select aria-label={t("changes.commentGroup")} value={selectedBatch} onChange={event => setBatchIndex(Number(event.target.value))}>
            {batches.map((group, index) => <option key={index} value={index}>{t("changes.group", { index: index + 1, count: group.length })}</option>)}
          </select>}
          <button
            type="button"
            className="text-button"
            disabled={batch.length === 0}
            onClick={() => onInsert(batch)}
          >
            <MessageSquarePlus size={14} /> {batches.length > 1 ? t("changes.addGroup") : t("changes.addComments")} ({batch.length})
          </button>
          <button type="button" className="icon-button" aria-label={t("changes.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </span>
      </header>
      {batches.length > 1 && <p className="changes-note" role="status">{t("changes.batchesNote", { count: batches.length })}</p>}
      {orphaned.length > 0 && (
        <div className="changes-note" role="status">
          <p>{t("changes.orphaned", { count: orphaned.length })}</p>
          {orphaned.map(comment => <p key={comment.id}>
            <code>{comment.path}:{comment.line}</code> — {comment.text}{" "}
            <button type="button" className="text-button" aria-label={t("changes.deleteComment")}
              onClick={() => onCommentsChange(comments.filter(item => item.id !== comment.id))}>{t("changes.delete")}</button>
          </p>)}
        </div>
      )}
      <div className="changes-body">
        <ul className="changes-files">
          {files.map((file) => {
            const total = totals.get(file.blockId);
            return (
              <li key={file.blockId}>
                <button
                  type="button"
                  className={`changes-file ${active?.blockId === file.blockId ? "chosen" : ""}`}
                  onClick={() => {
                    setSelected(file.blockId);
                    setEditor(null);
                  }}
                >
                  <code className="changes-path" title={file.path}>
                    {splitPath(file.path).dir && <span className="path-dir">{splitPath(file.path).dir}</span>}
                    <span className="path-name">{splitPath(file.path).name}</span>
                  </code>
                  <span className="changes-stat">
                    {total?.added === null || total?.added === undefined ? (
                      t("changes.largeChange")
                    ) : (
                      <>
                        <span className="stat-add">+{total.added}</span>{" "}
                        <span className="stat-del">−{total.removed}</span>
                      </>
                    )}
                  </span>
                  {file.edits > 1 && <span className="changes-edits">{t("changes.editCount", { count: file.edits })}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {active && activeDiff && (
          <div className="changes-diff">
            {activeDiff.tooLarge ? (
              <div className="changes-note">
                {t("changes.tooLarge", { old: activeDiff.oldLines, next: activeDiff.newLines })}
              </div>
            ) : (
              <div className="diff-lines">
                <p className="changes-note">{t("changes.diffHelp")}</p>
                {activeDiff.lines.map((line, index) => {
                  const side = line.type === "del" ? "old" : "new";
                  const lineNo = (line.type === "del" ? line.oldNo : line.newNo) ?? 0;
                  const lineComments = attached.filter(
                    (comment) =>
                      comment.side === side &&
                      comment.line === lineNo,
                  );
                  return (
                    <React.Fragment key={index}>
                      <div className={`diff-line ${line.type}`}>
                        <button
                          type="button"
                          className={`diff-comment-add ${lineComments.length ? "has" : ""}`}
                          aria-label={t("changes.addLineComment", { side: t(side === "old" ? "changes.old" : "changes.new"), line: lineNo })}
                          title={t("changes.addComment")}
                          onClick={() => {
                            setEditor({ path: active.path, blockId: active.blockId, side, line: lineNo, snippet: line.text });
                            setDraftText("");
                          }}
                        >
                          <MessageSquarePlus size={12} aria-hidden="true" />
                        </button>
                        <span className="diff-no">{line.oldNo ?? ""}</span>
                        <span className="diff-no">{line.newNo ?? ""}</span>
                        <span className="sr-only">{t(line.type === "add" ? "changes.added" : line.type === "del" ? "changes.removed" : "changes.unchanged")} {t("changes.line")}: </span>
                        <span className="diff-sign" aria-hidden="true">{SIGN[line.type]}</span>
                        <code>{line.text || " "}</code>
                      </div>
                      {lineComments.map((comment) => (
                        <div className="diff-comment" key={comment.id}>
                          <span>{comment.text}</span>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={t("changes.deleteComment")}
                            onClick={() =>
                              onCommentsChange(comments.filter((item) => item.id !== comment.id))
                            }
                          >
                            {t("changes.delete")}
                          </button>
                        </div>
                      ))}
                      {editor &&
                        editor.path === active.path &&
                        editor.blockId === active.blockId &&
                        editor.side === side &&
                        editor.line === lineNo && (
                          <div className="diff-comment-form">
                            <textarea
                              rows={2}
                              maxLength={2000}
                              aria-label={t("changes.lineComment")}
                              placeholder={t("changes.commentPlaceholder")}
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              autoFocus
                            />
                            <div className="diff-comment-actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => {
                                  setEditor(null);
                                  setDraftText("");
                                }}
                              >
                                {t("common.cancel")}
                              </button>
                              <button
                                type="button"
                                className="primary"
                                disabled={!draftText.trim()}
                                onClick={saveComment}
                              >
                                {t("common.save")}
                              </button>
                            </div>
                          </div>
                        )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {!active && (
          <div className="changes-note">
            {t("changes.noChanges")}
          </div>
        )}
      </div>
    </section>
  );
}
