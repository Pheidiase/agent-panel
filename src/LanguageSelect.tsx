import { useI18n, type LanguagePreference } from "./i18n";

export function LanguageSelect() {
  const { t, preference, setLanguage } = useI18n();
  return <label className="pref-row">
    <span className="pref-label">{t("language.label")}</span>
    <select value={preference} onChange={event => setLanguage(event.target.value as LanguagePreference)}>
      <option value="tr">{t("language.tr")}</option>
      <option value="en">{t("language.en")}</option>
      <option value="auto">{t("language.auto")}</option>
    </select>
  </label>;
}
