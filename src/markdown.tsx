import { copyText } from "./clipboard";
// Small, dependency-free markdown renderer for assistant replies. Everything
// is built as React elements (no HTML injection); links are limited to
// http(s)/mailto. Partial streams are safe: an unclosed fence renders as code
// to the end, unmatched inline markers stay literal text.
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "./i18n";

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    const success = await copyText(code);
    setFailed(!success);
    setCopied(success);
    if (!success) return;
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="msg-codeblock">
      <div className="code-head">
        <span className="code-lang">{lang || t("markdown.code")}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label={t("markdown.copyCode")}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("conv.copied") : t("conv.copy")}
        </button>
      </div>
      {failed && <span role="status">{t("markdown.copyFailed")}</span>}
      <pre className="msg-code">{code}</pre>
    </div>
  );
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\[\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(\*[^*\s][^*\n]*\*)/g;

function inline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const token = match[0];
    const key = `${keyBase}-${n++}`;
    if (token.startsWith("`")) nodes.push(<code key={key} className="msg-inline-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      nodes.push(
        <a key={key} href={token.slice(split + 2, -1)} target="_blank" rel="noopener noreferrer">
          {token.slice(1, split)}
        </a>,
      );
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

function blocks(text: string, keyBase: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let b = 0;
  const key = () => `${keyBase}-b${b++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length + 1; // # → h2 inside a chat bubble
      const k = key();
      out.push(React.createElement(`h${level}`, { key: k, className: "md-h" }, inline(heading[2], k)));
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const k = key();
      out.push(
        <div key={k} className="md-table-wrap">
          <table>
            <thead>
              <tr>{head.map((cell, c) => <th key={c}>{inline(cell, `${k}h${c}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>{head.map((_, c) => <td key={c}>{inline(row[c] ?? "", `${k}r${r}c${c}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ""));
      const k = key();
      const children = items.map((item, n) => <li key={n}>{inline(item, `${k}i${n}`)}</li>);
      // A numbered list split by paragraphs ("1." … text … "2.") keeps its numbering.
      const start = ordered ? Number(/\d+/.exec(line)?.[0] ?? 1) : 1;
      out.push(ordered ? <ol key={k} start={start > 1 ? start : undefined}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      const k = key();
      out.push(<blockquote key={k}>{inline(quoted.join("\n"), k)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    )
      para.push(lines[i++]);
    const k = key();
    out.push(<p key={k}>{inline(para.join("\n"), k)}</p>);
  }
  return out;
}

export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  if (text.length > 100_000) return <div className="msg-text md">{text}</div>;
  const parts = text.split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      const lang = /^([a-zA-Z0-9_+.#-]*)\n/.exec(part)?.[1] ?? "";
      const code = part.replace(/^[a-zA-Z0-9_+.#-]*\n/, "").replace(/\n$/, "");
      return <CodeBlock key={index} lang={lang} code={code} />;
    }
    return (
      <div key={index} className="msg-text md">
        {blocks(part, String(index))}
      </div>
    );
  });
}
