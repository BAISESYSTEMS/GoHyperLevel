import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Check, Field, Input, Modal, Select, Spinner, act, confirmAsk, useLoad } from '../ui';

/**
 * Eigene Rollen (modules/role-templates.ts, docs/security.md#roles) under Einstellungen → Team (slot "settings.team"): roles with
 * areas and read-only areas, ready-made presets, and who has which role. Changing a role updates everyone who has it.
 */

type Tpl = { id?: string; name: string; description: string; permissions: string[]; readonly: string[] };

export function RoleTemplatesCard() {
  const t = useT('gaps');
  const data = useLoad(() => api.get<any>('/api/role-templates'), []);
  const users = useLoad(() => api.get<any[]>('/api/users'), []);
  const [edit, setEdit] = useState<Tpl | null>(null);
  const [assign, setAssign] = useState<{ id: string; users: string[] } | null>(null);
  if (!data.data) return <Spinner />;
  const d = data.data;
  const perms: Record<string, string> = d.permissions;
  const members = (users.data ?? []).filter((u) => u.role === 'member');
  const save = async () => {
    if (!edit) return;
    const r = await act(() => (edit.id ? api.patch(`/api/role-templates/${edit.id}`, edit) : api.post('/api/role-templates', edit)), t('Gespeichert'));
    if (r) {
      setEdit(null);
      data.reload();
      users.reload();
    }
  };
  const doAssign = async () => {
    if (!assign) return;
    const r = await act(() => api.post(`/api/role-templates/${assign.id}/assign`, { user_ids: assign.users }), t('Rolle zugewiesen'));
    if (r) {
      setAssign(null);
      data.reload();
      users.reload();
    }
  };
  return (
    <div className="card" data-tour="role-templates">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Rollen')}</h2>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
          <div style={{ width: 200 }}>
            <Select
              value=""
              aria={t('Vorlage übernehmen')}
              onChange={(k) => {
                const p = d.presets.find((x: any) => x.key === k);
                if (p) setEdit({ name: p.name, description: p.description, permissions: p.permissions, readonly: p.readonly });
              }}
              options={[['', t('Aus Vorlage …')], ...d.presets.map((p: any) => [p.key, t(p.name)] as [string, string])]}
            />
          </div>
          <button className="btn small" onClick={() => setEdit({ name: '', description: '', permissions: ['dashboard', 'contacts'], readonly: [] })}>
            {t('+ Rolle')}
          </button>
        </div>
      </div>
      <p className="muted small">{t('Eine Rolle legt fest, welche Bereiche Mitglieder sehen und wo sie nur lesen dürfen. Änderst du die Rolle, gilt das sofort für alle mit dieser Rolle.')}</p>
      {d.templates.length > 0 && (
        <table className="t">
          <tbody>
            {d.templates.map((r: any) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong> <span className="muted small">{t.plural(r.users, { zero: 'niemand', one: '{n} Person', other: '{n} Personen' })}</span>
                  <div className="small">
                    {r.permissions.map((p: string) => (
                      <Badge key={p} tone={r.readonly.includes(p) ? 'gray' : 'blue'}>
                        {perms[p] ?? p}
                        {r.readonly.includes(p) ? ` (${t('lesen')})` : ''}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small" disabled={!members.length} onClick={() => setAssign({ id: r.id, users: Object.entries(d.assignments).filter(([, v]) => v === r.id).map(([k]) => k) })}>
                      {t('Zuweisen')}
                    </button>
                    <button className="btn small secondary" onClick={() => setEdit({ id: r.id, name: r.name, description: r.description, permissions: r.permissions, readonly: r.readonly })}>
                      {t('Bearbeiten')}
                    </button>
                    <button className="btn small secondary" onClick={async () => confirmAsk(t('Rolle „{n}“ löschen? Die Personen behalten ihre jetzigen Bereiche.', { n: r.name })) && (await act(() => api.del(`/api/role-templates/${r.id}`))) && data.reload()}>
                      {t('Löschen')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal
          title={edit.id ? t('Rolle bearbeiten') : t('Neue Rolle')}
          onClose={() => setEdit(null)}
          wide
          footer={
            <button className="btn" disabled={!edit.name.trim() || !edit.permissions.length} onClick={save}>
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Name')}>
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder={t('z. B. Vertrieb')} />
          </Field>
          <Field label={t('Bereiche')}>
            <div className="grid2">
              {Object.entries(perms).map(([k, label]) => (
                <Check key={k} checked={edit.permissions.includes(k)} onChange={(on) => setEdit({ ...edit, permissions: on ? [...edit.permissions, k] : edit.permissions.filter((x) => x !== k), readonly: on ? edit.readonly : edit.readonly.filter((x) => x !== k) })} label={label} />
              ))}
            </div>
          </Field>
          <MoreFields id="role-template-more" values={[edit.readonly.length ? 'x' : '', edit.description]} label={t('Nur lesen & Beschreibung')}>
            <Field label={t('Nur lesen (nichts anlegen, ändern oder löschen)')}>
              <div className="grid2">
                {edit.permissions.map((k) => (
                  <Check key={k} checked={edit.readonly.includes(k)} onChange={(on) => setEdit({ ...edit, readonly: on ? [...edit.readonly, k] : edit.readonly.filter((x) => x !== k) })} label={perms[k] ?? k} />
                ))}
              </div>
            </Field>
            <Field label={t('Beschreibung')}>
              <Input value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} />
            </Field>
          </MoreFields>
        </Modal>
      )}
      {assign && (
        <Modal
          title={t('Rolle zuweisen')}
          onClose={() => setAssign(null)}
          footer={
            <button className="btn" disabled={!assign.users.length} onClick={doAssign}>
              {t('Zuweisen')}
            </button>
          }
        >
          <p className="muted small">{t('Die Bereiche der gewählten Mitglieder werden durch die der Rolle ersetzt. Admins haben immer alle Rechte.')}</p>
          {members.map((u) => (
            <Check key={u.id} checked={assign.users.includes(u.id)} onChange={(on) => setAssign({ ...assign, users: on ? [...assign.users, u.id] : assign.users.filter((x) => x !== u.id) })} label={`${u.name} (${u.email})`} />
          ))}
        </Modal>
      )}
    </div>
  );
}
