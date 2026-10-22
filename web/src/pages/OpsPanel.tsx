import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { act, Badge, Check, CodeBox, confirmAsk, Empty, Field, Input, Modal, Select, Spinner, Textarea, useLoad } from '../ui';

/**
 * Agentur → System, below the server metrics: operations – the health checks behind /healthz, the off-site backup with its
 * restore test, alerts and the public status page with its incidents (docs/backups.md). Plugged in through the slot
 * `agency.system` (web/src/slots.tsx).
 */

type Status = 'ok' | 'warn' | 'fail' | 'off';
interface CheckRow {
  status: Status;
  detail: string;
}
interface Run {
  id: string;
  kind: 'backup' | 'restore_test';
  status: 'running' | 'ok' | 'failed';
  started_at: string;
  finished_at: string | null;
  stamp: string;
  bytes: number;
  files_uploaded: number;
  error: string;
  detail: Record<string, any>;
}
interface Incident {
  id: string;
  title: string;
  impact: string;
  components: string[];
  status: string;
  started_at: string;
  resolved_at: string | null;
  updates: { status: string; body: string; at: string }[];
}

const TONE: Record<string, 'green' | 'yellow' | 'red' | 'gray' | 'blue'> = { ok: 'green', warn: 'yellow', fail: 'red', off: 'gray', running: 'blue', failed: 'red', firing: 'red', resolved: 'green', event: 'blue' };
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
const pct = (v: number | null) => (v === null ? '–' : `${(Math.floor(v * 10000) / 100).toFixed(2).replace('.', ',')} %`);

function useStatusLabels() {
  const t = useT('ops');
  return {
    check: { ok: t('in Ordnung'), warn: t('Warnung'), fail: t('Fehler'), off: t('aus') } as Record<string, string>,
    run: { running: t('läuft'), ok: t('erfolgreich'), failed: t('fehlgeschlagen') } as Record<string, string>,
    impact: { minor: t('Eingeschränkt'), major: t('Störung'), maintenance: t('Wartung') } as Record<string, string>,
    incident: { investigating: t('Wird untersucht'), identified: t('Ursache gefunden'), monitoring: t('Wird beobachtet'), resolved: t('Behoben') } as Record<string, string>,
    current: { ok: t('In Betrieb'), degraded: t('Eingeschränkt'), outage: t('Störung'), maintenance: t('Wartung'), unknown: t('Keine Daten') } as Record<string, string>,
    alert: { firing: t('aktiv'), resolved: t('behoben'), event: t('Meldung') } as Record<string, string>,
  };
}

function Health() {
  const t = useT('ops');
  const L = useStatusLabels();
  const o = useLoad(() => api.get('/api/admin/ops'), []);
  if (!o.data) return o.error ? <Empty>{o.error}</Empty> : <Spinner />;
  const d = o.data;
  const names: Record<string, string> = { db: t('Datenbank'), disk: t('Speicherplatz'), tick: t('Hintergrund-Aufgaben'), backup: t('Backup') };
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }} data-tour="ops-health">
      <h3 style={{ marginTop: 0 }}>{t('Gesundheit und Alarme')}</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {Object.entries(d.health.checks as Record<string, CheckRow>).map(([k, c]) => (
          <span key={k} title={c.detail}>
            <Badge tone={TONE[c.status]}>
              {names[k] ?? k}: {L.check[c.status]}
            </Badge>{' '}
            <span className="muted small">{c.detail}</span>
          </span>
        ))}
      </div>
      <p className="muted small" style={{ marginBottom: 4 }}>
        {t('Adresse für externe Überwachung (UptimeRobot, Better Stack, Uptime Kuma) – antwortet 503, sobald eine Prüfung fehlschlägt:')}
      </p>
      <CodeBox text={d.healthz} />
      <p className="small" style={{ marginTop: 12 }}>
        <strong>{t('Alarme gehen an:')}</strong> {d.channels.email.length ? d.channels.email.join(', ') : t('keine E-Mail-Empfänger')} ·{' '}
        {d.channels.push < 0 ? t('Push aus') : t('Push an {n} Admin-Geräte', { n: d.channels.push })} · {d.channels.webhook ? t('Webhook {host}', { host: d.channels.webhook }) : t('kein Webhook')}
      </p>
      <button className="btn small secondary" onClick={() => act(() => api.post('/api/admin/ops/test-alert'), t('Test-Alarm gesendet')).then(() => o.reload())}>
        {t('Test-Alarm senden')}
      </button>
      <h4>{t('Letzte Alarme')}</h4>
      {!d.recent.length ? (
        <Empty>{t('Noch keine Alarme.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <tbody>
              {d.recent.slice(0, 10).map((a: any) => (
                <tr key={a.id}>
                  <td>{dt(a.first_at)}</td>
                  <td>
                    <Badge tone={TONE[a.status]}>{L.alert[a.status] ?? a.status}</Badge>
                  </td>
                  <td>
                    <strong>{a.title}</strong>
                    <div className="muted small">{a.body}</div>
                  </td>
                  <td className="muted small">{a.sent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Backups() {
  const t = useT('ops');
  const L = useStatusLabels();
  const o = useLoad(() => api.get('/api/admin/offsite-backup'), []);
  useEffect(() => {
    if (!o.data?.running) return;
    const id = setInterval(() => void o.reload(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.data?.running]);
  if (!o.data) return o.error ? <Empty>{o.error}</Empty> : <Spinner />;
  const d = o.data;
  const start = (path: string, ok: string) => act(() => api.post(path), ok).then(() => o.reload());
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }} data-tour="ops-backup">
      <h3 style={{ marginTop: 0 }}>{t('Off-site-Backup')}</h3>
      {!d.configured ? (
        <>
          <p>{d.error || t('Noch nicht eingerichtet. Ohne Off-site-Backup liegen alle Sicherungen auf derselben Platte wie die App.')}</p>
          {d.missing.length > 0 && (
            <p className="muted small">
              {t('Fehlende Umgebungsvariablen:')} <code>{d.missing.join(', ')}</code>
            </p>
          )}
          <p className="muted small">{t('Anleitung: docs/backups.md (S3-kompatibler Speicher wie Hetzner, Backblaze, Hostinger oder MinIO, Schlüssel mit openssl rand -hex 32).')}</p>
        </>
      ) : (
        <>
          <p className="small">
            {t('Ziel:')} <code>{`${d.target.endpoint}/${d.target.bucket}/${d.target.prefix}`}</code> · {t('alle {n} Minuten', { n: d.interval_min })} · {t('behält {h} stündliche, {d} tägliche, {m} monatliche', { h: d.retention.hourly, d: d.retention.daily, m: d.retention.monthly })} ·{' '}
            {d.files ? t('mit Upload-Ordnern ({n} Dateien)', { n: d.files_tracked }) : t('nur Datenbank')} · {t('Schlüssel-ID {id}', { id: d.key_id })}
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 16, marginBottom: 10 }}>
            <div>
              <div className="muted small">{t('Letzte erfolgreiche Sicherung')}</div>
              <strong>{d.last_ok ? dt(d.last_ok.started_at) : t('noch keine')}</strong>
              {d.last_ok && <div className="muted small">{mb(d.last_ok.detail.db_bytes ?? d.last_ok.bytes)}</div>}
            </div>
            <div>
              <div className="muted small">{t('Letzter Restore-Test')}</div>
              <strong>{d.last_restore_test ? dt(d.last_restore_test.started_at) : t('noch keiner')}</strong>{' '}
              {d.last_restore_test && <Badge tone={TONE[d.last_restore_test.status]}>{L.run[d.last_restore_test.status]}</Badge>}
              {d.last_restore_test?.error && <div className="muted small">{d.last_restore_test.error}</div>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" disabled={d.running} onClick={() => start('/api/admin/offsite-backup/run', t('Sicherung gestartet'))}>
              {d.running ? t('Läuft …') : t('Jetzt sichern')}
            </button>
            <button className="btn small secondary" disabled={d.running} onClick={() => start('/api/admin/offsite-backup/restore-test', t('Restore-Test gestartet'))}>
              {t('Restore-Test starten')}
            </button>
          </div>
        </>
      )}
      {d.runs.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t('Start')}</th>
                <th>{t('Art')}</th>
                <th>{t('Ergebnis')}</th>
                <th>{t('Details')}</th>
              </tr>
            </thead>
            <tbody>
              {d.runs.slice(0, 10).map((r: Run) => (
                <tr key={r.id}>
                  <td>{dt(r.started_at)}</td>
                  <td>{r.kind === 'backup' ? t('Sicherung') : t('Restore-Test')}</td>
                  <td>
                    <Badge tone={TONE[r.status]}>{L.run[r.status]}</Badge>
                  </td>
                  <td className="small">
                    {r.error ||
                      (r.kind === 'backup'
                        ? t('{size}, {n} neue Dateien', { size: mb(r.bytes), n: r.files_uploaded })
                        : r.status === 'ok'
                          ? t('integrity_check ok, {n} Dateien geprüft', { n: r.detail.files_checked ?? 0 })
                          : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IncidentModal({ incident, components, onClose, onSaved }: { incident?: Incident; components: { key: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('ops');
  const L = useStatusLabels();
  const [f, setF] = useState({ title: incident?.title ?? '', impact: incident?.impact ?? 'minor', status: incident?.status ?? 'investigating', components: incident?.components ?? [], message: '' });
  const save = async () => {
    const r = await act(() => (incident ? api.patch(`/api/admin/status-page/incidents/${incident.id}`, f) : api.post('/api/admin/status-page/incidents', f)), incident ? t('Vorfall aktualisiert') : t('Vorfall veröffentlicht'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={incident ? t('Vorfall aktualisieren') : t('Vorfall melden')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={save}>
          {incident ? t('Aktualisieren') : t('Veröffentlichen')}
        </button>
      }
    >
      <Field label={t('Titel')}>
        <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} maxLength={160} placeholder={t('z. B. E-Mail-Versand verzögert')} />
      </Field>
      <div className="grid2">
        <Field label={t('Auswirkung')}>
          <Select value={f.impact} onChange={(v) => setF({ ...f, impact: v })} options={Object.entries(L.impact)} />
        </Field>
        <Field label={t('Status')}>
          <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={Object.entries(L.incident)} />
        </Field>
      </div>
      <Field label={t('Betroffene Bereiche')}>
        <div>
          {components.map((c) => (
            <Check key={c.key} checked={f.components.includes(c.key)} onChange={(on) => setF({ ...f, components: on ? [...f.components, c.key] : f.components.filter((k) => k !== c.key) })} label={c.name} />
          ))}
        </div>
      </Field>
      <Field label={incident ? t('Neue Meldung (optional)') : t('Was ist los?')} hint={t('Erscheint öffentlich auf der Statusseite.')}>
        <Textarea value={f.message} onChange={(v) => setF({ ...f, message: v })} rows={4} maxLength={4000} />
      </Field>
    </Modal>
  );
}

function StatusPage() {
  const t = useT('ops');
  const L = useStatusLabels();
  const o = useLoad(() => api.get('/api/admin/status-page'), []);
  const [edit, setEdit] = useState<Incident | 'new' | null>(null);
  if (!o.data) return o.error ? <Empty>{o.error}</Empty> : <Spinner />;
  const d = o.data;
  const all: Incident[] = [...d.open, ...d.past];
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }} data-tour="ops-status">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('Statusseite')}</h3>
        <button className="btn small" onClick={() => setEdit('new')}>
          {t('Vorfall melden')}
        </button>
      </div>
      <p className="small">
        {d.enabled ? (
          <>
            {t('Öffentlich unter')}{' '}
            <a href={d.url} target="_blank" rel="noopener">
              {d.url}
            </a>
          </>
        ) : (
          t('Aus – einschalten mit PGHL_STATUS_PAGE=1 (im Cloud-Modus automatisch an). Vorfälle kannst du trotzdem schon pflegen.')
        )}
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {d.components.map((c: any) => (
          <Badge key={c.key} tone={c.current === 'ok' ? 'green' : c.current === 'unknown' ? 'gray' : c.current === 'maintenance' ? 'blue' : c.current === 'degraded' ? 'yellow' : 'red'}>
            {c.name}: {L.current[c.current]} · {t('{p} in 90 Tagen', { p: pct(c.total) })}
          </Badge>
        ))}
      </div>
      {!all.length ? (
        <Empty>{t('Keine Vorfälle in den letzten 90 Tagen.')}</Empty>
      ) : (
        all.map((i) => (
          <div key={i.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <strong>{i.title}</strong> <Badge tone={i.impact === 'major' ? 'red' : i.impact === 'maintenance' ? 'blue' : 'yellow'}>{L.impact[i.impact]}</Badge> <Badge tone={i.status === 'resolved' ? 'green' : 'gray'}>{L.incident[i.status]}</Badge>
                <div className="muted small">
                  {dt(i.started_at)}
                  {i.resolved_at ? ` – ${dt(i.resolved_at)}` : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn small secondary" onClick={() => setEdit(i)}>
                  {t('Aktualisieren')}
                </button>
                <button
                  className="btn small secondary"
                  onClick={() => confirmAsk(t('Vorfall „{title}“ löschen? Er verschwindet von der Statusseite.', { title: i.title })) && act(() => api.del(`/api/admin/status-page/incidents/${i.id}`), t('Gelöscht')).then(() => o.reload())}
                >
                  {t('Löschen')}
                </button>
              </div>
            </div>
            {i.updates[0] && <p className="small" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{i.updates[0].body}</p>}
          </div>
        ))
      )}
      {edit && (
        <IncidentModal
          incident={edit === 'new' ? undefined : edit}
          components={d.components}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void o.reload();
          }}
        />
      )}
    </div>
  );
}

export function OpsPanel() {
  const t = useT('ops');
  return (
    <section style={{ marginTop: 24 }} data-tour="ops-panel">
      <h2>{t('Betrieb')}</h2>
      <Health />
      <Backups />
      <StatusPage />
    </section>
  );
}
