import { useState } from 'react';
import { api, d as dateText, money } from '../api';
import { Icon } from '../icons';
import { Badge, Check, Field, Input, Modal, Select, Spinner, Textarea, act, useLoad } from '../ui';
import { centsToEuros, eurosToCents } from './pm-format';
import './costing.css';

/**
 * Internal approval of quotes (docs/sales.md#internal-approval): the box in the quote editor (why approval is needed, request,
 * approve/reject with a comment, history), the list of open requests for approvers above the quotes, and the rule (amount,
 * discount, approving role). The server enforces it in the send itself – these screens only explain it.
 */

interface Approval {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reasons: string[];
  requested_by: string | null;
  requested_by_name: string;
  request_comment: string;
  decided_by_name: string;
  decision_comment: string;
  requested_at: string;
  decided_at: string | null;
  stale: boolean;
  may_decide?: boolean;
  quote?: { id: string; title: string; status: string; deal_name: string };
}

interface State {
  rule: { enabled: boolean; approver_label: string };
  required: boolean;
  reasons: string[];
  approved: boolean;
  may_send: boolean;
  current: Approval | null;
  history: Approval[];
  may_decide: boolean;
}

const STATUS: Record<Approval['status'], [string, 'yellow' | 'green' | 'red' | 'gray']> = {
  pending: ['Wartet auf Genehmigung', 'yellow'],
  approved: ['Genehmigt', 'green'],
  rejected: ['Abgelehnt', 'red'],
  withdrawn: ['Zurückgezogen', 'gray'],
};

/** Inline, not a second window: the panel already sits in the quote editor's window (Esc there closes the editor). */
function CommentBox({ label, button, required, onCancel, onGo }: { label: string; button: string; required?: boolean; onCancel: () => void; onGo: (comment: string) => Promise<unknown> }) {
  const [c, setC] = useState('');
  return (
    <div className="jc-lines" data-tour="quote-approval-comment">
      <Field label={required ? `${label} – Begründung` : `${label} – Kommentar (optional)`}>
        <Textarea value={c} onChange={setC} rows={3} maxLength={1000} autoFocus />
      </Field>
      <div className="row">
        <button type="button" className="btn" disabled={required && !c.trim()} onClick={async () => (await onGo(c)) && onCancel()}>
          {button}
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

/** The box in the quote editor. Nothing while the rule is off and the quote never needed approval. */
export function QuoteApprovalPanel({ quoteId, version, onChanged }: { quoteId: string; version?: unknown; onChanged?: () => void }) {
  const s = useLoad(() => api.get<State>(`/api/quote-approvals/quotes/${quoteId}`), [quoteId, version]);
  const [dialog, setDialog] = useState<'request' | 'approve' | 'reject' | null>(null);
  const st = s.data;
  if (!st || (!st.required && !st.current)) return null;
  const cur = st.current;
  const done = () => (void s.reload(), onChanged?.());
  const pendingOk = cur?.status === 'pending' && !cur.stale;
  const canRequest = st.required && !st.approved && !pendingOk;
  return (
    <div className={`jc jc-approval ${st.approved ? 'ok' : st.required ? 'need' : ''}`} data-tour="quote-approval">
      <div className="row">
        <Icon name={st.approved ? 'shieldOk' : 'shield'} size={16} />
        <b className="grow">{st.approved ? 'Intern genehmigt – kann gesendet werden' : st.required ? 'Interne Genehmigung nötig, bevor das Angebot rausgeht' : 'Interne Genehmigung'}</b>
        {cur && <Badge tone={STATUS[cur.status][1]}>{cur.stale ? 'Veraltet – Angebot geändert' : STATUS[cur.status][0]}</Badge>}
      </div>
      {st.reasons.length > 0 && (
        <ul>
          {st.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {cur && (
        <p className="small" style={{ margin: 0 }}>
          Angefragt von {cur.requested_by_name || 'API-Schlüssel'} am {dateText(cur.requested_at)}
          {cur.request_comment && <> – „{cur.request_comment}“</>}
          {cur.decided_by_name && (
            <>
              <br />
              {cur.status === 'approved' ? 'Genehmigt' : 'Abgelehnt'} von {cur.decided_by_name}
              {cur.decision_comment && <> – „{cur.decision_comment}“</>}
            </>
          )}
        </p>
      )}
      {st.required && !st.approved && (
        <p className="jc-hint" style={{ margin: 0 }}>
          Genehmigen darf: {st.rule.approver_label}. Wird das Angebot danach geändert, braucht es eine neue Genehmigung.
        </p>
      )}
      {!dialog && (
        <div className="row">
          {canRequest && (
            <button type="button" className="btn" onClick={() => setDialog('request')} data-tour="quote-approval-request">
              Genehmigung anfordern
            </button>
          )}
          {st.may_decide && (
            <>
              <button type="button" className="btn" onClick={() => setDialog('approve')} data-tour="quote-approval-approve">
                Genehmigen
              </button>
              <button type="button" className="btn danger" onClick={() => setDialog('reject')}>
                Ablehnen
              </button>
            </>
          )}
          {pendingOk && !st.may_decide && (
            <button type="button" className="btn secondary" onClick={async () => (await act(() => api.post(`/api/quote-approvals/${cur!.id}/withdraw`, {}), 'Anfrage zurückgezogen')) && done()}>
              Anfrage zurückziehen
            </button>
          )}
        </div>
      )}
      {dialog === 'request' && (
        <CommentBox
          label="Genehmigung anfordern"
          button="Anfordern"
          onCancel={() => setDialog(null)}
          onGo={async (c) =>
            (await act(
              () =>
                api.post(`/api/quote-approvals/quotes/${quoteId}/request`, {
                  comment: c,
                }),
              'Genehmigung angefordert',
            )) && done()
          }
        />
      )}
      {dialog === 'approve' && (
        <CommentBox
          label="Genehmigen"
          button="Genehmigen"
          onCancel={() => setDialog(null)}
          onGo={async (c) =>
            (await act(
              () =>
                api.post(`/api/quote-approvals/${cur!.id}/approve`, {
                  comment: c,
                }),
              'Genehmigt',
            )) && done()
          }
        />
      )}
      {dialog === 'reject' && (
        <CommentBox
          label="Ablehnen"
          button="Ablehnen"
          required
          onCancel={() => setDialog(null)}
          onGo={async (c) =>
            (await act(
              () =>
                api.post(`/api/quote-approvals/${cur!.id}/reject`, {
                  comment: c,
                }),
              'Abgelehnt',
            )) && done()
          }
        />
      )}
    </div>
  );
}

interface Settings {
  rule: {
    enabled: boolean;
    min_net_cents: number | null;
    max_discount_percent: number | null;
    approver_role: string;
    team_id: string | null;
    self_approve: boolean;
  };
  roles: { value: string; label: string }[];
  teams: { id: string; name: string }[];
  approvers: number;
  can_configure: boolean;
}

function RuleDialog({ s, onClose, onSaved }: { s: Settings; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    enabled: s.rule.enabled,
    amount: centsToEuros(s.rule.min_net_cents),
    discount: s.rule.max_discount_percent === null ? '' : String(s.rule.max_discount_percent).replace('.', ','),
    role: s.rule.approver_role,
    team: s.rule.team_id ?? '',
    self: s.rule.self_approve,
  });
  const save = async () => {
    const r = await act(
      () =>
        api.put('/api/quote-approvals/settings', {
          enabled: f.enabled,
          min_net_cents: f.amount.trim() ? eurosToCents(f.amount) : null,
          max_discount_percent: f.discount.trim() ? Number(f.discount.replace(',', '.')) : null,
          approver_role: f.role,
          team_id: f.role === 'team_lead' ? f.team || null : null,
          self_approve: f.self,
        }),
      'Regel gespeichert',
    );
    if (r) onSaved();
  };
  return (
    <Modal
      title="Interne Genehmigung von Angeboten"
      className="jc-modal"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={save} data-tour="quote-approval-rule-save">
          Speichern
        </button>
      }
    >
      <Check checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Angebote über einer Grenze brauchen eine Genehmigung" />
      <div className="grid2">
        <Field label="Netto-Summe über (€)" hint="Es zählt die teuerste Variante mit allen optionalen Positionen.">
          <Input inputMode="decimal" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder="z. B. 10000" />
        </Field>
        <Field label="Rabatt über (%)" hint="Der höchste Rabatt einer Position oder des ganzen Angebots.">
          <Input inputMode="decimal" value={f.discount} onChange={(v) => setF({ ...f, discount: v })} placeholder="z. B. 15" />
        </Field>
      </div>
      <Field label="Wer genehmigt">
        <Select value={f.role} onChange={(v) => setF({ ...f, role: v })} options={s.roles.map((r) => [r.value, r.label] as [string, string])} />
      </Field>
      {f.role === 'team_lead' && (
        <Field label="Vertriebsteam" hint="Personen mit der Rolle „Leitung“ in diesem Team genehmigen.">
          <Select value={f.team} onChange={(v) => setF({ ...f, team: v })} placeholder="Team wählen" options={s.teams.map((t) => [t.id, t.name] as [string, string])} />
        </Field>
      )}
      <Check checked={f.self} onChange={(v) => setF({ ...f, self: v })} label="Genehmigende dürfen eigene Angebote selbst genehmigen (sonst immer eine zweite Person)" />
      <p className="jc-hint">Gesendet wird ohne Genehmigung nichts – auch nicht über API-Schlüssel, MCP oder Workflows. Genehmigen geht nur angemeldet in HyperLevel.</p>
    </Modal>
  );
}

/** Above the quote list: open requests the viewer may decide, and the rule for those who may change it. */
export function QuoteApprovalInbox({ onOpen }: { onOpen: (quoteId: string) => void }) {
  const s = useLoad(() => api.get<Settings>('/api/quote-approvals/settings'), []);
  const list = useLoad(() => api.get<Approval[]>('/api/quote-approvals?status=pending'), []);
  const [rule, setRule] = useState(false);
  if (!s.data) return null;
  const mine = (list.data ?? []).filter((a) => a.may_decide);
  if (!s.data.can_configure && !mine.length && !s.data.rule.enabled) return null;
  return (
    <div className="jc jc-inbox" data-tour="quote-approval-inbox">
      <div className="sales-bar" style={{ marginBottom: 4 }}>
        <b className="grow">
          {mine.length ? `${mine.length} Angebot${mine.length === 1 ? '' : 'e'} warten auf deine Genehmigung` : s.data.rule.enabled ? 'Interne Genehmigung ist an' : 'Interne Genehmigung'}
        </b>
        {s.data.rule.enabled && (
          <span className="muted small">
            {[
              s.data.rule.min_net_cents !== null ? `ab ${money(s.data.rule.min_net_cents)} netto` : '',
              s.data.rule.max_discount_percent !== null ? `ab ${String(s.data.rule.max_discount_percent).replace('.', ',')} % Rabatt` : '',
            ]
              .filter(Boolean)
              .join(' oder ')}
          </span>
        )}
        {s.data.can_configure && (
          <button type="button" className="btn secondary" onClick={() => setRule(true)} data-tour="quote-approval-rule">
            Genehmigungsregel…
          </button>
        )}
      </div>
      {!list.data ? (
        <Spinner />
      ) : (
        mine.map((a) => (
          <div key={a.id} className="jc-inbox-item">
            <div className="grow">
              <b>{a.quote?.title}</b> <span className="muted small">Deal „{a.quote?.deal_name}“</span>
              <div className="muted small">
                {a.requested_by_name || 'API-Schlüssel'}, {dateText(a.requested_at)}: {a.reasons.join(', ')}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => a.quote && onOpen(a.quote.id)}>
              Prüfen
            </button>
          </div>
        ))
      )}
      {rule && <RuleDialog s={s.data} onClose={() => setRule(false)} onSaved={() => (setRule(false), void s.reload())} />}
    </div>
  );
}
