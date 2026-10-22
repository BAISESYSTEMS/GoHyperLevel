import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { Field, Select } from '../ui';
import { isLocale, localeNames, useLocale, useT, type Locale } from './index';
import { chooseLocale } from './session';
import './i18n.css';

/** The language switch in three places: the sidebar's account corner, the login card and Settings → Mein Konto. */

/** Sidebar footer: a button that opens the list of languages (each named in its own language). */
export function LanguageMenu({ className = 'side-iconbtn', tip }: { className?: string; tip?: (label: string) => React.ButtonHTMLAttributes<HTMLButtonElement> }) {
  const t = useT('core');
  const locale = useLocale();
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pos) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setPos(null), button.current?.focus());
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', off), window.removeEventListener('keydown', esc));
  }, [pos]);
  const current = localeNames().find((l) => l.id === locale)?.name ?? locale;
  const label = t('Sprache: {name}', { name: current });
  const pick = async (l: Locale) => {
    setBusy(true);
    await chooseLocale(l, true);
    setBusy(false);
    setPos(null);
    button.current?.focus();
  };
  return (
    <span className="lang-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        aria-label={label}
        data-tour="nav-language"
        {...(tip ? tip(label) : { title: label })}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos(pos ? null : { left: Math.max(8, Math.min(r.left, window.innerWidth - 196)), bottom: window.innerHeight - r.top + 6 });
        }}
      >
        <Icon name="languages" size={17} />
      </button>
      {pos && (
        <div className="lang-pop" role="menu" aria-label={t('Sprache')} style={pos}>
          {localeNames().map(({ id, name }) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={id === locale} lang={id} disabled={busy} autoFocus={id === locale} onClick={() => void pick(id)}>
              <span className="grow">{name}</span>
              {id === locale && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Login, setup and consent screens: the languages side by side – a bilingual name, so it is found whatever is on screen. */
export function LanguageLinks() {
  const locale = useLocale();
  return (
    <nav className="lang-links" aria-label="Sprache · Language" /* i18n-ignore (bilingual on purpose) */>
      {localeNames().map(({ id, name }) => (
        <button key={id} type="button" lang={id} aria-pressed={id === locale} onClick={() => void chooseLocale(id, false)}>
          {name}
        </button>
      ))}
    </nav>
  );
}

/** Settings → Mein Konto. */
export function LanguageField() {
  const t = useT('core');
  const locale = useLocale();
  return (
    <Field label={t('Sprache')} tour="account-language" hint={t('Gilt für dich auf allen Geräten. Bereiche, die noch nicht übersetzt sind, bleiben vorerst Deutsch.')}>
      <Select value={locale} onChange={(v) => isLocale(v) && void chooseLocale(v, true)} options={localeNames().map((l) => [l.id, l.name] as [string, string])} />
    </Field>
  );
}
