import { useState } from 'react';
import { api, dt } from '../../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../../ui';
import './site.css';
import { useT } from '../../i18n';

/** German labels (message ids of the sites catalog), shown through t(). */
const CODES: [string, string][] = [['301', '301 – dauerhaft (Google übernimmt die neue Adresse)'], ['302', '302 – vorübergehend'], ['307', '307 – vorübergehend, Methode bleibt'], ['308', '308 – dauerhaft, Methode bleibt']];

/** Redirects of a website: exact paths and wildcards (`/blog/*` → `/magazin/$1`), a tester, bulk import and the list of unknown paths. */
export function RedirectsTab({ funnel }: { funnel: any }) {
  const t = useT('sites');
  const r = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/redirects`), [funnel.id]);
  const [draft, setDraft] = useState({ source: '', target: '', code: '301', keep_query: true, note: '' });
  const [test, setTest] = useState({ path: '', out: null as any });
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const d = r.data;
  if (!d) return r.error ? <Empty>{r.error}</Empty> : <Spinner />;

  const add = async (fields = draft) => {
    const row = await act(() => api.post(`/api/funnels/${funnel.id}/redirects`, { ...fields, code: Number(fields.code) }), t('Weiterleitung angelegt'));
    if (row) {
      setDraft({ source: '', target: '', code: '301', keep_query: true, note: '' });
      r.reload();
    }
  };

  return (
    <div className="site-tab" data-tour="site-redirects">
      <div className="card">
        <h3>{t('Neue Weiterleitung')}</h3>
        <p className="muted small">
          {/* i18n-ignore – the other <code> examples stay as they are */}
          {t('Quelle ist ein Pfad dieser Website (')}<code>{t('/alte-seite')}</code>{t(') oder ein Muster mit Stern am Ende (')}<code>/blog/*</code>{t('). Im Ziel steht')} <code>$1</code> {t('(oder')} <code>:splat</code>{t(') für das, was der Stern gefangen hat:')} <code>/blog/*</code> → <code>{t('/magazin/$1')}</code>{t('. Das Ziel ist ein Pfad oder eine https-Adresse.')}
        </p>
        <div className="grid3">
          <Field label={t('Von (Pfad)')}>
            <Input value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })} placeholder={t('/alte-seite oder /blog/*')} />
          </Field>
          <Field label={t('Nach (Pfad oder Adresse)')}>
            <Input value={draft.target} onChange={(v) => setDraft({ ...draft, target: v })} placeholder={t('/neue-seite oder https://…')} />
          </Field>
          <Field label={t('Art')}>
            <Select value={draft.code} onChange={(v) => setDraft({ ...draft, code: v })} options={CODES.map(([k, l]) => [k, t(l)] as [string, string])} />
          </Field>
        </div>
        <Check checked={draft.keep_query} onChange={(v) => setDraft({ ...draft, keep_query: v })} label={t('Parameter der Adresse (?utm_source=…) mitnehmen')} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" disabled={!draft.source || !draft.target} onClick={() => add()}>
            {t('Anlegen')}
          </button>
          <button className="btn secondary" onClick={() => setImporting(true)}>
            {t('Liste importieren')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('Regeln')}</h3>
          <span className="muted small">
            {t('{n} von {max} · die erste passende gilt, genaue Pfade vor Mustern', { n: d.rules.length, max: d.max })}
          </span>
        </div>
        {d.rules.length === 0 ? (
          <Empty>{t('Noch keine Weiterleitungen.')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t rd-table">
              <thead>
                <tr>
                  <th>{t('Von')}</th>
                  <th>{t('Nach')}</th>
                  <th>{t('Art')}</th>
                  <th>{t('Aufrufe')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.rules.map((x: any) => (
                  <tr key={x.id}>
                    <td>
                      <code>{x.source}</code> {x.wildcard && <Badge tone="blue">{t('Muster')}</Badge>}
                      {x.page_conflict && (
                        <div className="warn small" role="note">
                          {t('Es gibt eine Seite mit diesem Pfad – die Seite hat Vorrang, die Weiterleitung greift nicht.')}
                        </div>
                      )}
                    </td>
                    <td>
                      <code>{x.target}</code>
                    </td>
                    <td>{x.code}</td>
                    <td>
                      {x.hits}
                      {x.last_hit_at && <div className="muted small">{t('zuletzt {date}', { date: dt(x.last_hit_at) })}</div>}
                    </td>
                    <td className="nowrap">
                      <button className="btn small secondary" onClick={() => setEdit(x)}>
                        {t('Bearbeiten')}
                      </button>{' '}
                      <button className="icon-btn" aria-label={t('Weiterleitung {path} löschen', { path: x.source })} onClick={async () => confirmAsk(t('Weiterleitung von {path} löschen?', { path: x.source })) && (await act(() => api.del(`/api/site-redirects/${x.id}`))) && r.reload()}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t('Testen')}</h3>
        <div className="row" style={{ alignItems: 'end' }}>
          <div style={{ width: 320, maxWidth: '100%' }}>
            <Field label={t('Pfad eingeben')}>
              <Input value={test.path} onChange={(v) => setTest({ path: v, out: null })} placeholder="/blog/mein-beitrag" onKeyDown={(e) => e.key === 'Enter' && test.path && act(() => api.post(`/api/funnels/${funnel.id}/redirects/test`, { path: test.path })).then((o) => o && setTest({ ...test, out: o }))} />
            </Field>
          </div>
          <button className="btn secondary" disabled={!test.path} onClick={async () => setTest({ ...test, out: await act(() => api.post(`/api/funnels/${funnel.id}/redirects/test`, { path: test.path })) })}>
            {t('Prüfen')}
          </button>
        </div>
        {test.out && (
          <p role="status">
            {test.out.match ? (
              <>
                {t('Regel')} <code>{test.out.match.source}</code> ({test.out.match.code}{t(') leitet weiter nach')} <code>{test.out.url}</code>
              </>
            ) : (
              t('Keine Regel passt – die Seite wird normal ausgeliefert (oder die 404-Seite gezeigt).')
            )}
          </p>
        )}
      </div>

      <div className="card" data-tour="site-misses">
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('Nicht gefundene Adressen')}</h3>
          <span className="grow" />
          {d.misses.length > 0 && (
            <button className="btn small ghost" onClick={async () => (await act(() => api.del(`/api/funnels/${funnel.id}/redirects/misses`))) && r.reload()}>
              {t('Liste leeren')}
            </button>
          )}
        </div>
        <p className="muted small">{t('Adressen, die Besucher aufgerufen haben und die es nicht gibt – häufig alte Links. Leite sie mit einem Klick weiter.')}</p>
        {d.misses.length === 0 ? (
          <p className="a11y-ok small">{t('Keine offenen Fälle.')}</p>
        ) : (
          <ul className="rd-misses">
            {d.misses.map((m: any) => (
              <li key={m.path}>
                <code>{m.path}</code>
                <span className="muted small">
                  {t('{n}× · zuletzt {date}', { n: m.hits, date: dt(m.last_at) })}
                </span>
                <button className="btn small secondary" onClick={() => setDraft({ ...draft, source: m.path })}>
                  {t('Weiterleiten …')}
                </button>
                <button className="icon-btn" aria-label={t('{path} aus der Liste entfernen', { path: m.path })} onClick={async () => (await act(() => api.del(`/api/funnels/${funnel.id}/redirects/misses?path=${encodeURIComponent(m.path)}`))) && r.reload()}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {importing && (
        <Modal
          title={t('Weiterleitungen importieren')}
          onClose={() => setImporting(false)}
          footer={
            <button
              className="btn"
              disabled={!text.trim()}
              onClick={async () => {
                const out = await act(() => api.post(`/api/funnels/${funnel.id}/redirects/import`, { text }));
                if (!out) return;
                toast(out.errors.length ? t('{created} angelegt, {skipped} übersprungen, {errors} Fehler', { created: out.created, skipped: out.skipped, errors: out.errors.length }) : t('{created} angelegt, {skipped} übersprungen', { created: out.created, skipped: out.skipped }));
                if (out.errors.length) toast(out.errors.slice(0, 3).join(' · '));
                else setImporting(false);
                r.reload();
              }}
            >
              {t('Importieren')}
            </button>
          }
        >
          <p className="muted small">
            {t('Eine Weiterleitung je Zeile:')} <code>{t('/alt /neu')}</code> {t('oder')} <code>{t('/alt /neu 302')}</code> {t('(auch mit Komma oder Tabulator, zum Beispiel aus einer Tabelle). Zeilen mit')} <code>#</code> {t('sind Kommentare.')}
          </p>
          <Textarea className="mono" rows={12} value={text} onChange={setText} placeholder={t('/alte-seite /neue-seite\n/blog/* /magazin/$1 301\n/angebot https://example.com/angebot 302')} />
        </Modal>
      )}

      {edit && (
        <Modal
          title={t('Weiterleitung bearbeiten')}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                const out = await act(() => api.patch(`/api/site-redirects/${edit.id}`, { source: edit.source, target: edit.target, code: Number(edit.code), keep_query: edit.keep_query, note: edit.note }), t('Gespeichert'));
                if (out) (setEdit(null), r.reload());
              }}
            >
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Von')}>
            <Input value={edit.source} onChange={(v) => setEdit({ ...edit, source: v })} />
          </Field>
          <Field label={t('Nach')}>
            <Input value={edit.target} onChange={(v) => setEdit({ ...edit, target: v })} />
          </Field>
          <Field label={t('Art')}>
            <Select value={String(edit.code)} onChange={(v) => setEdit({ ...edit, code: v })} options={CODES.map(([k, l]) => [k, t(l)] as [string, string])} />
          </Field>
          <Check checked={edit.keep_query} onChange={(v) => setEdit({ ...edit, keep_query: v })} label={t('Parameter der Adresse mitnehmen')} />
          <Field label={t('Notiz')}>
            <Input value={edit.note} onChange={(v) => setEdit({ ...edit, note: v })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
