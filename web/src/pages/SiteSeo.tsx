import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Check, Field, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';

/**
 * Website → "SEO & Zugang" (docs/sites.md#seo-check): the SEO check of every page, structured data (schema.org) per page, password
 * protection for a page or the whole site, and the hint on URL parameters as text. Server: modules/site-seo.ts, site-protect.ts,
 * site-dyntext.ts.
 */

const tone = (level: string) => (level === 'error' ? 'red' : level === 'warning' ? 'yellow' : 'gray');

export function SiteSeoTab({ funnel }: { funnel: any }) {
  return (
    <>
      <SeoCheck funnel={funnel} />
      <SchemaCard funnel={funnel} />
      <LocksCard funnel={funnel} />
      <PagesCard funnel={funnel} />
      <DynTextCard />
      <ExternalAudit />
    </>
  );
}

/** Any website on the web (a prospect's, the old site before a relaunch): POST /api/seo-audit. */
function ExternalAudit() {
  const t = useT('gaps');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<any>(null);
  const levelText: Record<string, string> = { error: t('Fehler'), warning: t('Warnung'), info: t('Hinweis') };
  const run = async () => {
    setBusy(true);
    const res = await act(() => api.post('/api/seo-audit', { url }));
    setBusy(false);
    if (res) setR(res);
  };
  return (
    <div className="card" data-tour="seo-audit-url">
      <h2 style={{ marginTop: 0 }}>{t('Beliebige Website prüfen')}</h2>
      <MoreFields id="seo-audit-url" values={[url]} label={t('Website eines Interessenten oder die alte Seite prüfen')}>
        <div className="row" style={{ gap: 6 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input value={url} onChange={setUrl} placeholder="https://example.de" aria-label={t('Adresse der Website')} />
          </div>
          <button className="btn small" disabled={!url.trim() || busy} onClick={run}>
            {busy ? t('Prüfe …') : t('Prüfen')}
          </button>
        </div>
        {r && (
          <>
            <p>
              <strong style={{ fontSize: 24 }}>{r.score}</strong> / 100 <span className="muted small">· {r.url}</span>
            </p>
            <ul className="small" style={{ paddingLeft: 18 }}>
              {r.issues.map((i: any) => (
                <li key={i.rule}>
                  <Badge tone={tone(i.level)}>{levelText[i.level]}</Badge> {i.message} <span className="muted">{i.hint}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </MoreFields>
    </div>
  );
}

function SeoCheck({ funnel }: { funnel: any }) {
  const t = useT('gaps');
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState('');
  const levelText: Record<string, string> = { error: t('Fehler'), warning: t('Warnung'), info: t('Hinweis') };
  const run = async () => {
    setBusy(true);
    const r = await act(() => api.get(`/api/funnels/${funnel.id}/seo`));
    setBusy(false);
    if (r) setReport(r);
  };
  return (
    <div className="card" data-tour="site-seo">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('SEO-Check')}</h2>
        <button className="btn small" disabled={busy} onClick={run}>
          {busy ? t('Prüfe …') : report ? t('Erneut prüfen') : t('Seiten prüfen')}
        </button>
      </div>
      <p className="muted small">{t('Prüft Titel, Beschreibung, Überschriften, Alternativtexte, Textmenge, Links und strukturierte Daten jeder Seite.')}</p>
      {report && (
        <>
          <p>
            <strong style={{ fontSize: 28 }}>{report.score}</strong> / 100 <span className="muted small">· {dt(report.checked_at)}</span>
          </p>
          {report.site.map((i: any) => (
            <p key={i.rule + i.message} className="small">
              <Badge tone={tone(i.level)}>{levelText[i.level]}</Badge> {i.message} <span className="muted">{i.hint}</span>
            </p>
          ))}
          <table className="t">
            <thead>
              <tr>
                <th>{t('Seite')}</th>
                <th>{t('Punkte')}</th>
                <th>{t('Befunde')}</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.map((p: any) => (
                <tr key={p.id}>
                  <td>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {p.name}
                    </a>
                  </td>
                  <td>
                    <Badge tone={p.score >= 85 ? 'green' : p.score >= 60 ? 'yellow' : 'red'}>{p.score}</Badge>
                  </td>
                  <td>
                    {p.issues.length === 0 ? (
                      <span className="muted small">{t('Alles in Ordnung')}</span>
                    ) : (
                      <>
                        <button className="btn small secondary" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? '' : p.id)}>
                          {t.plural(p.issues.length, { one: '{n} Befund', other: '{n} Befunde' })}
                        </button>
                        {open === p.id && (
                          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                            {p.issues.map((i: any) => (
                              <li key={i.rule}>
                                <Badge tone={tone(i.level)}>{levelText[i.level]}</Badge> {i.message} <span className="muted">{i.hint}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function SchemaCard({ funnel }: { funnel: any }) {
  const t = useT('gaps');
  const [pageId, setPageId] = useState<string>(funnel.pages[0]?.id ?? '');
  const data = useLoad(() => (pageId ? api.get(`/api/funnel-pages/${pageId}/schema`) : Promise.resolve(null)), [pageId]);
  const [draft, setDraft] = useState<{ page: string; type: string; data: Record<string, string> } | null>(null);
  const d = data.data;
  if (!funnel.pages.length) return null;
  const cur = draft?.page === pageId ? draft : d ? { page: pageId, type: d.type || d.suggestion?.type || '', data: d.saved ? d.data : (d.suggestion?.data ?? {}) } : null;
  const spec = cur && d ? d.types[cur.type] : null;
  const req = spec ? spec.fields.filter((f: any) => f.required) : [];
  const more = spec ? spec.fields.filter((f: any) => !f.required) : [];
  const setField = (k: string, v: string) => cur && setDraft({ ...cur, data: { ...cur.data, [k]: v } });
  const save = async (remove = false) => {
    if (!cur) return;
    const r = await act(() => api.put(`/api/funnel-pages/${pageId}/schema`, remove ? { type: '' } : { type: cur.type, data: cur.data }), remove ? t('Entfernt') : t('Gespeichert'));
    if (r) {
      setDraft(null);
      data.reload();
    }
  };
  const field = (f: any) => (
    <Field key={f.key} label={t(f.label)}>
      <Input value={cur?.data[f.key] ?? ''} onChange={(v) => setField(f.key, v)} />
    </Field>
  );
  return (
    <div className="card" data-tour="site-schema">
      <h2 style={{ marginTop: 0 }}>{t('Strukturierte Daten (Schema.org)')}</h2>
      <p className="muted small">{t('Google kann damit Sterne, FAQ, Öffnungszeiten oder Preise direkt in den Suchergebnissen zeigen.')}</p>
      <div className="grid2">
        <Field label={t('Seite')}>
          <Select value={pageId} onChange={(v) => (setPageId(v), setDraft(null))} options={funnel.pages.map((p: any) => [p.id, p.name] as [string, string])} />
        </Field>
        {d && cur && (
          <Field label={t('Typ')}>
            <Select value={cur.type} onChange={(v) => setDraft({ page: pageId, type: v, data: cur.data })} options={[['', t('– keiner –')], ...Object.entries(d.types).map(([k, v]: [string, any]) => [k, t(v.label)] as [string, string])]} />
          </Field>
        )}
      </div>
      {!d && <Spinner />}
      {d && cur && spec && (
        <>
          {cur.type === 'FAQPage' && <p className="small muted">{d.faq ? t('{n} Fragen aus den FAQ-Blöcken der Seite.', { n: d.faq }) : t('Die Seite hat noch keinen FAQ-Block.')}</p>}
          <div className="grid2">{req.map(field)}</div>
          {more.length > 0 && (
            <MoreFields id="site-schema-fields" values={more.map((f: any) => cur.data[f.key])}>
              <div className="grid2">{more.map(field)}</div>
            </MoreFields>
          )}
        </>
      )}
      {d && cur && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" disabled={!cur.type} onClick={() => save()}>
            {t('Speichern')}
          </button>
          {d.saved && (
            <button className="btn small secondary" onClick={() => save(true)}>
              {t('Entfernen')}
            </button>
          )}
          {d.saved && <Badge tone="green">{t('aktiv auf der Seite')}</Badge>}
        </div>
      )}
      {d?.json && (
        <details style={{ marginTop: 8 }}>
          <summary className="small">{t('JSON-LD ansehen')}</summary>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(d.json, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function LocksCard({ funnel }: { funnel: any }) {
  const t = useT('gaps');
  const locks = useLoad(() => api.get<any[]>(`/api/funnels/${funnel.id}/locks`), [funnel.id]);
  const [form, setForm] = useState({ page_id: '', password: '', hint: '' });
  const nameOf = (pid: string | null) => (pid ? (funnel.pages.find((p: any) => p.id === pid)?.name ?? '?') : t('Ganze Website'));
  const save = async () => {
    const r = await act(() => api.put(`/api/funnels/${funnel.id}/locks`, { page_id: form.page_id || null, password: form.password, hint: form.hint }), t('Passwort gesetzt'));
    if (r) {
      setForm({ page_id: '', password: '', hint: '' });
      locks.reload();
    }
  };
  return (
    <div className="card" data-tour="site-locks">
      <h2 style={{ marginTop: 0 }}>{t('Passwortschutz')}</h2>
      <p className="muted small">{t('Besucher sehen ein Passwortfeld statt der Seite. Ein neues Passwort beendet alle offenen Zugänge.')}</p>
      {(locks.data ?? []).length > 0 && (
        <table className="t">
          <tbody>
            {locks.data!.map((l: any) => (
              <tr key={l.id}>
                <td>
                  🔒 {nameOf(l.page_id)}
                  {l.hint && <div className="muted small">{l.hint}</div>}
                </td>
                <td className="muted small">{dt(l.updated_at)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn small secondary" onClick={async () => confirmAsk(t('Passwortschutz für „{n}“ entfernen?', { n: nameOf(l.page_id) })) && (await act(() => api.del(`/api/funnels/${funnel.id}/locks/${l.id}`))) && locks.reload()}>
                    {t('Entfernen')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="grid2">
        <Field label={t('Schützen')}>
          <Select value={form.page_id} onChange={(v) => setForm({ ...form, page_id: v })} options={[['', t('Ganze Website')], ...funnel.pages.map((p: any) => [p.id, p.name] as [string, string])]} />
        </Field>
        <Field label={t('Passwort')}>
          <Input type="text" autoComplete="new-password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder={t('mind. 4 Zeichen')} />
        </Field>
      </div>
      <MoreFields id="site-lock-more" values={[form.hint]}>
        <Field label={t('Hinweis für Besucher')}>
          <Input value={form.hint} onChange={(v) => setForm({ ...form, hint: v })} placeholder={t('z. B. Das Passwort steht in deiner Einladung.')} />
        </Field>
      </MoreFields>
      <button className="btn small" disabled={form.password.length < 4} onClick={save}>
        {t('Passwort setzen')}
      </button>
    </div>
  );
}

/** Order of the pages (the first is the start page) and taking single pages offline (modules/site-pages.ts). */
function PagesCard({ funnel }: { funnel: any }) {
  const t = useT('gaps');
  const pages = useLoad(() => api.get<any[]>(`/api/funnels/${funnel.id}/pages-state`), [funnel.id]);
  if (!pages.data) return null;
  const list = pages.data;
  const move = async (i: number, d: number) => {
    const ids = list.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    (await act(() => api.post(`/api/funnels/${funnel.id}/reorder`, { page_ids: ids }))) && pages.reload();
  };
  return (
    <div className="card" data-tour="site-pages">
      <h2 style={{ marginTop: 0 }}>{t('Seiten: Reihenfolge & online')}</h2>
      <p className="muted small">{t('Die erste Seite ist die Startseite. Eine offline genommene Seite zeigt Besuchern die 404-Seite – alles andere bleibt online.')}</p>
      <table className="t">
        <tbody>
          {list.map((p, i) => (
            <tr key={p.id}>
              <td>
                {p.name} <span className="muted small">/{p.slug}</span> {p.start && <Badge tone="blue">{t('Startseite')}</Badge>} {p.offline && <Badge tone="red">{t('offline')}</Badge>}
              </td>
              <td style={{ textAlign: 'right' }}>
                <div className="actions" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn small secondary" disabled={i === 0} aria-label={t('{n} nach oben', { n: p.name })} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button className="btn small secondary" disabled={i === list.length - 1} aria-label={t('{n} nach unten', { n: p.name })} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button className="btn small secondary" onClick={async () => (await act(() => api.put(`/api/funnel-pages/${p.id}/offline`, { offline: !p.offline }))) && pages.reload()}>
                    {p.offline ? t('Online stellen') : t('Offline nehmen')}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DynTextCard() {
  const t = useT('gaps');
  return (
    <div className="card" data-tour="site-dyntext">
      <h2 style={{ marginTop: 0 }}>{t('Text aus dem Link (URL-Parameter)')}</h2>
      <p className="small">
        {t('Schreib in einen Text')} <code>{'{{url.name|Freund}}'}</code> – {t('wer …/seite?name=Anna öffnet, liest „Anna“, alle anderen „Freund“.')}
      </p>
      <p className="small muted">
        {t('Text je nach Link zeigen:')} <code>{'{{#if url.quelle == "facebook"}}…{{else}}…{{/if}}'}</code>
      </p>
    </div>
  );
}

/** Website → Design: upload own font files and use them for body text and headings (modules/site-fonts.ts). */
export function SiteFonts({ funnelId }: { funnelId: string }) {
  const t = useT('gaps');
  const fonts = useLoad(() => api.get<any>('/api/site-fonts'), []);
  const use = useLoad(() => api.get<any>(`/api/site-fonts/use/${funnelId}`), [funnelId]);
  const [up, setUp] = useState({ family: '', weight: '400', style: 'normal' });
  const [busy, setBusy] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return void act(() => Promise.reject(new Error(t('Schriftdatei größer als 3 MB'))));
    setBusy(true);
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const family = up.family.trim() || file.name.replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|italic|\d+)$/i, '');
    const ok = await act(() => api.post('/api/site-fonts', { family, weight: Number(up.weight), style: up.style, data }), t('Schrift hochgeladen'));
    setBusy(false);
    if (ok) {
      fonts.reload();
      use.reload();
    }
  };
  const choose = async (patch: Record<string, string>) => (await act(() => api.put(`/api/site-fonts/use/${funnelId}`, { body: use.data?.body ?? '', heading: use.data?.heading ?? '', ...patch }), t('Gespeichert'))) && use.reload();
  const families: string[] = use.data?.families ?? [];
  const opts: [string, string][] = [['', t('Schrift aus dem Design')], ...families.map((f) => [f, f] as [string, string])];
  return (
    <div className="card" data-tour="site-fonts">
      <h2 style={{ marginTop: 0 }}>{t('Eigene Schriften')}</h2>
      <p className="muted small">{t('WOFF2, WOFF, TTF oder OTF hochladen – die Dateien liegen auf deinem Server, ohne Google Fonts.')}</p>
      {families.length > 0 && (
        <div className="grid2">
          <Field label={t('Fließtext')}>
            <Select value={use.data?.body ?? ''} onChange={(v) => choose({ body: v })} options={opts} />
          </Field>
          <Field label={t('Überschriften')}>
            <Select value={use.data?.heading ?? ''} onChange={(v) => choose({ heading: v })} options={opts} />
          </Field>
        </div>
      )}
      <div className="grid2">
        <Field label={t('Name der Schrift')}>
          <Input value={up.family} onChange={(v) => setUp({ ...up, family: v })} placeholder={t('z. B. Markenschrift')} />
        </Field>
        <Field label={t('Datei')}>
          <input type="file" accept=".woff2,.woff,.ttf,.otf" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
        </Field>
      </div>
      <MoreFields id="site-font-more" values={[up.weight !== '400' ? up.weight : '', up.style !== 'normal' ? up.style : '']}>
        <div className="grid2">
          <Field label={t('Stärke')}>
            <Select value={up.weight} onChange={(v) => setUp({ ...up, weight: v })} options={['100', '200', '300', '400', '500', '600', '700', '800', '900']} />
          </Field>
          <Field label={t('Stil')}>
            <Check checked={up.style === 'italic'} onChange={(v) => setUp({ ...up, style: v ? 'italic' : 'normal' })} label={t('Kursiv')} />
          </Field>
        </div>
      </MoreFields>
      {(fonts.data?.fonts ?? []).length > 0 && (
        <table className="t">
          <tbody>
            {fonts.data.fonts.map((f: any) => (
              <tr key={f.id}>
                <td>
                  {f.family} <span className="muted small">{f.weight}{f.style === 'italic' ? ` ${t('kursiv')}` : ''} · {f.format.toUpperCase()}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn small secondary" onClick={async () => confirmAsk(t('Schrift „{n}“ löschen?', { n: f.family })) && (await act(() => api.del(`/api/site-fonts/${f.id}`))) && (fonts.reload(), use.reload())}>
                    {t('Löschen')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
