import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field, Input, Link, useLoad } from '../ui';
import { Sel, de, hourLabel } from './MarketingKit';
import { useT } from '../i18n';

/** More of the campaign editor: send time, WhatsApp template, segment as audience, sender name, warm-up and reputation hints. */

/** "Zur besten Zeit je Kontakt": every contact gets the mail at the hour they usually open, within 24 hours. */
export function SendTimeCard({ data, set, locked, beforePreview }: { data: any; set: (patch: any) => void; locked: boolean; beforePreview: () => Promise<unknown> }) {
  const t = useT('campaigns');
  const [sto, setSto] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const on = data.send_mode === 'sto';
  useEffect(() => setSto(null), [JSON.stringify(data.filter), on]);
  if (data.channel !== 'email') return null;
  const preview = async () => {
    setBusy(true);
    try {
      await beforePreview();
      setSto(await api.get(`/api/campaigns/${data.id}/sto`));
    } catch {
      /* the save reports its own error */
    }
    setBusy(false);
  };
  const max = sto ? Math.max(1, ...(sto.by_hour as number[])) : 1;
  return (
    <div className="qw-box" data-tour="campaign-sto">
      <h3>{t('Sendezeit')}</h3>
      <Field label={t('Wann geht die Mail raus?')}>
        <Sel
          value={on ? 'sto' : 'now'}
          disabled={locked}
          onChange={(v) => set({ send_mode: v })}
          options={[['now', t('Alle auf einmal')], ['sto', t('Zur besten Zeit je Kontakt')]]}
        />
      </Field>
      {on && (
        <>
          <p className="muted small" style={{ margin: '4px 0' }}>
            {t('Innerhalb von 24 Stunden bekommt jeder Kontakt die Mail in der Stunde, in der er Mails sonst öffnet (aus seinen bisherigen Öffnungen). Wer noch keine Daten hat, bekommt die beliebteste Stunde des Projekts. Der Versand zieht sich dadurch über bis zu 24 Stunden hin.')}
          </p>
          {!locked && (
            <button type="button" className="btn secondary small" style={{ minHeight: 44 }} disabled={busy} onClick={preview}>
              {sto ? t('Vorschau aktualisieren') : t('Verteilung anzeigen')}
            </button>
          )}
          {sto && (
            <div aria-live="polite">
              <div className="mk-hours" role="img" aria-label={t('Anzahl Empfänger je Sendestunde')}>
                {(sto.by_hour as number[]).map((n, h) => (
                  <div key={h} style={{ height: `${Math.max(3, (n / max) * 100)}%` }} title={t('{hour}: {n} Empfänger', { hour: hourLabel(h), n: de(n) })} />
                ))}
              </div>
              <div className="mk-hours-axis">
                <span>{t('0 Uhr')}</span>
                <span>6</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
              <p className="small" style={{ margin: '6px 0 0' }}>
                {t('{own} von {recipients} Empfängern haben eigene Daten, {fallback} bekommen {hour} Uhr ({source}). Zeitzone: {tz}.', {
                  own: de(sto.own),
                  recipients: de(sto.recipients),
                  fallback: de(sto.fallback),
                  hour: hourLabel(sto.fallback_hour),
                  source: sto.fallback_from === 'account' ? t('beliebteste Stunde des Projekts') : t('Standardstunde, noch keine Daten'),
                  tz: sto.timezone,
                })}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Audience: a saved behaviour segment, combined with the tags and smart list of the campaign. */
export function SegmentPick({ filter, onChange, disabled }: { filter: any; onChange: (f: any) => void; disabled?: boolean }) {
  const t = useT('campaigns');
  const list = useLoad(() => api.get<any[]>('/api/segments'), []);
  const chosen = (list.data ?? []).find((s) => s.id === filter?.segment_id);
  return (
    <div data-tour="campaign-segment">
      <Field label={t('Segment (Verhalten)')}>
        <Sel
          value={filter?.segment_id ?? ''}
          disabled={disabled}
          onChange={(v) => onChange({ ...filter, segment_id: v || undefined })}
          placeholder="–"
          options={[...(list.data ?? []).map((s) => [s.id, `${s.name}${s.count !== null && s.count !== undefined ? ` (${de(s.count)})` : ''}`] as [string, string]), ...(filter?.segment_id && !chosen && list.data ? [[filter.segment_id, t('Segment nicht mehr vorhanden')] as [string, string]] : [])]}
        />
      </Field>
      {chosen && <p className="muted small" style={{ margin: '-6px 0 8px' }}>{chosen.summary}</p>}
      {filter?.segment_id && <p className="muted small" style={{ margin: '-6px 0 8px' }}>{t('Das Segment wird mit den Angaben darunter kombiniert: Es müssen alle zutreffen.')}</p>}
      <p className="small" style={{ margin: '-4px 0 8px' }}>
        <Link to="campaigns/segments">{t('Segmente verwalten')}</Link>
      </p>
    </div>
  );
}

export function SenderField({ data, set, locked }: { data: any; set: (patch: any) => void; locked: boolean }) {
  const t = useT('campaigns');
  if (data.channel !== 'email') return null;
  return (
    <Field label={t('Absendername (optional)')} hint={t('Leer = Name aus den E-Mail-Einstellungen. Die Adresse bleibt gleich.')}>
      <Input value={data.sender_name ?? ''} onChange={(v) => set({ sender_name: v })} disabled={locked} maxLength={100} placeholder={t('z. B. Anna von Muster GmbH')} />
    </Field>
  );
}

/** Warm-up plan and reputation of the sender, as hints above the send button. */
export function SenderHealth({ data, reach }: { data: any; reach?: number }) {
  const t = useT('campaigns');
  if (data.channel !== 'email') return null;
  const p = data.plan;
  const rep = data.reputation;
  const days = p?.active && p.cap && reach && reach > (p.remaining ?? Infinity) ? Math.ceil(reach / p.cap) : 0;
  return (
    <>
      {p?.active && (
        <p className="mk-note" data-tour="campaign-warmup" role="note">
          {t('Aufwärmplan, Tag {day}: heute dürfen noch {remaining} von {cap} Mails raus. Der Rest folgt automatisch an den nächsten Tagen', { day: p.day, remaining: de(p.remaining), cap: de(p.cap) })}
          {days > 1 ? ` – ${t('diese Kampagne braucht voraussichtlich {n} Tage', { n: days })}` : ''}. <Link to="campaigns/deliverability">{t('Details')}</Link>
        </p>
      )}
      {(rep?.level === 'warn' || rep?.level === 'critical') && (
        <p className={`mk-note ${rep.level === 'critical' ? 'bad' : 'warn'}`} role="alert">
          {rep.level === 'critical' ? t('Kritische Zustellwerte:') : t('Auffällige Zustellwerte:')} {rep.text || t('Bounces, Beschwerden oder Abmeldungen sind erhöht.')} {t('Prüfe vor dem Versand die')} <Link to="campaigns/deliverability">{t('Reputation')}</Link>.
        </p>
      )}
    </>
  );
}

// --- WhatsApp -------------------------------------------------------------------------------------------------------

/** German labels (message ids of the campaigns catalog), shown through t(). */
const CATEGORY: Record<string, string> = { MARKETING: 'Werbung', UTILITY: 'Service', AUTHENTICATION: 'Einmalcode' };

const fill = (text: string, values: Record<string, string>, prefix: string) => String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, p) => values[`${prefix}.${p}`] || `{{${p}}}`);

/** The approved WhatsApp template of the campaign and the values for its placeholders (merge fields allowed). */
export function WhatsAppCard({ data, set, locked, onCategory }: { data: any; set: (patch: any) => void; locked: boolean; onCategory: (c: string | undefined) => void }) {
  const t = useT('campaigns');
  const tpls = useLoad(() => api.get<any[]>('/api/messages/meta/templates'), []);
  const cur = data.wa_template ?? null;
  const list = (tpls.data ?? []).filter((x) => String(x.category).toUpperCase() !== 'AUTHENTICATION');
  const chosen = cur ? list.find((x) => x.name === cur.name && (!cur.language || x.language === cur.language)) : undefined;
  useEffect(() => onCategory(chosen ? String(chosen.category).toUpperCase() : undefined), [chosen?.name, chosen?.language, chosen?.category]);
  const values: Record<string, string> = cur?.values ?? {};
  const pick = (v: string) => {
    const tpl = list.find((x) => `${x.name}|${x.language}` === v);
    set({ wa_template: tpl ? { name: tpl.name, language: tpl.language, values: {} } : null });
  };
  return (
    <div className="mk-wa" data-tour="campaign-whatsapp">
      {tpls.error ? (
        <p className="mk-note warn">
          {tpls.error} <Link to="settings/channels">{t('Kanäle einrichten')}</Link>
        </p>
      ) : !tpls.data ? (
        <p className="muted">{t('Vorlagen werden geladen …')}</p>
      ) : (
        <>
          <Field label={t('WhatsApp-Vorlage')} hint={t('Nur von Meta freigegebene Vorlagen. Außerhalb des 24-Stunden-Fensters dürfen Kampagnen nur Vorlagen senden.')}>
            <Sel value={cur ? `${cur.name}|${cur.language}` : ''} disabled={locked} onChange={pick} placeholder={t('Vorlage wählen …')} options={list.map((x) => [`${x.name}|${x.language}`, `${x.name} (${x.language}, ${CATEGORY[String(x.category).toUpperCase()] ? t(CATEGORY[String(x.category).toUpperCase()]) : x.category})${x.supported ? '' : ` – ${t('nicht unterstützt')}`}`] as [string, string])} />
          </Field>
          {!list.length && <p className="mk-note warn">{t('Es gibt noch keine freigegebene Vorlage. Lege sie im Meta Business Manager an und warte auf die Freigabe.')}</p>}
          {chosen && !chosen.supported && <p className="mk-note bad">{t('Diese Vorlage wird hier nicht unterstützt')}{chosen.reason ? `: ${chosen.reason}` : '.'}</p>}
          {chosen && (
            <>
              <p className={`mk-note ${String(chosen.category).toUpperCase() === 'MARKETING' ? 'warn' : ''}`}>
                {String(chosen.category).toUpperCase() === 'MARKETING'
                  ? t('Werbliche Vorlage (Marketing): Es bekommen nur Kontakte mit gültiger WhatsApp-Einwilligung die Nachricht, alle anderen werden übersprungen.')
                  : t('Service-Vorlage (Utility): ohne Werbeeinwilligung, aber nur für Nachrichten zu einem bestehenden Vorgang – keine Werbung darin. Kontakte mit „Nicht stören“ werden trotzdem ausgelassen.')}
              </p>
              {chosen.slots?.map((s: any) => (
                <Field key={s.key} label={s.label}>
                  <Input value={values[s.key] ?? ''} disabled={locked} onChange={(v) => set({ wa_template: { ...cur, values: { ...values, [s.key]: v } } })} placeholder={s.kind !== 'text' ? 'https://…' : s.example ? t('z. B. {example}', { example: s.example }) : '{{contact.first_name|du}}'} />
                </Field>
              ))}
              {!chosen.slots?.length && <p className="muted small">{t('Diese Vorlage hat keine Platzhalter.')}</p>}
              <div className="mk-wa-prev" aria-label={t('Vorschau')}>
                {chosen.header && <strong>{fill(chosen.header, values, 'header')}{'\n'}</strong>}
                {fill(chosen.body, values, 'body')}
                {chosen.footer && <div className="muted small">{chosen.footer}</div>}
                {chosen.buttons?.length > 0 && <div className="small">{chosen.buttons.map((b: string) => `[ ${b} ]`).join('  ')}</div>}
              </div>
              <p className="muted small" style={{ margin: 0 }}>{t('Platzhalter wie')} {'{{contact.first_name|du}}'} {t('werden für jeden Empfänger ersetzt.')}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
