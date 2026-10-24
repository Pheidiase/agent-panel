import { getLocale, useI18n } from "./i18n";
// Ctrl/Cmd+K hat değiştirici: oturumlara ve ana görünümlere klavyeyle atlar.
// Yalnızca sunum ve gezinti; oturum durumuna veya sunucuya dokunmaz.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, CornerDownLeft, History, Plus, Search } from "lucide-react";

export type PaletteSession = { id: string; title: string; agentId: string; status: string; kind?: string; projectName?: string };
export type PaletteAction = { id: string; label: string; icon: "new" | "history" | "runs"; run: () => void };

const fold = (text: string) => text.toLocaleLowerCase(getLocale());

export default function Palette({
  sessions,
  agentName,
  actions,
  onOpen,
  onClose,
}: {
  sessions: PaletteSession[];
  agentName: (id: string) => string;
  actions: PaletteAction[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const rows = useMemo(() => {
    const q = fold(query.trim());
    const hits = sessions
      .filter((s) => !q || fold(`${s.title} ${agentName(s.agentId)} ${s.projectName ?? ""}`).includes(q))
      .slice(0, 12)
      .map((s) => ({ key: s.id, session: s as PaletteSession | null, action: null as PaletteAction | null }));
    const acts = actions
      .filter((a) => !q || fold(a.label).includes(q))
      .map((a) => ({ key: a.id, session: null as PaletteSession | null, action: a as PaletteAction | null }));
    return [...hits, ...acts];
  }, [query, sessions, actions, agentName, getLocale()]);
  useEffect(() => { setActive(0); }, [query]);
  // Block body: scrollIntoView returns a Promise in new Chromium, and React would treat it as a cleanup function.
  useEffect(() => { document.getElementById(`palette-option-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  function choose(index: number) {
    const row = rows[index];
    if (!row) return;
    onClose();
    if (row.session) onOpen(row.session.id);
    else row.action?.run();
  }
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  }
  return (
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("palette.changeSession")} onKeyDown={onKeyDown}>
        <label className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows.length ? `palette-option-${active}` : undefined}
            aria-label={t("palette.search")}
            placeholder={t("palette.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" data-dialog-close aria-label={t("palette.close")} onClick={onClose}>Esc</button>
        </label>
        <ul className="palette-list" id="palette-list" role="listbox">
          {rows.length === 0 && <li className="palette-empty">{t("palette.empty")}</li>}
          {rows.map((row, index) => (
            <React.Fragment key={row.key}>
            {((row.session && index === 0) || (row.action && !rows[index - 1]?.action)) && (
              <li role="presentation" className="palette-group">{row.session ? t("palette.sessions") : t("palette.actions")}</li>
            )}
            <li
              id={`palette-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseMove={() => setActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(index)}
            >
              {row.session ? (
                <>
                  <span className={`lamp ${row.session.agentId} ${row.session.status === "running" ? "on" : ""}`} aria-hidden="true" />
                  <span className="palette-title">{row.session.title}</span>
                  <span className="palette-meta">
                    {agentName(row.session.agentId)}
                    {row.session.projectName ? `, ${row.session.projectName}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <span className="palette-icon" aria-hidden="true">
                    {row.action?.icon === "new" ? <Plus size={15} /> : row.action?.icon === "history" ? <History size={15} /> : <CalendarClock size={15} />}
                  </span>
                  <span className="palette-title">{row.action?.label}</span>
                </>
              )}
              {index === active && <CornerDownLeft size={14} className="palette-enter" />}
            </li>
            </React.Fragment>
          ))}
        </ul>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("palette.navigate")}</span>
          <span><kbd>↵</kbd> {t("palette.open")}</span>
          <span><kbd>Esc</kbd> {t("palette.dismiss")}</span>
        </div>
      </div>
    </div>
  );
}
