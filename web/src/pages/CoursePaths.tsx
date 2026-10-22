import { useState } from 'react';
import { api, d, name } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, TagInput, Textarea, act, confirmAsk, useLoad } from '../ui';
import './CourseDepth.css';
import { getLocale, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

/** Lernpfade: eine Folge von Kursen mit Freischalt-Regel, vergeben per Tag, Kauf oder von Hand. Server: modules/course-paths.ts. */

type Path = {
  id: string;
  title: string;
  slug: string;
  description: string;
  status: 'draft' | 'published';
  sequential: boolean;
  unlock_percent: number;
  access: { tags?: string[]; product_ids?: string[] };
  items: { course_id: string; title: string; status: string }[];
  members: number;
  completed: number;
};

function PathMembers({ path, onClose, onChanged }: { path: Path; onClose: () => void; onChanged: () => void }) {
  const t = useT('courses');
  const list = useLoad(() => api.get<any[]>(`/api/courses/paths/${path.id}/members`), [path.id]);
  const [email, setEmail] = useState('');
  const add = async () => {
    const r = await act(() => api.post(`/api/courses/paths/${path.id}/members`, { email }), t('Lernpfad freigeschaltet'));
    if (r) (setEmail(''), void list.reload(), onChanged());
  };
  return (
    <Modal title={t('Teilnehmer: {name}', { name: path.title })} onClose={onClose} wide>
      <div className="cd">
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <Input type="email" value={email} onChange={setEmail} placeholder={t('E-Mail der Person')} aria-label={t('E-Mail')} onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && void add()} />
          <button className="btn" disabled={!email.includes('@')} onClick={add}>
            {t('Freischalten')}
          </button>
        </div>
        <p className="cd-hint">{t('Schaltet alle Kurse des Lernpfads frei. Entziehst du den Lernpfad, gehen nur die Zugänge weg, die über ihn kamen.')}</p>
        {!list.data ? (
          <Spinner />
        ) : !list.data.length ? (
          <Empty>{t('Noch niemand im Lernpfad.')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{t('Person')}</th>
                  <th>{t('Quelle')}</th>
                  <th>{t('Fortschritt')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((m) => (
                  <tr key={m.contact_id}>
                    <td>
                      {name(m)} <span className="muted small">{m.email}</span>
                    </td>
                    <td className="muted small">
                      {m.source === 'tag' ? t('Tag') : m.source === 'purchase' ? t('Kauf') : m.source === 'api' ? 'API' : t('manuell')} {t('· seit {date}', { date: d(m.enrolled_at) })}
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <div className="cd-meter green" title={(m.steps ?? []).map((s: any) => `${s.title}: ${s.state === 'done' ? t('fertig') : s.state === 'locked' ? t('gesperrt') : getLocale() === SOURCE_LOCALE ? `${s.percent ?? 0} %` : `${s.percent ?? 0}%`}`).join('\n')}>
                        <span style={{ width: `${m.percent}%` }} />
                      </div>
                      <span className="muted small">{m.percent} %{m.completed_at ? t(' · abgeschlossen') : ''}</span>
                    </td>
                    <td>
                      <button className="btn small ghost" onClick={async () => confirmAsk(t('{name} den Lernpfad entziehen?', { name: name(m) })) && (await act(() => api.del(`/api/courses/paths/${path.id}/members/${m.contact_id}`), t('Entzogen'))) && (void list.reload(), onChanged())}>
                        {t('Entziehen')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PathEditor({ path, courses, onClose, onSaved }: { path?: Path; courses: any[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('courses');
  const tags = useLoad(() => api.get<any[]>('/api/tags').catch(() => []), []);
  const products = useLoad(() => api.get<any[]>('/api/products').catch(() => []), []);
  const [f, setF] = useState({
    title: path?.title ?? '',
    description: path?.description ?? '',
    status: path?.status ?? 'draft',
    sequential: path?.sequential ?? true,
    unlock_percent: path?.unlock_percent ?? 100,
    tags: path?.access?.tags ?? [],
    product_ids: path?.access?.product_ids ?? [],
    items: path?.items.map((i) => i.course_id) ?? ([] as string[]),
  });
  const title = (id: string) => courses.find((c) => c.id === id)?.title ?? id;
  const move = (i: number, dir: number) => {
    const a = [...f.items];
    [a[i], a[i + dir]] = [a[i + dir], a[i]];
    setF({ ...f, items: a });
  };
  const save = async () => {
    const body = { title: f.title, description: f.description, status: f.status, sequential: f.sequential, unlock_percent: f.unlock_percent, items: f.items, access: { tags: f.tags, product_ids: f.product_ids } };
    const r = await act(() => (path ? api.patch(`/api/courses/paths/${path.id}`, body) : api.post('/api/courses/paths', body)), t('Lernpfad gespeichert'));
    if (r) onSaved();
  };
  const free = courses.filter((c) => !f.items.includes(c.id));
  return (
    <Modal title={path ? t('Lernpfad bearbeiten') : t('Neuer Lernpfad')} onClose={onClose} wide>
      <div className="cd">
        <div className="grid2">
          <div>
            <Field label={t('Titel')}>
              <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} autoFocus />
            </Field>
            <Field label={t('Beschreibung')}>
              <Textarea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={3} maxLength={3000} />
            </Field>
            <Field label={t('Status')}>
              <Select value={f.status} onChange={(v) => setF({ ...f, status: v as 'draft' | 'published' })} options={[['draft', t('Entwurf (Mitglieder sehen ihn nicht)')], ['published', t('Veröffentlicht')]]} />
            </Field>
          </div>
          <div>
            <Field label={t('Kurse in diesem Lernpfad')} hint={t('Die Reihenfolge ist die Lernreihenfolge.')}>
              {f.items.length ? (
                <ol className="cd-path-items">
                  {f.items.map((id, i) => (
                    <li key={id}>
                      <span className="n">{i + 1}</span>
                      <span className="grow">{title(id)}</span>
                      <button type="button" className="icon-btn" disabled={!i} onClick={() => move(i, -1)} aria-label={t('Nach oben')}>
                        ↑
                      </button>
                      <button type="button" className="icon-btn" disabled={i === f.items.length - 1} onClick={() => move(i, 1)} aria-label={t('Nach unten')}>
                        ↓
                      </button>
                      <button type="button" className="icon-btn" onClick={() => setF({ ...f, items: f.items.filter((x) => x !== id) })} aria-label={t('Entfernen')}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="muted small">{t('Noch kein Kurs gewählt.')}</span>
              )}
            </Field>
            {!!free.length && <Select value="" onChange={(v) => v && setF({ ...f, items: [...f.items, v] })} placeholder={t('+ Kurs hinzufügen')} options={free.map((c) => [c.id, c.title])} />}
          </div>
        </div>
        <h3>{t('Freischalt-Regel')}</h3>
        <Check checked={f.sequential} onChange={(v) => setF({ ...f, sequential: v })} label={t('Der Reihe nach: der nächste Kurs öffnet erst, wenn der davor weit genug ist')} />
        {f.sequential && (
          <Field label={t('… das heißt ab wie viel Prozent?')} hint={t('100 = Kurs ganz abgeschlossen. Gilt nur für Zugänge, die über den Lernpfad kamen – wer einen Kurs separat gekauft hat, ist nie gesperrt.')}>
            <Input type="number" min={1} max={100} value={f.unlock_percent} onChange={(v) => setF({ ...f, unlock_percent: Math.min(100, Math.max(1, Number(v) || 100)) })} />
          </Field>
        )}
        <h3>{t('Zugang')}</h3>
        <Field label={t('Zugang mit diesen Tags')} hint={path ? t('Wer einen dieser Tags bekommt, hat den Lernpfad sofort.') : t('Ohne eigene Tags vergibt der Lernpfad „pfad:<adresse>“.')}>
          <TagInput value={f.tags} onChange={(v) => setF({ ...f, tags: v })} suggestions={(tags.data ?? []).map((tag: any) => tag.name)} />
        </Field>
        <Field label={t('Zugang beim Kauf dieser Produkte')}>
          {(products.data ?? []).length ? (
            <div className="check-list">
              {(products.data ?? []).map((p: any) => (
                <Check key={p.id} checked={f.product_ids.includes(p.id)} onChange={(on) => setF({ ...f, product_ids: on ? [...f.product_ids, p.id] : f.product_ids.filter((x) => x !== p.id) })} label={p.name} />
              ))}
            </div>
          ) : (
            <span className="muted small">{t('Noch keine Produkte angelegt (Umsatz → Produkte).')}</span>
          )}
        </Field>
        <div className="actions">
          <button className="btn" disabled={!f.title.trim()} onClick={save}>
            {t('Speichern')}
          </button>
          <button className="btn ghost" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function LearningPaths() {
  const t = useT('courses');
  const list = useLoad(() => api.get<Path[]>('/api/courses/paths'), []);
  const courses = useLoad(() => api.get<any[]>('/api/courses'), []);
  const [edit, setEdit] = useState<Path | 'new' | null>(null);
  const [members, setMembers] = useState<Path | null>(null);
  return (
    <div className="cd" data-tour="learning-paths">
      <div className="cd-bar">
        <button className="btn" onClick={() => setEdit('new')} disabled={!courses.data?.length}>
          {t('+ Lernpfad')}
        </button>
        <span className="muted small grow">{t('Ein Lernpfad bündelt mehrere Kurse zu einem Programm – zum Beispiel „Grundlagen → Aufbau → Praxis“ –, optional mit fester Reihenfolge.')}</span>
      </div>
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <Empty>{courses.data?.length ? t('Noch keine Lernpfade.') : t('Lege zuerst Kurse an – ein Lernpfad besteht aus Kursen.')}</Empty>
      ) : (
        <SortableGrid id="course-paths" className="cd-grid">
          {list.data.map((p) => (
            <div key={p.id} className="cd-card">
              <h3>{p.title}</h3>
              <div className="cd-badges">
                <Badge tone={p.status === 'published' ? 'green' : 'gray'}>{p.status === 'published' ? t('Veröffentlicht') : t('Entwurf')}</Badge>
                <Badge>{p.items.length} {t('Kurs')}{p.items.length === 1 ? '' : 'e'}</Badge>
                {p.sequential && <Badge tone="blue">{t('der Reihe nach')}</Badge>}
              </div>
              <ol className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                {p.items.map((i) => (
                  <li key={i.course_id}>{i.title}</li>
                ))}
              </ol>
              <div className="muted small">
                {t.plural(p.members, { other: '{n} Teilnehmer, {done} fertig' }, { done: p.completed })}
              </div>
              <div className="actions" style={{ marginTop: 'auto' }}>
                <button className="btn small secondary" onClick={() => setMembers(p)}>
                  {t('Teilnehmer')}
                </button>
                <button className="btn small ghost" onClick={() => setEdit(p)}>
                  {t('Bearbeiten')}
                </button>
                <button className="btn small ghost danger-text" onClick={async () => confirmAsk(t('Lernpfad „{title}“ löschen? Die Kurse und die Zugänge bleiben bestehen.', { title: p.title })) && (await act(() => api.del(`/api/courses/paths/${p.id}`), t('Lernpfad gelöscht'))) && void list.reload()}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
          ))}
        </SortableGrid>
      )}
      {edit && <PathEditor path={edit === 'new' ? undefined : edit} courses={courses.data ?? []} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), void list.reload())} />}
      {members && <PathMembers path={members} onClose={() => setMembers(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}
