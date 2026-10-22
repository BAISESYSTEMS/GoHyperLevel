import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { Tabs, useFocusLayer } from '../ui';
import { useLook } from '../theme/store';
import { AGENCY_GROUPS, AGENCY_KEYWORDS, groupTabs, searchTabs, SETTINGS_GROUPS, SETTINGS_KEYWORDS, splitAgencyTabs, splitSettingsTabs, type TabGroup } from './settings-nav';
import './settings-easy.css';

/**
 * The tab bars of Einstellungen and Agentur. Einfach-Modus: the essential sections (rules: ./settings-nav.ts) plus a
 * "Weitere Einstellungen" / "Weitere Bereiche" button – a small dialog with every other section, grouped, and a search over
 * all sections (labels and search words such as SMTP, IBAN, Webhook). ✕, Esc and a click beside it close it. Profi: the
 * plain tabs, exactly as before.
 */

type TabsProps = { tabs: [string, string][]; value: string; onChange: (v: string) => void };

export function SettingsTabs(props: TabsProps) {
  const t = useT('simple');
  const goals = useLook().prefs.goals;
  const split = splitSettingsTabs(
    props.tabs.map(([k]) => k),
    { goals, current: props.value },
  );
  return <FoldedTabs {...props} split={split} groups={SETTINGS_GROUPS} keywords={SETTINGS_KEYWORDS} title={t('Weitere Einstellungen')} tour="settings-more" />;
}

export function AgencyTabs(props: TabsProps) {
  const t = useT('simple');
  const goals = useLook().prefs.goals;
  const split = splitAgencyTabs(
    props.tabs.map(([k]) => k),
    { goals, current: props.value },
  );
  return <FoldedTabs {...props} split={split} groups={AGENCY_GROUPS} keywords={AGENCY_KEYWORDS} title={t('Weitere Bereiche')} tour="agency-more" />;
}

function FoldedTabs({ tabs, value, onChange, split, groups, keywords, title, tour }: TabsProps & { split: { main: string[]; more: string[] }; groups: readonly TabGroup[]; keywords: Readonly<Record<string, string>>; title: string; tour: string }) {
  const [open, setOpen] = useState(false);
  if (!split.more.length) return <Tabs tabs={tabs} value={value} onChange={onChange} />;
  return (
    <div className="set-tabs">
      <Tabs tabs={tabs.filter(([k]) => split.main.includes(k))} value={value} onChange={onChange} />
      <div className="set-more">
        <button type="button" className="btn secondary small" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} data-tour={tour}>
          {title} <span className="muted">({split.more.length})</span>
        </button>
        {open && (
          <MoreTabs
            tabs={tabs}
            more={split.more}
            groups={groups}
            keywords={keywords}
            title={title}
            onPick={(k) => {
              setOpen(false);
              onChange(k);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function MoreTabs({ tabs, more, groups, keywords, title, onPick, onClose }: { tabs: [string, string][]; more: string[]; groups: readonly TabGroup[]; keywords: Readonly<Record<string, string>>; title: string; onPick: (k: string) => void; onClose: () => void }) {
  const t = useT('simple');
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useFocusLayer(box, onClose, { first: 'input' });
  const label = Object.fromEntries(tabs) as Record<string, string>;
  const GROUP: Record<string, string> = {
    messages: t('Nachrichten & Kanäle'),
    money: t('Rechnungen & Zahlungen'),
    ai: t('KI'),
    service: t('Service'),
    data: t('Daten, Recht & Schnittstellen'),
    account: t('Konto & Team'),
    overview: t('Über alle Projekte'),
    clients: t('Kunden & Vorlagen'),
    brand: t('Marke & Anmeldung'),
    connect: t('Integrationen, API & KI'),
    system: t('Protokoll & System'),
    other: t('Sonstiges'),
  };
  const hits = q.trim() ? searchTabs(q, tabs, keywords) : null;
  const item = (k: string) => (
    <li key={k}>
      <button type="button" onClick={() => onPick(k)} data-tour={`more-tab-${k}`}>
        {label[k]}
      </button>
    </li>
  );
  return (
    <>
      <div className="set-more-bg" onMouseDown={onClose} />
      <div ref={box} className="set-more-menu" role="dialog" aria-modal="true" aria-label={title}>
        <div className="set-more-head">
          <strong>{title}</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
            ✕
          </button>
        </div>
        <input className="set-more-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Suchen …')} aria-label={t('Suchen …')} />
        <div className="set-more-body">
          {hits ? (
            hits.length ? <ul>{hits.map(item)}</ul> : <p className="muted small">{t('Nichts gefunden.')}</p>
          ) : (
            groupTabs(more, groups).map((g) => (
              <section key={g.id}>
                <h3>{GROUP[g.id] ?? g.id}</h3>
                <ul>{g.tabs.map(item)}</ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}
