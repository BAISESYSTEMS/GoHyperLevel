import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Check, CodeBox, Empty, Field, Input, Modal, Select, Spinner, Tabs, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { useTicketMeta } from './Tickets';
import { getLocale, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { MoreFields } from '../areas/fields';

/** Einstellungen → Service: SLAs, business hours, pipelines, teams & assignment, email → ticket, replies, CSAT, portal & help center, health score. */

// German labels (message ids of the helpdesk catalog), shown through t()
const DAYS: [string, string][] = [['mon', 'Montag'], ['tue', 'Dienstag'], ['wed', 'Mittwoch'], ['thu', 'Donnerstag'], ['fri', 'Freitag'], ['sat', 'Samstag'], ['sun', 'Sonntag']];
const PRIOS: [string, string][] = [['dringend', 'Dringend'], ['hoch', 'Hoch'], ['normal', 'Normal'], ['niedrig', 'Niedrig']];
const KINDS: [string, string][] = [['new', 'Neu'], ['open', 'Offen / in Arbeit'], ['waiting', 'Wartet'], ['resolved', 'Gelöst'], ['closed', 'Geschlossen']];
const SIGNALS: [string, string][] = [
  ['open_tickets', 'Offene Tickets'],
  ['overdue_tickets', 'Überfällige Tickets (SLA)'],
  ['csat', 'Letzte Zufriedenheit (CSAT)'],
  ['nps', 'Letzter NPS'],
  ['activity', 'Tage seit letzter Aktivität'],
  ['overdue_invoices', 'Überfällige Rechnungen'],
  ['deals', 'Deal-Status'],
  ['engagement', 'E-Mail-Öffnungen/Klicks'],
];

/** Minutes ↔ "h" input in hours with decimals. */
const hours = (min: number) => {
  const h = String(Math.round((min / 60) * 100) / 100);
  return getLocale() === SOURCE_LOCALE ? h.replace('.', ',') : h;
};
const toMin = (h: string) => Math.round(Number(String(h).replace(',', '.')) * 60) || 0;
/** Hours with a decimal comma; commits on blur so "1," can be typed. */
function HoursInput({ min, onChange, label }: { min: number; onChange: (min: number) => void; label: string }) {
  const [v, setV] = useState(hours(min));
  useEffect(() => setV(hours(min)), [min]);
  return <Input value={v} onChange={setV} onBlur={() => onChange(toMin(v))} inputMode="decimal" aria-label={label} />;
}

function Pipelines() {
  const t = useT('helpdesk');
  const pipes = useLoad(() => api.get<any[]>('/api/helpdesk/pipelines'), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const r = await act(() => (edit.id ? api.patch(`/api/helpdesk/pipelines/${edit.id}`, edit) : api.post('/api/helpdesk/pipelines', edit)), t('Pipeline gespeichert'));
    if (r) (setEdit(null), pipes.reload());
  };
  const move = (i: number, dir: number) => {
    const s = [...edit.stages];
    [s[i], s[i + dir]] = [s[i + dir], s[i]];
    setEdit({ ...edit, stages: s });
  };
  return (
    <div className="card" style={{ maxWidth: 820 }} data-tour="hd-pipelines">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('Ticket-Pipelines')}</h2>
        <button className="btn small secondary" onClick={() => setEdit({ name: t('Neue Pipeline'), stages: [{ name: t('Neu'), kind: 'new' }, { name: t('In Bearbeitung'), kind: 'open' }, { name: t('Wartet auf Kunde'), kind: 'waiting', pause_sla: true }, { name: t('Gelöst'), kind: 'resolved' }, { name: t('Geschlossen'), kind: 'closed' }] })}>
          {t('+ Pipeline')}
        </button>
      </div>
      <p className="muted">{t('Jede Stufe hat eine Bedeutung: offene Stufen laufen im SLA, „Wartet“ pausiert die Lösungszeit (wenn angehakt), „Gelöst“ schickt die Zufriedenheits-Umfrage.')}</p>
      {(pipes.data ?? []).map((p) => (
        <div key={p.id} className="row pipe-row" style={{ alignItems: 'center' }}>
          <strong className="grow">{p.name}</strong>
          <span className="muted small grow">{p.stages.map((s: any) => s.name).join(' → ')}</span>
          <button className="btn small secondary" onClick={() => setEdit(structuredClone(p))}>
            {t('Bearbeiten')}
          </button>
        </div>
      ))}
      {edit && (
        <Modal
          title={edit.id ? t('Pipeline bearbeiten') : t('Neue Pipeline')}
          wide
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => confirmAsk(t('Pipeline löschen? (nur ohne Tickets möglich)')) && (await act(() => api.del(`/api/helpdesk/pipelines/${edit.id}`))) && (setEdit(null), pipes.reload())}>
                  {t('Löschen')}
                </button>
              )}
              <button className="btn" onClick={save}>
                {t('Speichern')}
              </button>
            </>
          }
        >
          <Field label="Name">
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
          </Field>
          <Field label={t('Stufen')}>
            {edit.stages.map((s: any, i: number) => (
              <div key={s.id ?? i} className="row stage-row" style={{ alignItems: 'center', marginBottom: 6 }}>
                <div className="grow">
                  <Input value={s.name} onChange={(v) => setEdit({ ...edit, stages: edit.stages.map((x: any, j: number) => (j === i ? { ...x, name: v } : x)) })} />
                </div>
                <div style={{ width: 170 }}>
                  <Select value={s.kind} onChange={(v) => setEdit({ ...edit, stages: edit.stages.map((x: any, j: number) => (j === i ? { ...x, kind: v } : x)) })} options={KINDS.map(([k, l]) => [k, t(l)] as [string, string])} />
                </div>
                <Check checked={!!s.pause_sla} onChange={(v) => setEdit({ ...edit, stages: edit.stages.map((x: any, j: number) => (j === i ? { ...x, pause_sla: v } : x)) })} label={t('SLA pausieren')} />
                <button className="icon-btn" disabled={!i} onClick={() => move(i, -1)} aria-label={t('Nach oben')}>
                  ↑
                </button>
                <button className="icon-btn" disabled={i === edit.stages.length - 1} onClick={() => move(i, 1)} aria-label={t('Nach unten')}>
                  ↓
                </button>
                <button className="icon-btn" disabled={edit.stages.length < 2} onClick={() => setEdit({ ...edit, stages: edit.stages.filter((_: any, j: number) => j !== i) })} aria-label={t('Stufe entfernen')}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn small secondary" onClick={() => setEdit({ ...edit, stages: [...edit.stages, { name: t('Neue Stufe'), kind: 'open' }] })}>
              {t('+ Stufe')}
            </button>
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Teams() {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const teams = useLoad(() => api.get<any[]>('/api/helpdesk/teams'), []);
  const [edit, setEdit] = useState<any>(null);
  const agents = meta.data?.agents ?? [];
  const save = async () => {
    const r = await act(() => (edit.id ? api.patch(`/api/helpdesk/teams/${edit.id}`, edit) : api.post('/api/helpdesk/teams', edit)), t('Team gespeichert'));
    if (r) (setEdit(null), teams.reload(), meta.reload());
  };
  return (
    <div className="card" data-tour="hd-teams">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('Teams / Queues')}</h2>
        <button className="btn small secondary" onClick={() => setEdit({ name: '', members: [], round_robin: true })}>
          {t('+ Team')}
        </button>
      </div>
      {(teams.data ?? []).length ? (
        (teams.data ?? []).map((tk) => (
          <div key={tk.id} className="row pipe-row" style={{ alignItems: 'center' }}>
            <strong className="grow">{tk.name}</strong>
            <span className="muted small grow">{tk.members.map((m: string) => agents.find((a: any) => a.id === m)?.name ?? '?').join(', ') || t('keine Mitglieder')}</span>
            {tk.round_robin ? <Badge tone="blue">{t('Round Robin')}</Badge> : <Badge>{t('manuell')}</Badge>}
            <button className="btn small secondary" onClick={() => setEdit({ ...tk, round_robin: !!tk.round_robin })}>
              {t('Bearbeiten')}
            </button>
          </div>
        ))
      ) : (
        <p className="muted">{t('Noch keine Teams. Teams verteilen Tickets reihum (Round Robin) und dienen als Queue.')}</p>
      )}
      {edit && (
        <Modal
          title={edit.id ? t('Team bearbeiten') : t('Neues Team')}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => confirmAsk(t('Team „{name}“ löschen?', { name: edit.name })) && (await act(() => api.del(`/api/helpdesk/teams/${edit.id}`))) && (setEdit(null), teams.reload())}>
                  {t('Löschen')}
                </button>
              )}
              <button className="btn" onClick={save}>
                {t('Speichern')}
              </button>
            </>
          }
        >
          <Field label="Name">
            <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder={t('z. B. 1st Level Support')} />
          </Field>
          <Field label={t('Mitglieder')}>
            {agents.map((a: any) => (
              <Check key={a.id} checked={edit.members.includes(a.id)} onChange={(v) => setEdit({ ...edit, members: v ? [...edit.members, a.id] : edit.members.filter((x: string) => x !== a.id) })} label={`${a.name} (${a.email})`} />
            ))}
          </Field>
          <Check checked={edit.round_robin} onChange={(v) => setEdit({ ...edit, round_robin: v })} label={t('Neue Tickets reihum zuweisen (Round Robin)')} />
        </Modal>
      )}
    </div>
  );
}

function Canned() {
  const t = useT('helpdesk');
  const list = useLoad(() => api.get<any[]>('/api/helpdesk/canned'), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    const r = await act(() => (edit.id ? api.patch(`/api/helpdesk/canned/${edit.id}`, edit) : api.post('/api/helpdesk/canned', edit)), t('Gespeichert'));
    if (r) (setEdit(null), list.reload());
  };
  return (
    <div className="card" style={{ maxWidth: 820 }} data-tour="hd-canned">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('Textbausteine')}</h2>
        <button className="btn small secondary" onClick={() => setEdit({ name: '', shortcut: '', body: t('Hallo {{contact.first_name|}},\n\n…\n\nViele Grüße\n{{agent.name}}') })}>
          {t('+ Textbaustein')}
        </button>
      </div>
      {(list.data ?? []).length ? (
        (list.data ?? []).map((c) => (
          <div key={c.id} className="row pipe-row" style={{ alignItems: 'center' }}>
            <strong className="grow">
              {c.name} {c.shortcut && <span className="muted small">/{c.shortcut}</span>}
            </strong>
            <span className="muted small grow">{c.body.slice(0, 80)}</span>
            <button className="btn small secondary" onClick={() => setEdit(c)}>
              {t('Bearbeiten')}
            </button>
          </div>
        ))
      ) : (
        <p className="muted">{t('Fertige Antworten für häufige Fragen – im Ticket mit einem Klick eingefügt.')}</p>
      )}
      {edit && (
        <Modal
          title={edit.id ? t('Textbaustein bearbeiten') : t('Neuer Textbaustein')}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id && (
                <button className="btn danger" onClick={async () => confirmAsk(t('Textbaustein löschen?')) && (await act(() => api.del(`/api/helpdesk/canned/${edit.id}`))) && (setEdit(null), list.reload())}>
                  {t('Löschen')}
                </button>
              )}
              <button className="btn" onClick={save}>
                {t('Speichern')}
              </button>
            </>
          }
        >
          <div className="grid2">
            <Field label="Name">
              <Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} />
            </Field>
            <Field label={t('Kürzel (optional)')}>
              <Input value={edit.shortcut} onChange={(v) => setEdit({ ...edit, shortcut: v })} placeholder={t('danke')} />
            </Field>
          </div>
          <Field label={t('Text')} hint={t('Platzhalter: {{contact.first_name}}, {{contact.name}}, {{ticket.number}}, {{ticket.subject}}, {{ticket.status}}, {{agent.name}}, {{location.name}} – Fallback mit {{contact.first_name|du}}')}>
            <Textarea value={edit.body} onChange={(v) => setEdit({ ...edit, body: v })} rows={8} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

export function HelpdeskSettings() {
  const t = useT('helpdesk');
  const loaded = useLoad(() => api.get('/api/helpdesk/settings'), []);
  const meta = useTicketMeta();
  const [s, setS] = useState<any>();
  const [tab, setTab] = useState('sla');
  useEffect(() => setS(loaded.data?.settings), [loaded.data]);
  if (loaded.error) return <Empty>{loaded.error}</Empty>;
  if (!s || !loaded.data) return <Spinner />;
  const set = (k: string, patch: any) => setS({ ...s, [k]: { ...s[k], ...patch } });
  const save = async (body: any = s) => {
    const r = await act(() => api.put('/api/helpdesk/settings', body), t('Gespeichert'));
    if (r) loaded.setData(r);
  };
  const teams = meta.data?.teams ?? [];
  const agents = meta.data?.agents ?? [];
  const saveBtn = (
    <button className="btn" onClick={() => save()}>
      {t('Speichern')}
    </button>
  );
  return (
    <div className="helpdesk-settings">
      <Tabs
        tabs={[
          ['sla', t('SLA & Zeiten')],
          ['pipelines', 'Pipelines'],
          ['assign', t('Teams & Zuweisung')],
          ['email', t('E-Mail → Ticket')],
          ['replies', t('Antworten')],
          ['csat', t('Zufriedenheit')],
          ['portal', t('Portal & Hilfe-Center')],
          ['health', t('Health-Score')],
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 14 }}>
        {tab === 'sla' && (
          <>
            <div className="card" style={{ maxWidth: 820 }} data-tour="hd-sla">
              <h2>{t('SLA-Ziele je Priorität')}</h2>
              <Check checked={s.sla.enabled} onChange={(v) => set('sla', { enabled: v })} label={t('SLA-Zeiten für neue Tickets messen')} />
              <table className="t sla-table">
                <thead>
                  <tr>
                    <th>{t('Priorität')}</th>
                    <th>{t('Erste Antwort (Std.)')}</th>
                    <th>{t('Lösung (Std.)')}</th>
                    <th>{t('Zählt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {PRIOS.map(([p, de]) => [p, t(de)]).map(([p, l]) => {
                    const pol = s.sla.policies[p];
                    const setP = (patch: any) => set('sla', { policies: { ...s.sla.policies, [p]: { ...pol, ...patch } } });
                    return (
                      <tr key={p}>
                        <td>{l}</td>
                        <td>
                          <HoursInput min={pol.first_response_min} onChange={(x) => setP({ first_response_min: x })} label={t('Erste Antwort {priority}', { priority: l })} />
                        </td>
                        <td>
                          <HoursInput min={pol.resolution_min} onChange={(x) => setP({ resolution_min: x })} label={t('Lösung {priority}', { priority: l })} />
                        </td>
                        <td>
                          <Select value={pol.business_hours ? '1' : '0'} onChange={(v) => setP({ business_hours: v === '1' })} options={[['1', t('Geschäftszeit')], ['0', t('Rund um die Uhr')]]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted small">{t('„Geschäftszeit“: Nachts, am Wochenende und an Feiertagen steht die Uhr still (Zeitzone')} {loaded.data.timezone}{t('). 8 Std. = ein Arbeitstag. 0 = kein Ziel.')}</p>
              <MoreFields id="hd-sla-escalation" values={[s.sla.breach_team_id, s.sla.raise_priority_on_breach]}>
              <div className="grid2">
                <Field label={t('Warnung „läuft bald ab“ bei (% der Zeit)')}>
                  <Input type="number" value={s.sla.warn_percent} onChange={(v) => set('sla', { warn_percent: Number(v) })} />
                </Field>
                <Field label={t('Bei Überschreitung an Team geben')}>
                  <Select value={s.sla.breach_team_id} onChange={(v) => set('sla', { breach_team_id: v })} placeholder={t('– nicht umverteilen –')} options={teams.map((tk: any) => [tk.id, tk.name])} />
                </Field>
              </div>
              <Check checked={s.sla.notify_owner} onChange={(v) => set('sla', { notify_owner: v })} label={t('Bei Überschreitung Zuständige/n per E-Mail und Push benachrichtigen')} />
              <Check checked={s.sla.raise_priority_on_breach} onChange={(v) => set('sla', { raise_priority_on_breach: v })} label={t('Bei Überschreitung Priorität eine Stufe erhöhen')} />
              <p className="muted small">{t('Mehr Eskalation über Automationen: Auslöser „SLA läuft bald ab“ / „SLA überschritten“ mit „Ticket ändern“ und „Team benachrichtigen“.')}</p>
              </MoreFields>
            </div>
            <div className="card" style={{ maxWidth: 820 }} data-tour="hd-hours">
              <h2>{t('Geschäftszeiten')}</h2>
              {DAYS.map(([k, de]) => [k, t(de)]).map(([k, l]) => {
                const h = s.business_hours[k];
                const setH = (patch: any) => setS({ ...s, business_hours: { ...s.business_hours, [k]: { ...h, ...patch } } });
                return (
                  <div key={k} className="row hours-row" style={{ alignItems: 'center' }}>
                    <div style={{ width: 130 }}>
                      <Check checked={h.open} onChange={(v) => setH({ open: v })} label={l} />
                    </div>
                    {h.open ? (
                      <>
                        <div style={{ width: 120 }}>
                          <Input type="time" value={h.from} onChange={(v) => setH({ from: v })} aria-label={t('{day} von', { day: l })} />
                        </div>
                        <span className="muted">{t('bis')}</span>
                        <div style={{ width: 120 }}>
                          <Input type="time" value={h.to} onChange={(v) => setH({ to: v })} aria-label={t('{day} bis', { day: l })} />
                        </div>
                      </>
                    ) : (
                      <span className="muted">{t('geschlossen')}</span>
                    )}
                  </div>
                );
              })}
              <MoreFields id="hd-holidays" values={[s.holidays]}>
                <Field label={t('Feiertage / Schließtage (JJJJ-MM-TT, Komma-getrennt)')}>
                  <Input value={(s.holidays ?? []).join(', ')} onChange={(v) => setS({ ...s, holidays: v.split(',').map((x: string) => x.trim()).filter(Boolean) })} placeholder="2026-12-24, 2026-12-25, 2026-12-26" />
                </Field>
              </MoreFields>
              <Field label={t('Kategorien (Komma-getrennt)')}>
                <Input value={s.categories.join(', ')} onChange={(v) => setS({ ...s, categories: v.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
              </Field>
              {saveBtn}
            </div>
          </>
        )}
        {tab === 'pipelines' && <Pipelines />}
        {tab === 'assign' && (
          <div className="grid2" style={{ gap: 14, alignItems: 'start' }}>
            <div className="card" data-tour="hd-assign">
              <h2>{t('Zuweisung neuer Tickets')}</h2>
              <Field label={t('Regel')}>
                <Select
                  value={s.assignment.mode}
                  onChange={(v) => set('assignment', { mode: v })}
                  options={[
                    ['manual', t('Manuell – niemand automatisch')],
                    ['round_robin', t('Round Robin im Standard-Team')],
                    ['category', t('Nach Kategorie, sonst Round Robin')],
                  ]}
                />
              </Field>
              {s.assignment.mode !== 'manual' && (
                <Field label={t('Standard-Team')}>
                  <Select value={s.assignment.default_team_id} onChange={(v) => set('assignment', { default_team_id: v })} placeholder={t('– keins –')} options={teams.map((tk: any) => [tk.id, tk.name])} />
                </Field>
              )}
              {s.assignment.mode === 'category' && (
                <Field label={t('Kategorie-Regeln')}>
                  {s.assignment.rules.map((r: any, i: number) => {
                    const setR = (patch: any) => set('assignment', { rules: s.assignment.rules.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
                    return (
                      <div key={i} className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
                        <div className="grow">
                          <Select value={r.category} onChange={(v) => setR({ category: v })} placeholder={t('Kategorie')} options={s.categories} />
                        </div>
                        <div className="grow">
                          <Select value={r.team_id} onChange={(v) => setR({ team_id: v })} placeholder="Team" options={teams.map((tk: any) => [tk.id, tk.name])} />
                        </div>
                        <div className="grow">
                          <Select value={r.user_id} onChange={(v) => setR({ user_id: v })} placeholder={t('oder Person')} options={agents.map((a: any) => [a.id, a.name])} />
                        </div>
                        <button className="icon-btn" aria-label={t('Regel entfernen')} onClick={() => set('assignment', { rules: s.assignment.rules.filter((_: any, j: number) => j !== i) })}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  <button className="btn small secondary" onClick={() => set('assignment', { rules: [...s.assignment.rules, { category: '', team_id: '', user_id: '' }] })}>
                    {t('+ Regel')}
                  </button>
                </Field>
              )}
              {saveBtn}
            </div>
            <Teams />
          </div>
        )}
        {tab === 'email' && (
          <div className="card" style={{ maxWidth: 820 }} data-tour="hd-email">
            <h2>{t('E-Mails automatisch als Ticket')}</h2>
            <Field label={t('Support-Postfach')} hint={t('Leite deine Support-Adresse (z. B. support@firma.de) per Weiterleitung (Cloudflare Email Workers, ImprovMX, Mailgun …) an diese URL – jede Mail wird zum Ticket bzw. landet im offenen Ticket.')}>
              <CodeBox text={loaded.data.support_hook} />
            </Field>
            <button className="btn small ghost" onClick={async () => confirmAsk(t('Neue URL erzeugen? Die alte funktioniert dann nicht mehr.')) && (await act(() => api.post('/api/helpdesk/settings/rotate-key').then((r) => loaded.setData(r)), t('Neue URL erzeugt')))}>
              {t('Neue URL erzeugen')}
            </button>
            <hr />
            <Field label={t('Normale eingehende E-Mails (Einstellungen → E-Mail & SMS)')}>
              <Select
                value={s.email_to_ticket.mode}
                onChange={(v) => set('email_to_ticket', { mode: v })}
                options={[
                  ['off', t('Nur in Konversationen, keine Tickets')],
                  ['rules', t('Ticket, wenn eine Regel passt')],
                  ['all', t('Jede eingehende E-Mail wird ein Ticket')],
                ]}
              />
            </Field>
            {s.email_to_ticket.mode === 'rules' && (
              <>
                <Field label={t('An diese Adressen (Komma-getrennt)')}>
                  <Input value={s.email_to_ticket.addresses.join(', ')} onChange={(v) => set('email_to_ticket', { addresses: v.split(',').map((x: string) => x.trim()).filter(Boolean) })} placeholder={t('support@firma.de, hilfe@firma.de')} />
                </Field>
                <Field label={t('…oder Betreff enthält')}>
                  <Input value={s.email_to_ticket.keywords.join(', ')} onChange={(v) => set('email_to_ticket', { keywords: v.split(',').map((x: string) => x.trim()).filter(Boolean) })} placeholder={t('hilfe, problem, reklamation')} />
                </Field>
                <Field label={t('…oder Absender-Domain')}>
                  <Input value={s.email_to_ticket.domains.join(', ')} onChange={(v) => set('email_to_ticket', { domains: v.split(',').map((x: string) => x.trim()).filter(Boolean) })} placeholder="kunde.de" />
                </Field>
              </>
            )}
            {s.email_to_ticket.mode !== 'off' && (
              <MoreFields id="hd-email-defaults" values={[s.email_to_ticket.category, s.email_to_ticket.include_imported, s.email_to_ticket.priority !== 'normal' && s.email_to_ticket.priority]}>
                <div className="grid2">
                  <Field label={t('Priorität neuer Tickets')}>
                    <Select value={s.email_to_ticket.priority} onChange={(v) => set('email_to_ticket', { priority: v })} options={PRIOS.map(([k, l]) => [k, t(l)] as [string, string])} />
                  </Field>
                  <Field label={t('Kategorie')}>
                    <Select value={s.email_to_ticket.category} onChange={(v) => set('email_to_ticket', { category: v })} placeholder="–" options={s.categories} />
                  </Field>
                </div>
                <Check checked={s.email_to_ticket.include_imported} onChange={(v) => set('email_to_ticket', { include_imported: v })} label={t('Auch E-Mails aus der Postfach-Synchronisation (IMAP) prüfen – ab jetzt, keine alten Mails')} />
              </MoreFields>
            )}
            <p className="muted small">{t('Antworten mit „[Ticket #123]“ im Betreff und neue Nachrichten von Kontakten mit offenem Ticket landen immer im Ticket – auch per SMS, Chat und WhatsApp.')}</p>
            {saveBtn}
          </div>
        )}
        {tab === 'replies' && (
          <>
            <div className="card" style={{ maxWidth: 820 }} data-tour="hd-ack">
              <h2>{t('Eingangsbestätigung')}</h2>
              <Check checked={s.auto_reply.enabled} onChange={(v) => set('auto_reply', { enabled: v })} label={t('Bei Tickets aus E-Mail, Formular und Kundenportal automatisch bestätigen')} />
              {s.auto_reply.enabled && (
                <>
                  <Field label={t('Betreff')}>
                    <Input value={s.auto_reply.subject} onChange={(v) => set('auto_reply', { subject: v })} />
                  </Field>
                  <Field label={t('Text')} hint={t('Platzhalter wie bei Textbausteinen, z. B. {{ticket.number}}')}>
                    <Textarea value={s.auto_reply.body} onChange={(v) => set('auto_reply', { body: v })} rows={6} />
                  </Field>
                </>
              )}
              {saveBtn}
            </div>
            <Canned />
          </>
        )}
        {tab === 'csat' && (
          <div className="card" style={{ maxWidth: 820 }} data-tour="hd-csat">
            <h2>{t('Zufriedenheits-Umfrage (CSAT)')}</h2>
            <Check checked={s.csat.enabled} onChange={(v) => set('csat', { enabled: v })} label={t('Nach dem Lösen eines Tickets einen Bewertungs-Link senden (1–5 + Kommentar)')} />
            <MoreFields id="hd-csat-delivery" values={[s.csat.channel !== 'auto' && s.csat.channel]}>
              <div className="grid2">
                <Field label={t('Kanal')}>
                  <Select value={s.csat.channel} onChange={(v) => set('csat', { channel: v })} options={[['auto', t('Wie das Ticket (E-Mail, sonst SMS)')], ['email', t('E-Mail')], ['sms', 'SMS']]} />
                </Field>
                <Field label={t('Verzögerung (Minuten)')}>
                  <Input type="number" value={s.csat.delay_min} onChange={(v) => set('csat', { delay_min: Number(v) })} />
                </Field>
              </div>
            </MoreFields>
            <Field label={t('Betreff')}>
              <Input value={s.csat.subject} onChange={(v) => set('csat', { subject: v })} />
            </Field>
            <Field label={t('Text')} hint="{{csat_link}} ist Pflicht – per E-Mail erscheinen dort fünf Smiley-Knöpfe. Der Link ist signiert und gilt nur für dieses Ticket.">
              <Textarea value={s.csat.body} onChange={(v) => set('csat', { body: v })} rows={7} />
            </Field>
            {saveBtn}
          </div>
        )}
        {tab === 'portal' && (
          <div className="grid2" style={{ gap: 14, alignItems: 'start' }}>
            <div className="card" data-tour="hd-portal">
              <h2>{t('Kundenportal „Meine Anfragen“')}</h2>
              <Check checked={s.portal.enabled} onChange={(v) => set('portal', { enabled: v })} label={t('Im Mitgliederbereich anzeigen (Liste, neue Anfrage, antworten, Status)')} />
              <Check checked={s.portal.any_contact} onChange={(v) => set('portal', { any_contact: v })} label={t('Jeder Kontakt mit E-Mail darf sich anmelden (sonst nur mit Ticket oder Kurs)')} />
              <p className="muted small">{t('Der Mitgliederbereich liegt unter /portal/… (Kurse → Mitgliederbereich). Interne Notizen sieht der Kunde nie.')}</p>
              {saveBtn}
            </div>
            <div className="card" data-tour="hd-helpcenter">
              <h2>{t('Öffentliches Hilfe-Center')}</h2>
              <Check checked={s.help_center.enabled} onChange={(v) => set('help_center', { enabled: v })} label={t('Hilfe-Center öffentlich schalten')} />
              {s.help_center.enabled && (
                <p className="small">
                  <a href={loaded.data.help_center_url} target="_blank" rel="noopener">
                    <Icon name="external" size={13} /> {loaded.data.help_center_url}
                  </a>
                </p>
              )}
              <div className="grid2">
                <Field label={t('Adresse (/help/…)')}>
                  <Input value={s.help_center.slug} onChange={(v) => set('help_center', { slug: v })} placeholder={t('firma')} />
                </Field>
                <Field label={t('Titel')}>
                  <Input value={s.help_center.title} onChange={(v) => set('help_center', { title: v })} placeholder={t('Firma Hilfe-Center')} />
                </Field>
              </div>
              <MoreFields id="hd-helpcenter" values={[s.help_center.color, s.help_center.intro, s.help_center.contact_text, s.help_center.seo_title, s.help_center.seo_description, s.help_center.domain]}>
              <Field label={t('Farbe')}>
                <input type="color" value={s.help_center.color || '#2563eb'} onChange={(e) => set('help_center', { color: e.target.value })} aria-label={t('Farbe')} />
              </Field>
              <Field label={t('Begrüßung')}>
                <Input value={s.help_center.intro} onChange={(v) => set('help_center', { intro: v })} />
              </Field>
              <Field label={t('Hinweis unten („Nichts gefunden?“)')}>
                <Input value={s.help_center.contact_text} onChange={(v) => set('help_center', { contact_text: v })} placeholder={t('Schreib uns – wir helfen gern weiter.')} />
              </Field>
              <Field label={t('SEO-Titel / -Beschreibung')}>
                <Input value={s.help_center.seo_title} onChange={(v) => set('help_center', { seo_title: v })} placeholder={t('Titel für Google')} />
              </Field>
              <Textarea value={s.help_center.seo_description} onChange={(v) => set('help_center', { seo_description: v })} rows={2} placeholder={t('Beschreibung für Google')} />
              <Field label={t('Eigene Domain (optional)')} hint={t('z. B. hilfe.firma.de – CNAME auf diesen Server. Auf verbundenen Website-Domains erscheint das Hilfe-Center automatisch unter /help.')}>
                <Input value={s.help_center.domain} onChange={(v) => set('help_center', { domain: v })} placeholder="hilfe.firma.de" />
              </Field>
              </MoreFields>
              {saveBtn}
            </div>
          </div>
        )}
        {tab === 'health' && <HealthSettings s={s} setS={setS} save={save} />}
      </div>
    </div>
  );
}

function HealthSettings({ s, setS, save }: { s: any; setS: (s: any) => void; save: (b?: any) => Promise<void> }) {
  const t = useT('helpdesk');
  const h = s.health;
  const set = (patch: any) => setS({ ...s, health: { ...h, ...patch } });
  const total = Object.values(h.weights as Record<string, number>).reduce((a, b) => a + Number(b || 0), 0) || 1;
  return (
    <div className="card" style={{ maxWidth: 820 }} data-tour="hd-health">
      <h2>{t('Kunden-Health-Score')}</h2>
      <Check checked={h.enabled} onChange={(v) => set({ enabled: v })} label={t('Health-Score berechnen (Spalte und Filter in Kontakte, Karte auf der Kontaktseite, Auslöser „Health-Score gesunken“)')} />
      <MoreFields id="hd-health-weights">
      <table className="t">
        <thead>
          <tr>
            <th>{t('Signal')}</th>
            <th style={{ width: 120 }}>{t('Gewicht')}</th>
            <th style={{ width: 80 }}>{t('Anteil')}</th>
          </tr>
        </thead>
        <tbody>
          {SIGNALS.map(([k, de]) => [k, t(de)]).map(([k, l]) => (
            <tr key={k}>
              <td>{l}</td>
              <td>
                <Input type="number" value={h.weights[k]} onChange={(v) => set({ weights: { ...h.weights, [k]: Number(v) } })} aria-label={t('Gewicht {signal}', { signal: l })} />
              </td>
              <td className="muted">{Math.round((Number(h.weights[k] || 0) / total) * 100)} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('Jedes Signal ergibt 0–100 Punkte (z. B. 0 offene Tickets = 100, je Ticket −25; CSAT 5 = 100, 1 = 0). Signale ohne Daten (noch kein NPS, keine E-Mails) zählen nicht mit.')}</p>
      <div className="grid3">
        <Field label={t('Grün ab')}>
          <Input type="number" value={h.green} onChange={(v) => set({ green: Number(v) })} />
        </Field>
        <Field label={t('Gelb ab (darunter rot)')}>
          <Input type="number" value={h.yellow} onChange={(v) => set({ yellow: Number(v) })} />
        </Field>
        <Field label={t('„Gesunken“ ab Abfall um')}>
          <Input type="number" value={h.drop_points} onChange={(v) => set({ drop_points: Number(v) })} />
        </Field>
      </div>
      <Field label={t('Aktivität: 0 Punkte nach … Tagen ohne Aktivität')}>
        <Input type="number" value={h.activity_days} onChange={(v) => set({ activity_days: Number(v) })} />
      </Field>
      </MoreFields>
      <div className="actions">
        <button className="btn" onClick={() => save()}>
          {t('Speichern')}
        </button>
        <button className="btn secondary" onClick={async () => {
          const r = await act(() => api.post('/api/health/recompute'));
          if (r) toast(t.plural(r.count, { other: '{n} Kontakte neu berechnet' }));
        }}>
          {t('Jetzt alle neu berechnen')}
        </button>
      </div>
    </div>
  );
}

// --- workflow step & trigger editors, form setting --------------------------------------------------

export function TicketStep({ step, set }: { step: any; set: (p: any) => void }) {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const m = meta.data;
  if (!m) return <Spinner />;
  const stages = m.pipelines.flatMap((p: any) => p.stages.map((s: any) => [s.id, m.pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name]));
  if (step.type === 'ticket_create')
    return (
      <>
        <Field label={t('Betreff')}>
          <Input value={step.subject} onChange={(v) => set({ subject: v })} placeholder={t('Rückfrage von {{contact.name}}')} />
        </Field>
        <Field label={t('Beschreibung')}>
          <Textarea value={step.description} onChange={(v) => set({ description: v })} />
        </Field>
        <div className="grid2">
          <Field label={t('Priorität')}>
            <Select value={step.priority ?? 'normal'} onChange={(v) => set({ priority: v })} options={m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
          </Field>
          <Field label={t('Kategorie')}>
            <Select value={step.category} onChange={(v) => set({ category: v })} placeholder="–" options={m.categories} />
          </Field>
          <Field label="Team">
            <Select value={step.team_id} onChange={(v) => set({ team_id: v })} placeholder={t('nach Regeln')} options={m.teams.map((tk: any) => [tk.id, tk.name])} />
          </Field>
          <Field label={t('Zuständig')}>
            <Select value={step.owner_id} onChange={(v) => set({ owner_id: v })} placeholder={t('nach Regeln')} options={m.agents.map((a: any) => [a.id, a.name])} />
          </Field>
        </div>
      </>
    );
  return (
    <>
      <p className="muted small">{t('Ändert das Ticket aus dem Auslöser (sonst das neueste offene Ticket des Kontakts).')}</p>
      <div className="grid2">
        <Field label="Status">
          <Select value={step.status} onChange={(v) => set({ status: v })} placeholder={t('unverändert')} options={stages} />
        </Field>
        <Field label={t('Priorität')}>
          <Select value={step.priority} onChange={(v) => set({ priority: v })} placeholder={t('unverändert')} options={[['raise', t('↑ eine Stufe höher')], ...m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])]} />
        </Field>
        <Field label="Team">
          <Select value={step.team_id} onChange={(v) => set({ team_id: v })} placeholder={t('unverändert')} options={[['__none', t('– kein Team –')], ...m.teams.map((tk: any) => [tk.id, tk.name])]} />
        </Field>
        <Field label={t('Zuständig')}>
          <Select value={step.owner_id} onChange={(v) => set({ owner_id: v })} placeholder={t('unverändert')} options={[['round_robin', t('↻ Nächste/r im Team')], ['__none', t('– niemand –')], ...m.agents.map((a: any) => [a.id, a.name])]} />
        </Field>
      </div>
      <Field label={t('Interne Notiz')}>
        <Textarea value={step.note} onChange={(v) => set({ note: v })} placeholder={t('z. B. Automatisch eskaliert')} />
      </Field>
      <Check checked={!!step.notify_owner} onChange={(v) => set({ notify_owner: v })} label={t('Zuständige/n per E-Mail und Push benachrichtigen')} />
    </>
  );
}

export function TicketTriggerFilter({ type, config, set }: { type: string; config: any; set: (p: any) => void }) {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const m = meta.data;
  if (type === 'health_score.dropped')
    return (
      <Field label={t('Nur wenn jetzt')}>
        <Select value={config.band} onChange={(v) => set({ band: v })} placeholder={t('jede Farbe')} options={[['yellow', t('gelb')], ['red', t('rot')]]} />
      </Field>
    );
  if (!m) return null;
  const pipe = m.pipelines.find((p: any) => p.id === config.pipeline_id) ?? (m.pipelines.length === 1 ? m.pipelines[0] : null);
  return (
    <>
      <div className="grid2">
        <Field label={t('Priorität')}>
          <Select value={config.priority} onChange={(v) => set({ priority: v })} placeholder={t('jede')} options={m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
        </Field>
        <Field label={t('Kategorie')}>
          <Select value={config.category} onChange={(v) => set({ category: v })} placeholder={t('jede')} options={m.categories} />
        </Field>
        {m.pipelines.length > 1 && (
          <Field label="Pipeline">
            <Select value={config.pipeline_id} onChange={(v) => set({ pipeline_id: v, stage_id: '' })} placeholder={t('jede')} options={m.pipelines.map((p: any) => [p.id, p.name])} />
          </Field>
        )}
        {type === 'ticket.status_changed' && pipe && (
          <Field label={t('Neuer Status')}>
            <Select value={config.stage_id} onChange={(v) => set({ stage_id: v })} placeholder={t('jeder')} options={pipe.stages.map((s: any) => [s.id, s.name])} />
          </Field>
        )}
        {type === 'ticket.assigned' && (
          <Field label={t('Zugewiesen an')}>
            <Select value={config.owner_id} onChange={(v) => set({ owner_id: v })} placeholder="jede/n" options={m.agents.map((a: any) => [a.id, a.name])} />
          </Field>
        )}
        {type.startsWith('sla.') && (
          <Field label={t('Zeit')}>
            <Select value={config.sla_kind} onChange={(v) => set({ sla_kind: v })} placeholder={t('erste Antwort oder Lösung')} options={[['first_response', t('Erste Antwort')], ['resolution', t('Lösung')]]} />
          </Field>
        )}
      </div>
      <p className="muted small">{t('Tipp: unter Einstellungen „Kontakt darf mehrmals hinein“ anhaken, damit jedes Ticket den Workflow startet.')}</p>
    </>
  );
}

/** Forms → Einstellungen: "als Ticket anlegen". */
export function FormTicketSetting({ s, setS }: { s: any; setS: (p: any) => void }) {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  return (
    <div className="form-ticket">
      <Check checked={!!s.create_ticket} onChange={(v) => setS({ create_ticket: v })} label={t('Jede Einsendung als Ticket anlegen (Service)')} />
      {s.create_ticket && meta.data && (
        <div className="grid3">
          <Field label={t('Priorität')}>
            <Select value={s.ticket_priority ?? 'normal'} onChange={(v) => setS({ ticket_priority: v })} options={meta.data.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
          </Field>
          <Field label={t('Kategorie')}>
            <Select value={s.ticket_category} onChange={(v) => setS({ ticket_category: v })} placeholder="–" options={meta.data.categories} />
          </Field>
          <Field label="Team">
            <Select value={s.ticket_team_id} onChange={(v) => setS({ ticket_team_id: v })} placeholder={t('nach Regeln')} options={meta.data.teams.map((tk: any) => [tk.id, tk.name])} />
          </Field>
        </div>
      )}
      {s.create_ticket && <p className="muted small">{t('Ein Feld „Betreff“ (oder „Anliegen“) wird zum Ticket-Betreff, alle Antworten zur Beschreibung. Das Formular braucht ein E-Mail- oder Telefon-Feld.')}</p>}
    </div>
  );
}
