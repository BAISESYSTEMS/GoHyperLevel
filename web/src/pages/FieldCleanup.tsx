import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { act, Badge, Check, confirmAsk, toast, useLoad } from '../ui';
import './crm-gaps.css';

/**
 * Settings → Eigene Felder → "Aufräumen" (modules/field-cleanup.ts): how much each contact field is used (contacts with a value,
 * forms, workflows) and deleting several at once – unused ones by default. Folded until opened.
 */

interface Usage {
  id: string;
  key: string;
  label: string;
  contacts: number;
  forms: { name: string }[];
  workflows: { name: string }[];
  unused: boolean;
}

export function FieldCleanup({ onDone }: { onDone: () => void }) {
  const t = useT('crmgaps');
  const [open, setOpen] = useState(false);
  const usage = useLoad(() => (open ? api.get<{ fields: Usage[] }>('/api/custom-fields/usage') : Promise.resolve({ fields: [] as Usage[] })), [open]);
  const [sel, setSel] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const fields = usage.data?.fields ?? [];
  const unused = fields.filter((f) => f.unused);
  const usedPicked = fields.filter((f) => sel.includes(f.id) && !f.unused).length;

  const remove = async () => {
    if (!confirmAsk(t('{n} Felder löschen? Werte bleiben an den Kontakten gespeichert.', { n: sel.length }))) return;
    const r = await act(() => api.post<{ count: number; skipped: unknown[] }>('/api/custom-fields/bulk-delete', { ids: sel, force }));
    if (!r) return;
    toast(r.skipped.length ? t('{n} gelöscht, {m} noch in Gebrauch und behalten', { n: r.count, m: r.skipped.length }) : t('{n} gelöscht', { n: r.count }));
    setSel([]);
    setForce(false);
    await usage.reload();
    onDone();
  };

  return (
    <details className="tag-bulk field-cleanup" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-tour="settings-field-cleanup">
      <summary>{t('Aufräumen: ungenutzte Felder finden und löschen')}</summary>
      {open && (
        <>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="btn small secondary" disabled={!unused.length} onClick={() => setSel(unused.map((f) => f.id))}>
              {t('Alle ungenutzten wählen ({n})', { n: unused.length })}
            </button>
          </div>
          <table className="t">
            <tbody>
              {fields.map((f) => (
                <tr key={f.id}>
                  <td style={{ width: 28 }}>
                    <input type="checkbox" checked={sel.includes(f.id)} onChange={(e) => setSel(e.target.checked ? [...sel, f.id] : sel.filter((x) => x !== f.id))} aria-label={t('{name} wählen', { name: f.label })} />
                  </td>
                  <td>{f.label}</td>
                  <td className="muted small" title={[...f.forms, ...f.workflows].map((x) => x.name).join(', ')}>
                    {f.unused ? <Badge>{t('ungenutzt')}</Badge> : t('{c} Kontakte · {fo} Formulare · {w} Workflows', { c: f.contacts, fo: f.forms.length, w: f.workflows.length })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!fields.length && <p className="muted small">{t('Keine eigenen Felder.')}</p>}
          {sel.length > 0 && (
            <div className="tag-bulk-bar">
              <strong>{t('{n} gewählt', { n: sel.length })}</strong>
              {usedPicked > 0 && <Check checked={force} onChange={setForce} label={t('Auch Felder in Gebrauch löschen ({n})', { n: usedPicked })} />}
              <button className="btn small danger" onClick={remove}>
                {t('Löschen')}
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
