import { Check, Field, Select } from '../ui';
import { useT } from '../i18n';

/** Form settings → Einwilligung: whether a form collects an opt-in for advertising, with which field, purposes and Double-Opt-in. */

// German labels (message ids of the forms catalog), shown through t()
const PURPOSES: [string, string][] = [['newsletter', 'Newsletter'], ['marketing', 'Werbung & Angebote']];

export function FormConsentSetting({ s, setS, fields }: { s: any; setS: (patch: any) => void; fields: any[] }) {
  const t = useT('forms');
  const c = s.consent ?? {};
  const set = (patch: any) => setS({ consent: { ...c, ...patch } });
  const consentFields = fields.filter((f) => f.type === 'consent');
  const purposes: string[] = c.purposes?.length ? c.purposes : ['newsletter'];
  const channels: string[] = c.channels ?? [];
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  return (
    <div className="card" style={{ margin: '12px 0' }} data-tour="form-consent">
      <strong>{t('Einwilligung für Werbung')}</strong>
      <p className="muted small">
        {t('Nur wenn das hier eingeschaltet ist, gilt eine Einsendung als Einwilligung für Newsletter oder Werbung – und nur, wenn die Person das Feld „Einwilligung“ selbst angehakt hat. Der Text des Feldes wird mit Zeitpunkt, Quelle und gekürzter IP als Nachweis gespeichert. Das übliche Häkchen „Ich stimme der Verarbeitung meiner Daten zu“ reicht dafür nicht.')}
      </p>
      <Check checked={!!c.marketing} onChange={(v) => set({ marketing: v })} label={t('Dieses Formular holt eine Einwilligung für E-Mail-Werbung ein')} tour="form-consent-on" />
      {c.marketing && (
        <>
          {!consentFields.length && <p className="muted small" style={{ color: 'var(--red, #b91c1c)' }}>{t('Das Formular hat noch kein Feld vom Typ „Einwilligung (DSGVO)“ – ohne dieses Feld wird nichts gespeichert. Füge eines unter „Felder“ hinzu und formuliere den Werbe-Text, z. B. „Ich möchte den Newsletter erhalten und kann mich jederzeit abmelden.“')}</p>}
          {consentFields.length > 1 && (
            <Field label={t('Welches Feld ist die Werbe-Einwilligung?')}>
              <Select value={c.field ?? ''} onChange={(v) => set({ field: v })} placeholder={t('Das erste Einwilligungs-Feld')} options={consentFields.map((f) => [f.name, f.label.length > 70 ? `${f.label.slice(0, 70)}…` : f.label] as [string, string])} />
            </Field>
          )}
          <Field label={t('Wofür')}>
            <div>
              {PURPOSES.map(([k, l]) => (
                <Check key={k} checked={purposes.includes(k)} onChange={(v) => set({ purposes: toggle(purposes, k, v) })} label={t(l)} />
              ))}
            </div>
          </Field>
          <Field label={t('Zusätzlich für')} hint={t('Die Person braucht dafür eine Telefonnummer im Formular. Der Text des Feldes sollte den Kanal nennen.')}>
            <div>
              <Check checked={channels.includes('sms')} onChange={(v) => set({ channels: toggle(channels, 'sms', v) })} label={t('SMS-Werbung')} />
              <Check checked={channels.includes('whatsapp')} onChange={(v) => set({ channels: toggle(channels, 'whatsapp', v) })} label={t('WhatsApp-Werbung')} />
            </div>
          </Field>
          <Field label={t('Double-Opt-in')} hint={t('Bestätigungs-Mail mit Link, bevor die Einwilligung gilt. Die Voreinstellung steht unter Einstellungen → Einwilligung & Recht.')}>
            <Select value={c.doi ?? 'inherit'} onChange={(v) => set({ doi: v })} options={[['inherit', t('Wie in den Einstellungen')], ['on', t('Immer verlangen')], ['off', t('Nicht verlangen')]]} />
          </Field>
        </>
      )}
    </div>
  );
}
