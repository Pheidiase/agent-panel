import { deadlineNotice } from "./ux-state";
import { messageText, type UiMessage, useI18n } from "./i18n";
import { useEffect, useId, useState } from "react";
import "./question-card.css";

export type Question = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  isSecret?: boolean;
  isOther?: boolean;
};
export type QuestionAnswers = Record<string, string | string[]>;

export function QuestionCard({ questions, status, expiresAt, busy = false, error, onAnswer, onReject, onRetry }: {
  questions: Question[];
  status: string;
  expiresAt?: string;
  busy?: boolean;
  error?: string | null;
  onAnswer: (answers: QuestionAnswers) => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [selected, setSelected] = useState(() => new Map<string, string[]>());
  const [other, setOther] = useState(() => new Map<string, boolean>());
  const [text, setText] = useState(() => new Map<string, string>());
  const [sending, setSending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [localError, setLocalError] = useState<UiMessage>("");
  const [now, setNow] = useState(Date.now);
  const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
  const expired = status === "expired" || (Number.isFinite(deadline) && deadline <= now);
  const disabled = busy || sending || finished || status !== "requested" || expired;

  useEffect(() => {
    if (status !== "requested" || !Number.isFinite(deadline)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status, deadline]);
  useEffect(() => {
    if (status !== "requested" && !expired) {
      setText(new Map());
      setSelected(new Map());
      setOther(new Map());
    }
  }, [status, expired]);

  const send = async (reject = false) => {
    if (disabled) return;
    setLocalError("");
    const answers: QuestionAnswers = Object.create(null);
    if (!reject) {
      for (const question of questions) {
        const free = question.isSecret || !question.options.length || other.get(question.id);
        const custom = text.get(question.id) || "";
        const values = question.isSecret || !question.options.length
          ? [] : selected.get(question.id) || [];
        if (free && !custom.trim()) {
          setLocalError({ key: "questionCard.answerRequired", params: { question: question.header || question.question } });
          return;
        }
        const parts = [...values, ...(free ? [custom] : [])];
        if (!parts.length) {
          setLocalError({ key: "questionCard.choiceRequired", params: { question: question.header || question.question } });
          return;
        }
        if (parts.join(", ").length > 4000 || parts.length > 8) {
          setLocalError({ key: "questionCard.answerLimit" });
          return;
        }
        answers[question.id] = question.multiSelect && !question.isSecret ? parts : parts[0];
      }
    }
    setSending(true);
    try {
      if (reject) await onReject();
      else await onAnswer(answers);
      setText(new Map());
      setSelected(new Map());
      setOther(new Map());
      setFinished(true);
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure : { key: "questionCard.sendFailed" });
    } finally {
      setSending(false);
    }
  };

  return <form className="question-card" aria-label={t("questionCard.ariaLabel")} onSubmit={(event) => { event.preventDefault(); void send(); }}>
    <p className="sr-only" role="status" aria-atomic="true">{deadlineNotice(expired ? 0 : Number.isFinite(deadline) ? Math.ceil((deadline - now) / 1000) : null)}</p>
    <div className="question-card-heading">{t("questionCard.heading")}</div>
    {questions.map((question, index) => {
      const choices = question.isSecret ? [] : question.options;
      const free = !choices.length || other.get(question.id);
      const inputId = `${formId}-${index}-text`;
      return <fieldset key={question.id} disabled={disabled && !expired}>
        <legend>{question.header && <span className="question-tag">{question.header}</span>}{question.question}</legend>
        {question.multiSelect && choices.length > 0 && <p className="question-hint">{t("questionCard.multiSelectHint")}</p>}
        <div className="question-options">{choices.map((option) => <label key={option.label} className="question-option">
          <input disabled={disabled} type={question.multiSelect ? "checkbox" : "radio"} name={`${formId}-${question.id}`} value={option.label}
            checked={(selected.get(question.id) || []).includes(option.label)} onChange={(event) => {
              setLocalError("");
              setSelected((current) => new Map(current).set(question.id, question.multiSelect
                ? event.target.checked ? [...(current.get(question.id) || []), option.label] : (current.get(question.id) || []).filter((item) => item !== option.label)
                : [option.label]));
              if (!question.multiSelect) setOther((current) => new Map(current).set(question.id, false));
            }} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}</div>
        {choices.length > 0 && question.isOther !== false && <label className="question-option question-other">
          <input disabled={disabled} type={question.multiSelect ? "checkbox" : "radio"} name={`${formId}-${question.id}`} checked={!!other.get(question.id)}
            onChange={(event) => {
              setOther((current) => new Map(current).set(question.id, event.target.checked));
              if (!question.multiSelect) setSelected((current) => new Map(current).set(question.id, []));
            }} />
          <span>{t("questionCard.other")}</span>
        </label>}
        {free && <div className="question-free-text">
          <label htmlFor={inputId}>{question.isSecret ? t("questionCard.secretAnswer") : t("questionCard.yourAnswer")}</label>
          {question.isSecret
            ? <input readOnly={expired} id={inputId} type="password" autoComplete="off" spellCheck={false} maxLength={4000}
                value={text.get(question.id) || ""} onCopy={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()}
                onChange={(event) => setText((current) => new Map(current).set(question.id, event.target.value))} />
            : <textarea readOnly={expired} id={inputId} rows={2} maxLength={4000} value={text.get(question.id) || ""}
                onChange={(event) => setText((current) => new Map(current).set(question.id, event.target.value))} />}
          {question.isSecret && <small>{t("questionCard.secretHint")}</small>}
        </div>}
      </fieldset>;
    })}
    {(localError || error) && <p className="question-error" role="alert">{localError ? messageText(localError) : error}</p>}
    {expired ? <p className="question-hint" role="status">{t("questionCard.expired")}</p>
      : status !== "requested" || finished ? <p className="question-hint" role="status">{t("questionCard.completed")}</p>
      : <>
        <div className="question-actions"><button type="submit" disabled={disabled}>{sending ? t("questionCard.sending") : t("questionCard.submit")}</button>
          <button type="button" disabled={disabled} onClick={() => void send(true)}>{t("questionCard.reject")}</button></div>
        <p className="question-hint">{t("questionCard.submitHint")}
          {Number.isFinite(deadline) && ` ${t("questionCard.deadlineHint", { count: Math.max(0, Math.ceil((deadline - now) / 1000)) })}`}</p>
      </>}
    {expired && onRetry && <button type="button" onClick={onRetry}>{t("questionCard.retry")}</button>}
  </form>;
}
