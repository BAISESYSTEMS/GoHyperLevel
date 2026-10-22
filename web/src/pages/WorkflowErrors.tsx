import { api } from '../api';
import { Check, Field, Select, act, toast, useLoad } from '../ui';
import './quickwins.css';
import { useT } from '../i18n';

/** Workflow error handling in the editor: the step option, the workflow's reaction to a failed step, and repeating stopped runs. Docs: docs/workflow-actions.md → Fehlerbehandlung. */

/** "Fehler ignorieren und weiter" on one step. */
export function ContinueOnError({ step, set }: { step: any; set: (patch: Record<string, unknown>) => void }) {
  const t = useT('workflows');
  return (
    <div data-tour="wf-step-ignore" style={{ marginTop: 10 }}>
      <Check checked={step.continue_on_error === true} onChange={(v) => set({ continue_on_error: v ? true : undefined })} label={t('Fehler ignorieren und weiter')} />
      <small className="muted">{t('Der Fehler steht nur im Protokoll, der Ablauf geht weiter.')}</small>
    </div>
  );
}

/** What the workflow does when a step fails: start another workflow, tell the team by bell (push) and/or e-mail. */
export function ErrorSettings({ w, update }: { w: any; update: (patch: Record<string, any>) => void }) {
  const t = useT('workflows');
  const list = useLoad(() => api.get<any[]>('/api/workflows').catch(() => []), []);
  const s = w.settings ?? {};
  const set = (patch: Record<string, unknown>) => update({ settings: { ...s, ...patch } });
  const others = (list.data ?? []).filter((x) => x.id !== w.id);
  const missing = s.on_error_workflow_id && !others.some((x) => x.id === s.on_error_workflow_id);
  return (
    <div className="qw-box" data-tour="wf-error-settings" style={{ marginTop: 14 }}>
      <h3>{t('Wenn ein Schritt fehlschlägt')}</h3>
      <Field label={t('Bei Fehler: anderen Workflow starten')} hint={t('Der gewählte Workflow läuft für denselben Kontakt; {{event.error.message}}, {{event.error.step}} und {{event.error.workflow}} stehen dort zur Verfügung. Er muss aktiv sein und sollte den Auslöser „Manuell“ haben.')}>
        <Select value={s.on_error_workflow_id ?? ''} onChange={(v) => set({ on_error_workflow_id: v })} placeholder={t('– keinen –')} options={[...others.map((x) => [x.id, x.status === 'active' ? x.name : t('{name} (nicht aktiv)', { name: x.name })] as [string, string]), ...(missing ? ([[s.on_error_workflow_id, t('(gelöschter Workflow)')]] as [string, string][]) : [])]} />
      </Field>
      <Check checked={!!s.error_bell} onChange={(v) => set({ error_bell: v })} label={t('Team per Glocke benachrichtigen (Push-Mitteilung mit dem fehlgeschlagenen Schritt)')} />
      <Check checked={!!s.error_email} onChange={(v) => set({ error_email: v })} label={t('Team per E-Mail benachrichtigen (an die Firmen-E-Mail, mit Schritt, Fehler und Kontakt)')} />
      <small className="muted">{t('Höchstens 10 Meldungen je Stunde; Push unter Mein Konto → „Workflow-Fehler“ einschalten.')}</small>
    </div>
  );
}

/** Repeats one stopped run from the step that failed. */
export function RetryButton({ run, onDone }: { run: { id: string; status: string }; onDone: () => void }) {
  const t = useT('workflows');
  if (run.status !== 'failed') return null;
  return (
    <button
      className="btn small secondary"
      data-tour="wf-retry"
      title={t('Setzt den Lauf beim fehlgeschlagenen Schritt fort – Schritte davor laufen nicht noch einmal')}
      onClick={async () => {
        const r = await act(() => api.post(`/api/workflow-runs/${run.id}/retry`));
        if (r) toast(r.status === 'failed' ? t('Wieder fehlgeschlagen – siehe Protokoll') : t('Lauf fortgesetzt'));
        onDone();
      }}
    >
      {t('Ab Fehler wiederholen')}
    </button>
  );
}

/** Repeats all stopped runs of the workflow. */
export function RetryAll({ workflowId, count, onDone }: { workflowId: string; count: number; onDone: () => void }) {
  const t = useT('workflows');
  if (!count) return null;
  return (
    <div className="qw-box" style={{ marginBottom: 10 }}>
      <strong>{t.plural(count, { one: '1 Lauf ist fehlgeschlagen.', other: '{n} Läufe sind fehlgeschlagen.' })}</strong>{' '}
      <button
        className="btn small"
        onClick={async () => {
          const r = await act(() => api.post(`/api/workflows/${workflowId}/retry-failed`));
          if (r) toast(r.failed_again ? t('{n} wiederholt, {failed} wieder fehlgeschlagen', { n: r.retried, failed: r.failed_again }) : t('{n} wiederholt', { n: r.retried }));
          onDone();
        }}
      >
        {t('Alle ab dem Fehler wiederholen')}
      </button>
    </div>
  );
}
