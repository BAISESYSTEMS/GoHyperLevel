import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { Badge, Check, Field, Modal, Select, act, toast, useLoad } from '../ui';

/**
 * Built-in templates („Vorlagen“) on the agency's Snapshots tab: ready-made snapshots that ship with the app – the first is
 * „Software- & SaaS-Firma (HQ)“ – loaded into a sub-account in one click (server/modules/hq-template.ts,
 * docs/company-playbook.md). Names and descriptions come from the server as data and stay German.
 */

interface TemplateCard {
  id: string;
  name: string;
  description: string;
  summary: Record<string, number | boolean>;
  pipelines: { name: string; stages: string[] }[];
  forms: string[];
  workflows: string[];
  applied_at: string | null;
}

export function SnapshotTemplates() {
  const t = useT('templates');
  const session = useSession();
  const list = useLoad(() => api.get<TemplateCard[]>(`/api/snapshot-templates?location_id=${encodeURIComponent(session.locationId)}`), [session.locationId]);
  const [open, setOpen] = useState<TemplateCard | null>(null);
  const [target, setTarget] = useState(session.locationId);
  const [activate, setActivate] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!list.data?.length) return null;

  const load = async (again: boolean) => {
    if (!open) return;
    setBusy(true);
    const r = await act(() => api.post<{ created: Record<string, any>; warnings: string[] }>(`/api/snapshot-templates/${open.id}/apply`, { location_id: target, activate_workflows: activate, again }));
    setBusy(false);
    if (!r) return;
    toast(t('Geladen: {forms} Formulare, {workflows} Workflows, {articles} Hilfe-Artikel, {routines} Routinen', { forms: r.created.forms, workflows: r.created.workflows, articles: r.created.kb_articles, routines: r.created.routines }));
    if (r.warnings.length) toast(t('Nicht alles ging: {list}', { list: r.warnings.join(' · ') }));
    setOpen(null);
    list.reload();
  };

  return (
    <div className="card" style={{ marginBottom: 12 }} data-tour="snapshot-templates">
      <h3 style={{ marginTop: 0 }}>{t('Vorlagen von {brand}', { brand: session.branding.name })}</h3>
      <p className="muted small">{t('Fertige Startpakete für eine ganze Firma – mit einem Klick in einen Sub-Account geladen. Workflows kommen als Entwurf, Hilfe-Artikel als Entwurf.')}</p>
      {list.data.map((x) => (
        <div key={x.id} className="row" style={{ alignItems: 'flex-start', gap: 12, padding: '8px 0' }}>
          <div className="grow">
            <strong>{x.name}</strong> {x.applied_at && <Badge tone="green">{t('hier geladen')}</Badge>}
            <div className="muted small">{x.description}</div>
            <div className="small" style={{ marginTop: 4 }}>
              {t('{pipelines} Pipelines · {forms} Formulare · {workflows} Workflows · {templates} E-Mail-Vorlagen · {articles} Hilfe-Artikel · {dashboards} Dashboard · {routines} Routinen', {
                pipelines: Number(x.summary.pipelines),
                forms: Number(x.summary.forms),
                workflows: Number(x.summary.workflows),
                templates: Number(x.summary.templates),
                articles: Number(x.summary.kb_articles),
                dashboards: Number(x.summary.dashboards),
                routines: Number(x.summary.routines),
              })}
            </div>
          </div>
          <button className="btn small" onClick={() => (setOpen(x), setTarget(session.locationId), setActivate(false))}>
            {t('In Sub-Account laden')}
          </button>
        </div>
      ))}
      {open && (
        <Modal
          title={t('„{name}“ laden', { name: open.name })}
          onClose={() => setOpen(null)}
          wide
          footer={
            <>
              <button className="btn secondary" onClick={() => setOpen(null)}>
                {t('Abbrechen')}
              </button>
              <button className="btn" disabled={!target || busy} onClick={() => load(target === session.locationId && !!open.applied_at)}>
                {busy ? t('Lädt …') : t('Laden')}
              </button>
            </>
          }
        >
          <p className="muted">{t('Fügt alles als Kopie hinzu. Bestehendes bleibt unverändert; ein leerer Sub-Account bekommt statt der Standard-Pipeline die drei Pipelines der Vorlage.')}</p>
          <Field label={t('Ziel-Sub-Account')}>
            <Select value={target} onChange={setTarget} options={session.locations.map((l) => [l.id, l.name])} />
          </Field>
          <Check checked={activate} onChange={setActivate} label={t('Workflows gleich aktivieren (sonst als Entwurf – empfohlen, bis E-Mail-Versand und Texte geprüft sind)')} />
          {target === session.locationId && open.applied_at && <p className="small">{t('Diese Vorlage ist hier schon geladen – ein zweites Mal legt alles doppelt an.')}</p>}
          <h4>{t('Pipelines')}</h4>
          <ul className="small">
            {open.pipelines.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>: {p.stages.join(' → ')}
              </li>
            ))}
          </ul>
          <h4>{t('Formulare')}</h4>
          <p className="small">{open.forms.join(' · ')}</p>
          <h4>{t('Workflows')}</h4>
          <ul className="small">
            {open.workflows.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
