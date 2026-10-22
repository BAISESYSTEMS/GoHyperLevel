import { useState, type ReactNode } from 'react';
import { Badge, Check, Modal } from '../ui';
import { CATEGORIES, SCOPES } from '../../../server/services/werkstatt/manifest';

/** Permissions (scopes) of plugins: the table the server checks against, the consent list and the consent dialog. Loaded with the pages that need it. */

/** Labels and risk of permission keys (the same table the server checks against). */
export const scopeInfos = (keys: string[]): ScopeInfo[] => keys.map((k) => ({ key: k, label: SCOPES[k]?.label ?? k, hint: SCOPES[k]?.hint ?? '', risk: SCOPES[k]?.risk ?? 'medium', write: !!SCOPES[k]?.write }));
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES);

export const RISK: Record<string, { label: string; tone: 'green' | 'yellow' | 'red' }> = { low: { label: 'niedrig', tone: 'green' }, medium: { label: 'mittel', tone: 'yellow' }, high: { label: 'hoch', tone: 'red' } };

export interface ScopeInfo {
  key: string;
  label: string;
  hint: string;
  risk: 'low' | 'medium' | 'high';
  write: boolean;
}

/** The consent list: what the plugin may do, with the risk of each permission. */
export function ScopeList({ scopes }: { scopes: ScopeInfo[] }) {
  if (!scopes.length) return <p className="muted">Das Plugin fragt keine Berechtigungen an – es kann keine Daten lesen oder ändern.</p>;
  return (
    <ul className="wk-scopes" data-tour="wk-scopes">
      {scopes.map((s) => (
        <li key={s.key}>
          <span>
            <strong>{s.label}</strong>
            <br />
            <span className="muted small">{s.hint}</span>
          </span>
          <Badge tone={RISK[s.risk]?.tone ?? 'gray'}>{s.write ? 'ändert · ' : 'liest · '}Risiko {RISK[s.risk]?.label ?? s.risk}</Badge>
        </li>
      ))}
    </ul>
  );
}


/**
 * The consent screen for every install, import and update: what the plugin may do, with the risk of each permission.
 * The server only accepts the install when the consent equals exactly this list.
 */
export function ConsentModal({ title, intro, scopes, confirm, busy, onConfirm, onClose, children }: { title: string; intro?: ReactNode; scopes: ScopeInfo[]; confirm: string; busy?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode }) {
  const [ok, setOk] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" data-tour="wk-consent-ok" disabled={!ok || busy} onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      {intro && <p>{intro}</p>}
      <h4>Das Plugin darf</h4>
      <ScopeList scopes={scopes} />
      <p className="muted small">
        Alles läuft mit deinen eigenen Rechten und nur in diesem Sub-Account. Ein Plugin kann nichts versenden, löschen oder bezahlen, und es sieht nie deine Anmeldung.
      </p>
      {children}
      <Check checked={ok} onChange={setOk} label="Ich habe die Berechtigungen gelesen und stimme zu." />
    </Modal>
  );
}
