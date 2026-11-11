/**
 * A translator for texts the server builds in German, with values inside. Keys are the German texts; `{v0}`,
 * `{v1}` … stand for the values of a template literal (in order). A text matches a key exactly, or a key's fixed parts
 * with anything in the gaps (the values are translated too, when they are known texts such as field names; a value
 * that stays German prose keeps the whole text German). Lines joined
 * with " · " are translated part by part. Unknown texts stay as they are.
 */
export type Translator = (de: string) => string;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A value left in German prose: filling it into an English frame would give a half-German sentence. */
const GERMAN = /[äöüÄÖÜß]|\b(der|die|das|des|dem|den|ein|eine|einen|einer|eines|und|oder|nicht|ist|sind|für|von|vom|mit|im|zum|zur|bei|kein|keine|fehlt|ungültig)\b/i;

export function makeTranslator(map: Record<string, string>): Translator {
  let patterns: { re: RegExp; en: string; frame: number }[] | undefined;
  const compiled = () =>
    (patterns ??= Object.entries(map)
      .filter(([de]) => /\{v\d\}/.test(de))
      // a frame like "{v0} über {v1}" would match whole sentences, so open-ended patterns need enough fixed text
      .filter(([de]) => !(/^\{v\d\}/.test(de) && /\{v\d\}$/.test(de) && de.replace(/\{v\d\}/g, '').length < 12))
      .map(([de, en]) => ({
        re: new RegExp(`^${de.split(/(\{v\d\})/).map((p) => (/^\{v\d\}$/.test(p) ? '([\\s\\S]*?)' : escape(p))).join('')}$`),
        en,
        frame: de.replace(/\{v\d\}/g, '').length,
      }))
      // more fixed text first, so the most specific pattern wins
      .sort((x, y) => y.frame - x.frame));
  const t = (de: string, depth: number): string => {
    if (!de) return de;
    const exact = map[de];
    if (exact !== undefined) return exact;
    if (depth > 3) return de;
    for (const p of compiled()) {
      const m = p.re.exec(de);
      if (!m) continue;
      const vals = m.slice(1).map((v) => {
        const en = t(v ?? '', depth + 1);
        return { en, german: en === v && GERMAN.test(v) };
      });
      // a value we cannot translate keeps the whole text German rather than mixing the two languages
      if (vals.some((v) => v.german)) continue;
      return p.en.replace(/\{v(\d)\}/g, (_, i: string) => vals[Number(i)]?.en ?? '');
    }
    if (de.includes(' · ')) return de.split(' · ').map((x) => t(x, depth + 1)).join(' · ');
    return de;
  };
  return (de: string) => t(de, 0);
}
