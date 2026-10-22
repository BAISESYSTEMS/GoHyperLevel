import { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Check, Copy, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';
import { useT } from '../i18n';
import './CustomValues.css';

/**
 * Settings → Custom Values: global placeholders of the sub-account ({{custom_values.key}}) with folders, the values a snapshot
 * left to fill in, form targets ("Custom Value setzen") and a preview of a text with placeholders.
 */

interface Value {
  id: string;
  key: string;
  name: string;
  value: string;
  folder: string;
  description: string;
  in_snapshot: boolean;
  needs_value: boolean;
  placeholder: string;
}

const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'v_$1')
    .slice(0, 60);

export function CustomValuesSettings() {
  const t = useT('customvalues');
  const data = useLoad(() => api.get<{ values: Value[]; folders: string[]; pending: number; limit: number }>('/api/custom-values'), []);
  const [folder, setFolder] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Partial<Value> | null>(null);
  const values = data.data?.values ?? [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return values.filter((v) => (!folder || v.folder === folder) && (!s || `${v.name} ${v.key} ${v.value}`.toLowerCase().includes(s)));
  }, [values, folder, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Value[]>();
    for (const v of shown) m.set(v.folder, [...(m.get(v.folder) ?? []), v]);
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [shown]);
  if (!data.data) return <Spinner />;

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '2 1 520px' }} data-tour="settings-custom-values">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t('Custom Values')}</h2>
          <button className="btn" onClick={() => setEdit({ name: '', key: '', value: '', folder: folder, description: '', in_snapshot: false })}>
            {t('+ Neuer Wert')}
          </button>
        </div>
        <p className="muted small">{t('Globale Platzhalter dieses Sub-Accounts – z. B. Telefonnummer, Öffnungszeiten oder ein Rabattcode. Ändere den Wert hier, und er ändert sich in allen E-Mails, SMS, Workflows, Dokumenten und Seiten, die den Platzhalter nutzen.')}</p>
        {data.data.pending > 0 && (
          <p className="notice small" role="status">
            {t.plural(data.data.pending, { one: 'Ein Wert aus einem Snapshot wartet auf deinen Inhalt.', other: '{n} Werte aus einem Snapshot warten auf deinen Inhalt.' })}{' '}
            <button className="btn small secondary" onClick={() => (setFolder(''), setQ(''))}>
              {t('Alle zeigen')}
            </button>
          </p>
        )}
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="grow">
            <Input value={q} onChange={setQ} placeholder={t('Suchen…')} aria-label={t('Suchen')} />
          </div>
          {data.data.folders.length > 0 && (
            <div style={{ width: 200 }}>
              <Select value={folder} onChange={setFolder} aria={t('Ordner')} options={[['', t('Alle Ordner')], ...data.data.folders.map((f) => [f, f] as [string, string])]} />
            </div>
          )}
        </div>
        {!values.length ? (
          <Empty action={<button className="btn" onClick={() => setEdit({ name: '', key: '', value: '', folder: '', description: '', in_snapshot: false })}>{t('Ersten Wert anlegen')}</button>}>{t('Noch keine Custom Values.')}</Empty>
        ) : (
          groups.map(([name, list]) => (
            <div key={name || '-'}>
              {(data.data!.folders.length > 0 || name) && <h3 className="cv-folder">{name || t('Ohne Ordner')}</h3>}
              <table className="t cv-table">
                <tbody>
                  {list.map((v) => (
                    <tr key={v.id} className={v.needs_value ? 'cv-pending' : undefined}>
                      <td>
                        <b>{v.name}</b>
                        {v.needs_value && (
                          <>
                            {' '}
                            <Badge tone="yellow">{t('Wert fehlt')}</Badge>
                          </>
                        )}
                        {v.description && <div className="muted small">{v.description}</div>}
                      </td>
                      <td className="mono small">
                        {v.placeholder} <Copy text={v.placeholder} />
                      </td>
                      <td className="cv-value">{v.value || <span className="muted">{t('(leer)')}</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small secondary" onClick={() => setEdit(v)}>
                          {t('Bearbeiten')}
                        </button>{' '}
                        <button className="icon-btn" aria-label={t('Löschen')} onClick={() => confirmAsk(t('„{name}“ löschen? Texte mit dem Platzhalter zeigen danach nichts mehr an dieser Stelle.', { name: v.name })) && act(() => api.del(`/api/custom-values/${v.id}`)).then(data.reload)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
      <div style={{ flex: '1 1 300px', display: 'grid', gap: 16 }}>
        <PreviewCard />
        <FormTargets values={values} />
      </div>
      {edit && <EditValue value={edit} folders={data.data.folders} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), data.reload())} />}
    </div>
  );
}

function EditValue({ value, folders, onClose, onSaved }: { value: Partial<Value>; folders: string[]; onClose(): void; onSaved(): void }) {
  const t = useT('customvalues');
  const [v, setV] = useState<Partial<Value>>(value);
  const [keyTouched, setKeyTouched] = useState(!!value.id);
  const isNew = !value.id;
  const save = async () => {
    const body = { name: v.name, key: v.key, value: v.value ?? '', folder: v.folder ?? '', description: v.description ?? '', in_snapshot: !!v.in_snapshot };
    const r = await act(() => (isNew ? api.post('/api/custom-values', body) : api.patch(`/api/custom-values/${value.id}`, body)), isNew ? t('Angelegt') : t('Gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={isNew ? t('Neuer Custom Value') : t('Custom Value bearbeiten')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!v.name?.trim()} onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={v.name} autoFocus onChange={(name) => setV({ ...v, name, ...(keyTouched ? {} : { key: keyOf(name) }) })} placeholder={t('z. B. Telefon Hotline')} />
      </Field>
      <Field label={t('Schlüssel')} hint={t('Im Text: {placeholder}', { placeholder: `{{custom_values.${v.key || '…'}}}` })}>
        <Input className="mono" value={v.key} onChange={(key) => (setKeyTouched(true), setV({ ...v, key: key.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} placeholder="telefon_hotline" />
      </Field>
      <Field label={t('Wert')}>
        <Textarea value={v.value} onChange={(value) => setV({ ...v, value })} rows={3} />
      </Field>
      <Field label={t('Ordner (optional)')}>
        <Input value={v.folder} onChange={(folder) => setV({ ...v, folder })} list="cv-folders" placeholder={t('z. B. Kontakt')} />
        <datalist id="cv-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      <Field label={t('Hinweis (optional)')} hint={t('Steht im Snapshot dabei, damit dein Kunde weiß, was hier hingehört.')}>
        <Input value={v.description} onChange={(description) => setV({ ...v, description })} />
      </Field>
      <Check checked={!!v.in_snapshot} onChange={(in_snapshot) => setV({ ...v, in_snapshot })} label={t('Wert im Snapshot mitgeben (sonst nur der Platzhalter)')} />
    </Modal>
  );
}

function PreviewCard() {
  const t = useT('customvalues');
  const [text, setText] = useState('');
  const [out, setOut] = useState('');
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{t('Ausprobieren')}</h3>
      <Textarea value={text} onChange={setText} rows={3} placeholder={`${t('Ruf uns an:')} {{custom_values.telefon_hotline}}`} aria-label={t('Text mit Platzhaltern')} />
      <div className="actions">
        <button className="btn small secondary" disabled={!text.trim()} onClick={async () => setOut((await act(() => api.post<{ text: string }>('/api/custom-values/preview', { text })))?.text ?? '')}>
          {t('Vorschau')}
        </button>
      </div>
      {out && <p className="cv-preview">{out}</p>}
    </div>
  );
}

function FormTargets({ values }: { values: Value[] }) {
  const t = useT('customvalues');
  const targets = useLoad(() => api.get<any[]>('/api/custom-values/form-targets'), []);
  const forms = useLoad(() => api.get<any[]>('/api/forms'), []);
  const [n, setN] = useState({ form_id: '', field_id: '', value_key: '' });
  const form = (forms.data ?? []).find((f) => f.id === n.form_id);
  const fields = (form?.fields ?? []).filter((f: any) => !['file', 'signature', 'payment', 'heading', 'page_break'].includes(f.type));
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{t('Formular-Ziel „Custom Value setzen“')}</h3>
      <p className="muted small">{t('Ein Formularfeld überschreibt beim Absenden einen Custom Value – z. B. ein internes Formular, mit dem das Team den Aktionscode der Woche setzt. Die Eingabe kommt von außen: nutze das nur für Formulare, die du kontrollierst.')}</p>
      <Select value={n.form_id} onChange={(form_id) => setN({ ...n, form_id, field_id: '' })} placeholder={t('Formular wählen')} aria={t('Formular')} options={(forms.data ?? []).map((f) => [f.id, f.name] as [string, string])} />
      {form && <Select value={n.field_id} onChange={(field_id) => setN({ ...n, field_id })} placeholder={t('Feld wählen')} aria={t('Feld')} options={fields.map((f: any) => [f.id, String(f.label || f.name)] as [string, string])} />}
      <Select value={n.value_key} onChange={(value_key) => setN({ ...n, value_key })} placeholder={t('Custom Value wählen')} aria={t('Custom Value')} options={values.map((v) => [v.key, v.name] as [string, string])} />
      <div className="actions">
        <button className="btn small" disabled={!n.form_id || !n.field_id || !n.value_key} onClick={() => act(() => api.post('/api/custom-values/form-targets', n), t('Ziel angelegt')).then((r) => r && (setN({ form_id: '', field_id: '', value_key: '' }), targets.reload()))}>
          {t('Ziel anlegen')}
        </button>
      </div>
      {(targets.data ?? []).map((x) => (
        <div key={x.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
          <span className="small">
            {t('{form} → {field} setzt {key}', { form: x.form_name, field: x.field_label, key: `{{custom_values.${x.value_key}}}` })}
          </span>
          <button className="icon-btn" aria-label={t('Ziel löschen')} onClick={() => act(() => api.del(`/api/custom-values/form-targets/${x.id}`)).then(targets.reload)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
