import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { DEPT_LEVELS, DEPT_PALETTES, ICON_PACKS, MODULE_SECTIONS, PREF_KEYS, hiddenForProfile, type DeptLevel, type DeptPalette, type IconPackId, type Mode, type Prefs, type Profile } from '../../../server/services/appearance-model';
import { ICONS, Icon, type IconName } from '../icons';
import { Check } from '../ui';
import { contrast, deriveAccent, isHex } from './color';
import { buildVars, modeTokens, resolveAccent } from './css';
import { DEPTS } from './depts';
import { ProfileGrid, ProfilePreview } from './Profiles';
import { resolveDark, setShowAll, update, useLook } from './store';
import { THEME_LIST, type ModeTokens } from './themes';
import { SpatialCard } from '../xr/SpatialCard';
import { GoalCard } from '../areas/GoalSetup';

/**
 * Einstellungen → Darstellung: theme gallery with live mini previews, hell/dunkel/system, accent colour,
 * department colours, sidebar, icon pack, density, font size and which menu areas stay visible.
 * Everything applies at once (store.update); groups the agency locked are shown but disabled.
 */

const ACCENTS = ['#2563eb', '#0ea5e9', '#06b6d4', '#14b8a6', '#16a34a', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#475569'];
const MODE_LABEL: [Mode, string][] = [
  ['light', 'Hell'],
  ['dark', 'Dunkel'],
  ['system', 'Wie das System'],
];
const DEPT_LEVEL_LABEL: Record<DeptLevel, string> = { off: 'Aus', subtle: 'Dezent', clear: 'Klar', vibrant: 'Vibrant' };
const DEPT_LEVEL_HINT: Record<DeptLevel, string> = {
  off: 'Keine Bereichsfarben – alles in der Akzentfarbe.',
  subtle: 'Farbige Symbole, ein Streifen an der offenen Seite und am Seitenkopf.',
  clear: 'Getönte Menüpunkte und ein getönter Seitenkopf.',
  vibrant: 'Verlauf im offenen Menüpunkt und im Seitenkopf.',
};
const PALETTE_LABEL: Record<DeptPalette, [string, string]> = {
  harmonic: ['Harmonisch', 'Farben rund um deine Akzentfarbe – ein ruhiges Gesamtbild.'],
  rainbow: ['Regenbogen', 'Gleichmäßig verteilt und kräftig – am leichtesten zu unterscheiden.'],
  muted: ['Gedeckt', 'Dieselbe Verteilung, aber zurückgenommen.'],
};
const PACKS: Record<IconPackId, [string, string]> = {
  line: ['Linien', 'Der Standard: klare Linien.'],
  fine: ['Fein', 'Dünne, leichte Linien.'],
  bold: ['Kräftig', 'Dicke, abgerundete Linien.'],
  square: ['Eckig', 'Kantig wie ein Pixel-Raster.'],
  duotone: ['Duotone', 'Linien mit zarter Farbfläche in der Bereichsfarbe.'],
  solid: ['Gefüllt', 'Handgezeichnete, gefüllte Symbole für das Menü.'],
};
const SAMPLE_ICONS: IconName[] = ['dashboard', 'contacts', 'calendars', 'invoices', 'settings'];

function Lock({ on }: { on?: boolean }) {
  return on ? (
    <span className="ap-lock" title="Von deiner Agentur festgelegt">
      <Icon name="lock" size={13} /> Festgelegt
    </span>
  ) : null;
}

function Section({ title, tour, lock, children, hint }: { title: string; tour: string; lock?: boolean; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card ap-section" data-tour={tour}>
      <h2>
        {title} <Lock on={lock} />
      </h2>
      {hint && <p className="muted small" style={{ marginTop: -4 }}>{hint}</p>}
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)} disabled={disabled}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** A tiny app frame in a theme's colours. */
function Frame({ k, accent }: { k: ModeTokens; accent: string }) {
  const style = { '--pv-bg': k.bg, '--pv-panel': k.panel, '--pv-text': k.text, '--pv-muted': k.muted, '--pv-line': k.line, '--pv-side': k.side, '--pv-sidetext': k.sideText, '--pv-acc': accent } as CSSProperties;
  return (
    <div className="ap-prev" style={style} aria-hidden="true">
      <div className="ap-prev-side">
        <i />
        <i className="on" />
        <i />
        <i />
      </div>
      <div className="ap-prev-main">
        <div className="ap-prev-bar" />
        <div className="ap-prev-card">
          <b />
          <u />
          <u style={{ width: '60%' }} />
        </div>
        <div className="ap-prev-btn" />
      </div>
    </div>
  );
}

function Themes({ p, lock }: { p: Prefs; lock: boolean }) {
  const brand = useLook().brandColor;
  return (
    <div className="ap-themes" role="radiogroup" aria-label="Theme">
      {THEME_LIST.map((t) => {
        const accent = (dark: boolean) => resolveAccent({ theme: t.id, accent: p.accent, palette: p.dept_palette, brandColor: brand }, dark);
        return (
          <button key={t.id} className={`ap-theme${p.theme === t.id ? ' on' : ''}`} onClick={() => void update({ theme: t.id })} disabled={lock} role="radio" aria-checked={p.theme === t.id} data-tour={`theme-${t.id}`}>
            <div className="ap-theme-head">
              <span className="ap-theme-name">{t.name}</span>
              {p.theme === t.id && <Icon name="ok" size={16} />}
            </div>
            <div className="ap-pair">
              <Frame k={t.light} accent={accent(false)} />
              <Frame k={t.dark} accent={accent(true)} />
            </div>
            <span className="ap-theme-blurb">{t.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

function AccentPicker({ p, lock }: { p: Prefs; lock: boolean }) {
  const look = useLook();
  const dark = resolveDark(p.mode);
  const k = modeTokens(p.theme, dark);
  const accent = resolveAccent({ theme: p.theme, accent: p.accent, palette: p.dept_palette, brandColor: look.brandColor }, dark);
  const a = deriveAccent(accent, { panel: k.panel, bg: k.bg, text: k.text }, dark);
  const [picked, setPicked] = useState(accent);
  useEffect(() => setPicked(accent), [accent]);
  return (
    <>
      <div className="ap-swatches" role="radiogroup" aria-label="Akzentfarbe">
        <button className={`ap-swatch${!p.accent ? ' on' : ''}`} style={{ background: `linear-gradient(135deg, ${modeTokens(p.theme, false).accent} 50%, ${modeTokens(p.theme, true).accent} 50%)` }} onClick={() => void update({ accent: null })} disabled={lock} title="Standard des Themes" aria-label="Standard des Themes" role="radio" aria-checked={!p.accent} />
        {ACCENTS.map((c) => (
          <button key={c} className={`ap-swatch${p.accent === c ? ' on' : ''}`} style={{ background: c, color: contrast('#fff', c) >= contrast('#000', c) ? '#fff' : '#000' }} onClick={() => void update({ accent: c })} disabled={lock} title={c} aria-label={`Akzentfarbe ${c}`} role="radio" aria-checked={p.accent === c}>
            {p.accent === c && <Icon name="ok" size={15} />}
          </button>
        ))}
        <label className="check small" style={{ margin: '0 0 0 8px' }}>
          Eigene Farbe
          <input type="color" value={isHex(picked) ? picked : '#2563eb'} disabled={lock} onChange={(e) => (setPicked(e.target.value), void update({ accent: e.target.value }, 350))} aria-label="Eigene Akzentfarbe" style={{ width: 44, height: 30, padding: 1 }} />
        </label>
      </div>
      <div className="ap-accent-preview" data-tour="appearance-accent-preview">
        <button className="btn" type="button">
          Speichern
        </button>
        <button className="btn secondary" type="button">
          Abbrechen
        </button>
        <a href="#" onClick={(e) => e.preventDefault()}>
          Ein Link
        </a>
        <span className="tag">Tag</span>
        <input type="text" defaultValue="Fokus-Ring" style={{ width: 150 }} aria-label="Beispiel-Eingabefeld" />
        <span className="muted small">
          Text auf der Farbe: {a.on === '#ffffff' ? 'Weiß' : 'Schwarz'} ({contrast(a.on, a.brand).toFixed(1)}:1) – Links {contrast(a.text, k.panel).toFixed(1)}:1
        </span>
      </div>
    </>
  );
}

function DeptSection({ p, lock }: { p: Prefs; lock: boolean }) {
  const look = useLook();
  const dark = resolveDark(p.mode);
  return (
    <Section title="Bereichsfarben" tour="appearance-dept" lock={lock} hint="Jeder Bereich hat seine eigene Farbe, damit du dich auf einen Blick zurechtfindest.">
      <Seg label="Intensität" value={p.dept} options={DEPT_LEVELS.map((l) => [l, DEPT_LEVEL_LABEL[l]] as [DeptLevel, string])} onChange={(v) => void update({ dept: v })} disabled={lock} />
      <p className="muted small">{DEPT_LEVEL_HINT[p.dept]}</p>
      <div className="ap-pal" role="radiogroup" aria-label="Palette">
        {DEPT_PALETTES.map((id) => {
          const vars = buildVars({ theme: p.theme, accent: p.accent, palette: id, brandColor: look.brandColor }, dark);
          return (
            <button key={id} className={p.dept_palette === id ? 'on' : ''} onClick={() => void update({ dept_palette: id })} disabled={lock} role="radio" aria-checked={p.dept_palette === id} data-tour={`palette-${id}`}>
              <b>{PALETTE_LABEL[id][0]}</b>
              <span className="ap-pal-strip">
                {DEPTS.map((d) => (
                  <i key={d.id} style={{ background: `linear-gradient(120deg, ${vars[`--d-${d.id}`]}, ${vars[`--d-${d.id}-2`]})` }} />
                ))}
              </span>
              <span className="muted small">{PALETTE_LABEL[id][1]}</span>
            </button>
          );
        })}
      </div>
      <Check checked={p.dept_tint} onChange={(v) => void update({ dept_tint: v })} label="Auch Buttons, Links und Reiter auf den Seiten eines Bereichs in dessen Farbe" tour="appearance-dept-tint" />
      <div className="ap-dept-row">
        {DEPTS.map((d) => (
          <span key={d.id} className="ap-dept-chip" data-dept={d.id}>
            {d.label}
          </span>
        ))}
      </div>
    </Section>
  );
}

function PackIcons({ id }: { id: IconPackId }) {
  const [solid, setSolid] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (id === 'solid') void import('./packs/solid').then((m) => setSolid(m.SOLID as Record<string, string>));
  }, [id]);
  return (
    <div className="ap-pack-icons" data-pack={id}>
      {SAMPLE_ICONS.map((n) => {
        if (id === 'solid' && solid?.[n]) return <svg key={n} className="ico ico-solid" viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden="true" dangerouslySetInnerHTML={{ __html: solid[n] }} />;
        const C = ICONS[n];
        return <C key={n} size={22} strokeWidth={1.8} className="ico" aria-hidden="true" />;
      })}
    </div>
  );
}

function Modules({ p, lock }: { p: Prefs; lock: boolean }) {
  const look = useLook();
  const [pick, setPick] = useState<Profile | null>(null);
  const hidden = new Set(p.hidden);
  const toggle = (id: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    void update({ hidden: [...next], profile: '' });
  };
  return (
    <Section
      title="Sichtbare Bereiche"
      tour="appearance-modules"
      lock={lock}
      hint={
        <>
          Blende aus, was du nicht brauchst: ausgeblendete Bereiche verschwinden aus Menü, Suche, Strg K und Dashboard. Das ist nur eine Ansicht – <b>keine Berechtigung</b>: nichts wird gelöscht, die Rechte der Agentur bleiben gleich, und über „Alle Bereiche anzeigen“ unten im Menü (oder die Adresse) ist alles erreichbar.
        </>
      }
    >
      <h3 style={{ margin: '4px 0 8px' }}>Starter-Profil</h3>
      <ProfileGrid value={pick?.id ?? p.profile} onPick={setPick} disabled={lock} />
      {pick && (
        <div style={{ marginTop: 10 }}>
          <ProfilePreview profile={pick} />
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn" disabled={lock} onClick={async () => (await update({ hidden: hiddenForProfile(pick.id), profile: pick.id, asked: true }), setPick(null))} data-tour="profile-apply">
              „{pick.label}“ übernehmen
            </button>
            <button className="btn secondary" onClick={() => setPick(null)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
      <h3 style={{ margin: '16px 0 4px' }}>Einzeln</h3>
      {MODULE_SECTIONS.map((s) => (
        <div key={s.id} className="ap-mod-sec">
          <h3>{s.label}</h3>
          <div className="ap-mods">
            {s.modules.map(([id, label]) => (
              <Check key={id} checked={!hidden.has(id)} onChange={(v) => !lock && toggle(id, v)} label={label} />
            ))}
          </div>
        </div>
      ))}
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="btn secondary small" disabled={lock || !hidden.size} onClick={() => void update({ hidden: [], profile: 'all' })}>
          Alle einblenden
        </button>
        <button className="btn secondary small" onClick={() => setShowAll(!look.showAll)}>
          {look.showAll ? 'Ausgeblendete im Menü verbergen' : 'Im Menü vorübergehend alles zeigen'}
        </button>
      </div>
    </Section>
  );
}

export function Appearance() {
  const look = useLook();
  const p = look.prefs;
  const L = look.locks;
  return (
    <div style={{ maxWidth: 1100 }}>
      <p className="muted">Deine Darstellung gilt für dein Konto – auf jedem Gerät. Jede Änderung wirkt sofort{Object.values(L).some(Boolean) ? '; was deine Agentur festgelegt hat, ist gesperrt' : ''}.</p>

      <GoalCard goals={p.goals} locked={!!L.modules} />

      <Section title="Theme" tour="appearance-theme" lock={L.theme} hint="Jedes Theme gibt es hell und dunkel; links die helle, rechts die dunkle Ansicht.">
        <div data-tour="appearance-mode" style={{ marginBottom: 12 }}>
          <Seg label="Modus" value={p.mode} options={MODE_LABEL} onChange={(v) => void update({ mode: v })} disabled={L.theme} />
        </div>
        <Themes p={p} lock={!!L.theme} />
      </Section>

      <Section title="Akzentfarbe" tour="appearance-accent" lock={L.accent} hint="Für Buttons, Links, Auswahl und Fokus. Hover-Farbe und lesbare Schrift (schwarz oder weiß) werden automatisch abgeleitet.">
        <AccentPicker p={p} lock={!!L.accent} />
      </Section>

      <DeptSection p={p} lock={!!L.dept} />

      <Section title="Seitenleiste" tour="appearance-sidebar" lock={L.sidebar} hint="„Nur Symbole“ macht die Leiste schmal – Namen erscheinen beim Darüberfahren. Umschalten mit Strg B (⌘ B). Am Handy bleibt das ausklappbare Menü.">
        <Seg
          label="Seitenleiste"
          value={p.sidebar}
          options={[
            ['full', 'Voll'],
            ['rail', 'Nur Symbole'],
          ]}
          onChange={(v) => void update({ sidebar: v })}
          disabled={L.sidebar}
        />
      </Section>

      <Section title="Icon-Pack" tour="appearance-icons" lock={L.icons}>
        <div className="ap-packs" role="radiogroup" aria-label="Icon-Pack">
          {ICON_PACKS.map((id) => (
            <button key={id} className={`ap-pack${p.icons === id ? ' on' : ''}`} onClick={() => void update({ icons: id })} disabled={!!L.icons} role="radio" aria-checked={p.icons === id} data-tour={`pack-${id}`}>
              <b>{PACKS[id][0]}</b>
              <PackIcons id={id} />
              <span className="muted small">{PACKS[id][1]}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Dichte und Schrift" tour="appearance-density" lock={L.density}>
        <div className="row">
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              Dichte
            </div>
            <Seg
              label="Dichte"
              value={p.density}
              options={[
                ['compact', 'Kompakt'],
                ['normal', 'Normal'],
                ['comfortable', 'Komfortabel'],
              ]}
              onChange={(v) => void update({ density: v })}
              disabled={L.density}
            />
          </div>
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>
              Schriftgröße
            </div>
            <Seg
              label="Schriftgröße"
              value={p.font}
              options={[
                ['small', 'Klein'],
                ['normal', 'Normal'],
                ['large', 'Groß'],
              ]}
              onChange={(v) => void update({ font: v })}
              disabled={L.density}
            />
          </div>
        </div>
      </Section>

      <SpatialCard p={p} />

      <Modules p={p} lock={!!L.modules} />

      <div className="actions" data-tour="appearance-reset">
        <button
          className="btn secondary"
          onClick={() => void update(Object.fromEntries(PREF_KEYS.filter((k) => k !== 'asked' && k !== 'goal_asked' && k !== 'tile_order').map((k) => [k, null])) as { [K in keyof Prefs]?: null })}
        >
          <Icon name="reset" size={15} /> Auf Standard zurücksetzen
        </button>
        <span className="muted small">Setzt alles zurück, was du selbst gewählt hast (nicht, was die Agentur festgelegt hat).</span>
      </div>
    </div>
  );
}
