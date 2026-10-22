import { useState } from 'react';
import { api } from '../api';
import { MoreFields } from '../areas/fields';
import { useT } from '../i18n';
import { Badge, Check, Empty, Field, Input, Modal, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';

/**
 * Kalender → Leistungsmenüs (modules/service-menu.ts, docs/booking.md#service-menu): a public page that lists booking calendars as
 * services in categories; visitors pick a service, a person (round robin) and a time. A service is a calendar – duration, price,
 * questions and team stay in the calendar's settings.
 */

type Menu = { id?: string; name: string; slug?: string; intro: string; staff_choice: boolean; active?: boolean; categories: { name: string; calendar_ids: string[] }[]; url?: string };

export function ServiceMenus({ calendars }: { calendars: any[] }) {
  const t = useT('parity');
  const list = useLoad(() => api.get<Menu[]>('/api/service-menus'), []);
  const [edit, setEdit] = useState<Menu | null>(null);
  return (
    <div>
      <p className="muted">{t('Eine Seite mit all deinen Leistungen: Besucher wählen Leistung, Person und Termin. Jede Leistung ist ein Kalender.')}</p>
      <div className="actions">
        <button className="tx-btn primary" disabled={!calendars.length} onClick={() => setEdit({ name: '', intro: '', staff_choice: true, categories: [{ name: t('Leistungen'), calendar_ids: [] }] })}>
          + {t('Leistungsmenü')}
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty>{t('Noch kein Leistungsmenü.')}</Empty>
      ) : (
        list.data.map((m) => (
          <div key={m.id} className="card">
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ margin: 0 }}>
                  {m.name} {!m.active && <Badge>{t('inaktiv')}</Badge>}
                </h2>
                <span className="muted">{t('{n} Leistungen', { n: m.categories.reduce((s, c) => s + c.calendar_ids.length, 0) })}</span>
              </div>
              <div className="actions">
                <a className="tx-btn" href={m.url} target="_blank" rel="noreferrer">
                  {t('Öffnen')} ↗
                </a>
                <button className="tx-btn" onClick={() => setEdit(m)}>
                  {t('Bearbeiten')}
                </button>
                <button className="tx-btn danger" onClick={async () => (await confirmAsk(t('„{name}“ löschen?', { name: m.name }))) && act(() => api.del(`/api/service-menus/${m.id}`)).then(list.reload)}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {edit && (
        <MenuEditor
          menu={edit}
          calendars={calendars}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function MenuEditor({ menu, calendars, onClose, onSaved }: { menu: Menu; calendars: any[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('parity');
  const [m, setM] = useState<Menu>(menu);
  const setCat = (i: number, p: Partial<Menu['categories'][number]>) => setM({ ...m, categories: m.categories.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const save = async () => {
    const body = { name: m.name, slug: m.slug || undefined, intro: m.intro, staff_choice: m.staff_choice, active: m.active ?? true, categories: m.categories };
    const r = await act(() => (m.id ? api.patch(`/api/service-menus/${m.id}`, body) : api.post('/api/service-menus', body)), t('Gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={m.id ? t('Leistungsmenü bearbeiten') : t('Neues Leistungsmenü')}
      onClose={onClose}
      wide
      footer={
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={m.name} onChange={(x) => setM({ ...m, name: x })} placeholder={t('z. B. Unsere Leistungen')} />
      </Field>
      {m.categories.map((c, i) => (
        <fieldset key={i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <legend className="muted">{t('Kategorie {n}', { n: i + 1 })}</legend>
          <Field label={t('Name der Kategorie')}>
            <Input value={c.name} onChange={(x) => setCat(i, { name: x })} />
          </Field>
          {calendars.map((cal) => (
            <Check
              key={cal.id}
              checked={c.calendar_ids.includes(cal.id)}
              onChange={(on) => setCat(i, { calendar_ids: on ? [...c.calendar_ids, cal.id] : c.calendar_ids.filter((x) => x !== cal.id) })}
              label={t('{name} · {n} Min.', { name: cal.name, n: cal.duration })}
            />
          ))}
          {m.categories.length > 1 && (
            <button className="btn small ghost" onClick={() => setM({ ...m, categories: m.categories.filter((_, j) => j !== i) })}>
              {t('Kategorie entfernen')}
            </button>
          )}
        </fieldset>
      ))}
      <button className="btn small secondary" disabled={m.categories.length >= 20} onClick={() => setM({ ...m, categories: [...m.categories, { name: '', calendar_ids: [] }] })}>
        + {t('Kategorie')}
      </button>
      <MoreFields id="service-menu-more" values={[m.intro, m.slug && m.id ? '' : m.slug, m.staff_choice ? '' : 'x']}>
        <Field label={t('Einleitung')}>
          <Textarea value={m.intro} onChange={(x) => setM({ ...m, intro: x })} rows={2} />
        </Field>
        <Field label={t('Kurzname im Link')} hint={t('Leer = aus dem Namen')}>
          <Input value={m.slug ?? ''} onChange={(x) => setM({ ...m, slug: x })} />
        </Field>
        <Check checked={m.staff_choice} onChange={(x) => setM({ ...m, staff_choice: x })} label={t('Besucher wählen bei Round-Robin-Kalendern die Person')} />
      </MoreFields>
    </Modal>
  );
}
