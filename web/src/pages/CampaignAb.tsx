import { api, dt } from '../api';
import { Badge, Check, Field, Input, Link, Select, act, confirmAsk } from '../ui';
import { EmailDesignField } from './EmailBuilder';
import { Sel, de, euro, pctPlain } from './MarketingKit';
import { useT, type TFn } from '../i18n';

/**
 * A/B test and follow-up to non-openers inside the campaign editor (docs/email-marketing.md): the setup while the campaign is a draft,
 * the results view while and after it runs, and the "send again to everybody who did not open" card.
 */

const KEYS = ['A', 'B', 'C', 'D'];
// German labels (message ids of the campaigns catalog), shown through t()
const METRICS: [string, string][] = [['opens', 'Öffnungen (Personen)'], ['clicks', 'Klicks'], ['revenue', 'Umsatz (bezahlte Rechnungen)']];
const SHORT: Record<string, string> = { opens: 'Öffnungen', clicks: 'Klicks', revenue: 'Umsatz' };
const WAIT: [string, string][] = [['1', '1 Stunde'], ['2', '2 Stunden'], ['4', '4 Stunden'], ['8', '8 Stunden'], ['12', '12 Stunden'], ['24', '24 Stunden'], ['48', '2 Tage'], ['72', '3 Tage'], ['168', '7 Tage']];
const AFTER: [string, string][] = [['24', 'nach 1 Tag'], ['48', 'nach 2 Tagen'], ['72', 'nach 3 Tagen'], ['96', 'nach 4 Tagen'], ['168', 'nach 7 Tagen'], ['336', 'nach 14 Tagen']];

const withOption = (opts: [string, string][], value: number, label: (n: number) => string): [string, string][] => (opts.some(([v]) => v === String(value)) ? opts : [...opts, [String(value), label(value)]]);
const translated = (opts: [string, string][], t: TFn): [string, string][] => opts.map(([k, l]) => [k, t(l)]);

type Variant = { key: string; subject?: string; sender_name?: string; design?: any; body?: string };

export const newAb = () => ({ enabled: true, variants: [{ key: 'A' }, { key: 'B', subject: '', sender_name: '' }], test_percent: 20, metric: 'opens', wait_hours: 24 });

/** The setup of a test on a draft: variants (subject, optionally sender name and content), test share, measure, waiting time. */
export function AbSetup({ data, set, locked }: { data: any; set: (patch: any) => void; locked: boolean }) {
  const t = useT('campaigns');
  const ab = data.ab?.enabled ? data.ab : null;
  const reach: number | undefined = data.audience;
  const setVariant = (i: number, patch: Partial<Variant>) => set({ ab: { ...ab, variants: ab.variants.map((v: Variant, j: number) => (j === i ? { ...v, ...patch } : v)) } });
  const perVariant = ab ? Math.round(ab.test_percent / ab.variants.length * 10) / 10 : 0;
  return (
    <div className="card mk-card" data-tour="campaign-ab">
      <div className="mk-actions" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('A/B-Test')}</h2>
        <Check checked={!!ab} onChange={(v) => set({ ab: v ? newAb() : null })} label={t('Betreff oder Inhalt testen')} tour="campaign-ab-toggle" />
      </div>
      {!ab ? (
        <p className="muted small mk-lead" style={{ marginTop: 6 }}>
          {t('Zwei oder mehr Varianten an einen kleinen Teil der Empfänger schicken. Nach der Wartezeit bekommt der Rest automatisch die Variante, die am besten abgeschnitten hat.')}
        </p>
      ) : (
        <>
          <div className="mk-variants">
            {ab.variants.map((v: Variant, i: number) => (
              <div key={v.key} className="mk-variant">
                <div className="mk-variant-head">
                  <span>
                    <span className="mk-key">{v.key}</span> <strong>{i === 0 ? t('Original') : t('Variante {key}', { key: v.key })}</strong>
                  </span>
                  {i > 1 && !locked && (
                    <button type="button" className="mk-x" aria-label={t('Variante {key} entfernen', { key: v.key })} onClick={() => set({ ab: { ...ab, variants: ab.variants.filter((_: Variant, j: number) => j !== i).map((x: Variant, j: number) => ({ ...x, key: KEYS[j] })) } })}>
                      ✕
                    </button>
                  )}
                </div>
                {i === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    {t('Betreff, Absendername und Inhalt der Kampagne (links). Betreff:')} <strong>{data.subject || '–'}</strong>
                  </p>
                ) : (
                  <>
                    <div className="grid2">
                      <Field label={t('Betreff')}>
                        <Input value={v.subject ?? ''} onChange={(x) => setVariant(i, { subject: x })} disabled={locked} placeholder={data.subject} maxLength={300} />
                      </Field>
                      <Field label={t('Absendername (optional)')}>
                        <Input value={v.sender_name ?? ''} onChange={(x) => setVariant(i, { sender_name: x })} disabled={locked} placeholder={data.sender_name || t('wie in der Kampagne')} maxLength={100} />
                      </Field>
                    </div>
                    <div className="field">
                      <span>{t('Inhalt')}</span>
                      {v.design ? (
                        <EmailDesignField
                          design={v.design}
                          subject={v.subject || data.subject}
                          mode="campaign"
                          disabled={locked}
                          onChange={(r) => setVariant(i, { design: r.design })}
                          onRemove={() => setVariant(i, { design: undefined, body: undefined })}
                        />
                      ) : (
                        <div className="mk-actions">
                          <span className="muted small">{t('wie in der Kampagne')}</span>
                          {!locked && (
                            <button type="button" className="btn secondary small" onClick={() => setVariant(i, { design: data.design ? JSON.parse(JSON.stringify(data.design)) : { sections: [] } })} disabled={!data.design}>
                              {t('Eigenen Inhalt gestalten')}
                            </button>
                          )}
                          {!data.design && <span className="muted small">{t('(erst die Kampagne im Designer gestalten)')}</span>}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          {!locked && ab.variants.length < 4 && (
            <button type="button" className="btn secondary" onClick={() => set({ ab: { ...ab, variants: [...ab.variants, { key: KEYS[ab.variants.length], subject: '', sender_name: '' }] } })}>
              {t('+ Variante {key}', { key: KEYS[ab.variants.length] })}
            </button>
          )}
          <div className="mk-grid3" style={{ marginTop: 12 }}>
            <Field label={t('Testgruppe (5–50 % der Empfänger)')} hint={reach ? t('Je Variante ca. {pct} ({n} Personen)', { pct: pctPlain(perVariant), n: de(Math.floor((reach * ab.test_percent) / 100 / ab.variants.length)) }) : t('Je Variante ca. {pct}', { pct: pctPlain(perVariant) })}>
              <Input type="number" min={5} max={50} value={ab.test_percent} disabled={locked} onChange={(x) => set({ ab: { ...ab, test_percent: Number(x) } })} />
            </Field>
            <Field label={t('Gewinner nach')}>
              <Sel value={ab.metric} disabled={locked} onChange={(x) => set({ ab: { ...ab, metric: x } })} options={translated(METRICS, t)} />
            </Field>
            <Field label={t('Wartezeit bis zur Entscheidung')}>
              <Select value={String(ab.wait_hours)} onChange={(x) => set({ ab: { ...ab, wait_hours: Number(x) } })} options={withOption(translated(WAIT, t), ab.wait_hours, (n) => t.plural(n, { other: '{n} Stunden' }))} />
            </Field>
          </div>
          <p className="mk-note">
            {howItRuns(t, { pct: pctPlain(ab.test_percent, 0), wait: ab.wait_hours % 24 === 0 ? t.plural(ab.wait_hours / 24, { one: '{n} Tag', other: '{n} Tagen' }) : t.plural(ab.wait_hours, { one: '{n} Stunde', other: '{n} Stunden' }) }, ab.metric)}{' '}
            {t('Mail-Programme, die Bilder im Hintergrund laden (Apple Mail, Gmail-Proxy), zählen nicht mit. Ohne Daten geht das Original raus.')}
          </p>
          {reach !== undefined && reach < ab.variants.length * 10 && <p className="mk-note warn">{t('Bei nur {n} Empfängern ist ein Test wenig aussagekräftig. Jede Variante braucht mindestens 2 Empfänger, sonst wird ohne Test gesendet.', { n: de(reach) })}</p>}
        </>
      )}
    </div>
  );
}

/** "So läuft es: …" – one sentence per measure, so each language can phrase it on its own. */
function howItRuns(t: TFn, vars: { pct: string; wait: string }, metric: string): string {
  if (metric === 'opens') return t('So läuft es: {pct} der Empfänger bekommen die Varianten zu gleichen Teilen. Nach {wait} geht die Variante mit den meisten Öffnungen automatisch an alle übrigen.', vars);
  if (metric === 'clicks') return t('So läuft es: {pct} der Empfänger bekommen die Varianten zu gleichen Teilen. Nach {wait} geht die Variante mit den meisten Klicks automatisch an alle übrigen.', vars);
  if (metric === 'revenue') return t('So läuft es: {pct} der Empfänger bekommen die Varianten zu gleichen Teilen. Nach {wait} geht die Variante mit den meisten Umsatz automatisch an alle übrigen.', vars);
  return t('So läuft es: {pct} der Empfänger bekommen die Varianten zu gleichen Teilen. Nach {wait} geht die Variante mit den meisten {metric} automatisch an alle übrigen.', { ...vars, metric: SHORT[metric] ?? metric });
}

const VERDICT: Record<string, string> = { control: 'Original', too_early: 'noch zu früh', better: 'deutlich besser als A', worse: 'schlechter als A', no_difference: 'kein klarer Unterschied' };

/** Results of a running or finished test; while it waits, the winner can be chosen by hand. */
export function AbResults({ data, reload }: { data: any; reload: () => void }) {
  const t = useT('campaigns');
  const r = data.ab_results;
  if (!r) return null;
  const waiting = data.status === 'testing' && r.phase === 'waiting';
  const choose = async (key?: string) => {
    const ask = key ? t('Variante {key} jetzt an alle übrigen {n} Empfänger senden?', { key, n: de(r.held) }) : t('Den Gewinner jetzt automatisch bestimmen und an alle übrigen senden?');
    if (!confirmAsk(ask)) return;
    if (await act(() => api.post(`/api/campaigns/${data.id}/ab/winner`, key ? { key } : {}), t('Gewinner steht fest – der Rest wird gesendet'))) reload();
  };
  const measure = (v: any) => (r.metric === 'opens' ? v.opened : r.metric === 'clicks' ? v.clicked : v.buyers);
  return (
    <div className="card mk-card" data-tour="campaign-ab-results">
      <div className="mk-actions" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('A/B-Test: Ergebnis')}</h2>
        <Badge tone={r.phase === 'winner' ? 'green' : r.phase === 'waiting' ? 'blue' : 'gray'}>{r.phase === 'winner' ? t('entschieden') : r.phase === 'waiting' ? t('wartet auf Entscheidung') : r.skipped ? t('ohne Test') : t('startet')}</Badge>
      </div>
      <p className="muted small" style={{ margin: '4px 0 8px' }}>
        {r.note}
        {r.phase === 'waiting' && r.held > 0 && ` ${t.plural(r.held, { other: '{n} Empfänger warten auf den Gewinner.' }, { n: de(r.held) })}`}
        {r.decided_reason ? ` ${r.decided_reason}` : ''}
      </p>
      <div className="mk-table-wrap">
        <table className="t mk-results">
          <thead>
            <tr>
              <th>{t('Variante')}</th>
              <th>{t('Gesendet')}</th>
              <th>{t('Geöffnet')}</th>
              <th>{t('Geklickt')}</th>
              <th>{t('Käufer')}</th>
              <th>{t('Umsatz')}</th>
              <th>{t('Einschätzung')}</th>
            </tr>
          </thead>
          <tbody>
            {r.variants.map((v: any) => (
              <tr key={v.key}>
                <td>
                  <span className="mk-key">{v.key}</span> {v.is_winner && <span className="win">{t('Gewinner')}</span>}
                  <div className="muted small" style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                    {v.subject}
                    {v.sender_name ? ` · ${v.sender_name}` : ''}
                    {v.own_content ? ` · ${t('eigener Inhalt')}` : ''}
                  </div>
                </td>
                <td>{de(v.sent)}</td>
                <td>
                  {de(v.opened)} <span className="muted small">({pctPlain(v.open_rate)})</span>
                </td>
                <td>
                  {de(v.clicked)} <span className="muted small">({pctPlain(v.click_rate)})</span>
                </td>
                <td>{de(v.buyers)}</td>
                <td>{euro(v.revenue_cents)}</td>
                <td className="small verdict">
                  {VERDICT[v.verdict] ? t(VERDICT[v.verdict]) : v.verdict}
                  {v.prob_beat !== null && v.prob_beat !== undefined && v.verdict !== 'too_early' && <span className="muted"> · {t('{n} % Chance besser als A', { n: Math.round(v.prob_beat * 100) })}</span>}
                  {r.best_now === v.key && r.phase === 'waiting' && measure(v) > 0 && <span className="muted"> · {t('liegt vorn')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.small_sample && <p className="muted small">{t('Noch wenige Daten: ein Unterschied ist erst bei genug Empfängern und Reaktionen belastbar. Gewertet wird:')} {r.metric_label}.</p>}
      {waiting && (
        <div className="mk-actions" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => choose()} data-tour="campaign-ab-decide">
            {t('Gewinner jetzt bestimmen')}
          </button>
          {r.variants.map((v: any) => (
            <button key={v.key} className="btn secondary" onClick={() => choose(v.key)}>
              {t('{key} senden', { key: v.key })}
            </button>
          ))}
        </div>
      )}
      {waiting && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {t('Ohne dein Zutun fällt die Entscheidung automatisch {when}.', { when: r.decide_at ? dt(r.decide_at) : t('nach der Wartezeit') })} {t('„{key} senden“ usw. schickt eine bestimmte Variante sofort an alle übrigen.', { key: r.variants[0]?.key ?? '' })}
        </p>
      )}
    </div>
  );
}

/** "Erneut an Nicht-Öffner": set up on a draft (inside the campaign) or on a campaign that is sending or sent. */
export function ResendCard({ data, set, locked, reload }: { data: any; set: (patch: any) => void; locked: boolean; reload: () => void }) {
  const t = useT('campaigns');
  if (data.channel !== 'email' || data.parent_id) return null;
  const draft = !locked;
  const cfg = data.resend?.enabled ? data.resend : null;
  const info = data.resend_info;
  const update = (patch: any) => set({ resend: { ...(cfg ?? { enabled: true, after_hours: 72, subject: '' }), ...patch } });
  const fromInfo = info ?? null;

  if (draft) {
    return (
      <div className="card mk-card" data-tour="campaign-resend">
        <div className="mk-actions" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t('Erinnerung an Nicht-Öffner')}</h2>
          <Check checked={!!cfg} onChange={(v) => set({ resend: v ? { enabled: true, after_hours: 72, subject: '' } : null })} label={t('Erneut senden')} tour="campaign-resend-toggle" />
        </div>
        {!cfg ? (
          <p className="muted small mk-lead" style={{ marginTop: 6 }}>
            {t('Wer die Mail nach ein paar Tagen nicht geöffnet hat, bekommt sie noch einmal – mit neuem Betreff. Das bringt oft ein Drittel mehr Öffnungen.')}
          </p>
        ) : (
          <>
            <div className="grid2">
              <Field label={t('Neuer Betreff')}>
                <Input value={cfg.subject} onChange={(v) => update({ subject: v })} placeholder={t('z. B. Noch gesehen? …')} maxLength={300} />
              </Field>
              <Field label={t('Wann')}>
                <Select value={String(cfg.after_hours)} onChange={(v) => update({ after_hours: Number(v) })} options={withOption(translated(AFTER, t), cfg.after_hours, (n) => t.plural(n, { other: 'nach {n} Stunden' }))} />
              </Field>
            </div>
            <p className="mk-note">
              {t('Wer geöffnet oder geklickt hat, bekommt nichts. Es zählt nur, was eine Person getan hat: Das Laden von Bildern durch Apple Mail oder den Gmail-Proxy gilt nicht als Öffnung, diese Leser werden also nicht fälschlich übersprungen. Erinnert wird nur einmal.')}
            </p>
          </>
        )}
      </div>
    );
  }

  const setup = async (now: boolean) => {
    if (now && !confirmAsk(t('Die Mail jetzt mit neuem Betreff an alle schicken, die sie noch nicht geöffnet haben?'))) return;
    if (await act(() => api.post(`/api/campaigns/${data.id}/resend`, { ...(cfg ?? { subject: '', after_hours: 72 }), now }), now ? t('Erinnerung wird gesendet') : t('Erinnerung geplant'))) reload();
  };
  return (
    <div className="card mk-card" data-tour="campaign-resend">
      <h2>{t('Erinnerung an Nicht-Öffner')}</h2>
      {fromInfo?.status === 'created' ? (
        <p>
          {t('Die Erinnerung wurde angelegt')}
          {fromInfo.child_id && (
            <>
              : <Link to={`campaigns/${fromInfo.child_id}`}>{t('zur Kampagne')}</Link>
            </>
          )}
          . {t('Betreff:')} <strong>{fromInfo.subject}</strong>
        </p>
      ) : fromInfo?.status === 'skipped' ? (
        <p className="muted">{t('Keine Erinnerung gesendet')}{fromInfo.note ? `: ${fromInfo.note}` : '.'}</p>
      ) : fromInfo ? (
        <>
          <p>
            {t('Geplant')} {fromInfo.due_at ? dt(fromInfo.due_at) : ''} {t('mit dem Betreff')} <strong>{fromInfo.subject}</strong>
            {fromInfo.preview !== null && fromInfo.preview !== undefined && <span className="muted"> · {t('bisher {n} Nicht-Öffner', { n: de(fromInfo.preview) })}</span>}
          </p>
          <div className="mk-actions">
            {data.status === 'sent' && (
              <button className="btn" onClick={() => setup(true)}>
                {t('Jetzt senden')}
              </button>
            )}
            <button className="btn ghost" onClick={async () => (await act(() => api.del(`/api/campaigns/${data.id}/resend`), t('Erinnerung entfernt'))) && reload()}>
              {t('Erinnerung entfernen')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="grid2">
            <Field label={t('Neuer Betreff')}>
              <Input value={cfg?.subject ?? ''} onChange={(v) => update({ subject: v })} maxLength={300} />
            </Field>
            <Field label={t('Wann')}>
              <Select value={String(cfg?.after_hours ?? 72)} onChange={(v) => update({ after_hours: Number(v) })} options={translated(AFTER, t)} />
            </Field>
          </div>
          <div className="mk-actions">
            <button className="btn secondary" disabled={!cfg?.subject?.trim()} onClick={() => setup(false)}>
              {t('Erinnerung planen')}
            </button>
            {data.status === 'sent' && (
              <button className="btn" disabled={!cfg?.subject?.trim()} onClick={() => setup(true)}>
                {t('Jetzt an Nicht-Öffner senden')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
