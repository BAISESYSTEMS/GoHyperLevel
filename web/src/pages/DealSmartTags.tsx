import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { act, confirmAsk, Input, Modal, Select, useLoad } from '../ui';
import { chipStyle } from '../tag-chip';
import { ColorPick, PALETTE } from '../color-pick';
import './crm-gaps.css';

/**
 * Smart Tags on deal cards (modules/deal-smart-tags.ts): the chips a card shows (one board request per pipeline, shared by all
 * cards through a small store) and the rule editor behind the "Smart Tags" button of the board.
 */

type Chip = { id: string; name: string; color: string };
const boards = new Map<string, { map: Record<string, Chip[]>; loaded: boolean; subs: Set<() => void> }>();
const entry = (pid: string) => {
  let e = boards.get(pid);
  if (!e) boards.set(pid, (e = { map: {}, loaded: false, subs: new Set() }));
  return e;
};
async function load(pid: string) {
  const e = entry(pid);
  e.map = await api.get<Record<string, Chip[]>>(`/api/deal-smart-tags/board?pipeline_id=${encodeURIComponent(pid)}`).catch(() => e.map);
  e.loaded = true;
  e.subs.forEach((f) => f());
}
/** Reload every board's chips (after editing the rules or moving a deal). */
export const refreshSmartTags = () => Promise.all([...boards.keys()].map(load));

export function DealSmartChips({ dealId, pipelineId }: { dealId: string; pipelineId: string }) {
  const e = entry(pipelineId);
  const map = useSyncExternalStore(
    (f) => (e.subs.add(f), () => void e.subs.delete(f)),
    () => e.map,
  );
  useEffect(() => {
    if (!e.loaded) {
      e.loaded = true;
      void load(pipelineId);
    }
  }, [pipelineId]);
  const chips = map[dealId];
  if (!chips?.length) return null;
  return (
    <div className="deal-tags">
      {chips.map((c) => (
        <span key={c.id} className={`tag${c.color ? ' tc' : ''}`} style={chipStyle(c.color)}>
          {c.name}
        </span>
      ))}
    </div>
  );
}

const KIND_LABELS: [string, string][] = [
  ['value_min', 'Wert ab'],
  ['overdue', 'Abschlussdatum überschritten'],
  ['no_close_date', 'Ohne Abschlussdatum'],
  ['no_owner', 'Ohne Zuständigen'],
  ['stage_days', 'Länger in einer Stufe als (Tage)'],
  ['stale_days', 'Keine Aktivität seit (Tagen)'],
];
const NEEDS_VALUE = ['value_min', 'stage_days', 'stale_days'];

export function SmartTagsButton() {
  const t = useT('crmgaps');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn secondary" data-tour="opps-smart-tags" onClick={() => setOpen(true)}>
        {t('Smart Tags')}
      </button>
      {open && <SmartTagsModal onClose={() => (setOpen(false), void refreshSmartTags())} />}
    </>
  );
}

function SmartTagsModal({ onClose }: { onClose: () => void }) {
  const t = useT('crmgaps');
  const rules = useLoad(() => api.get<{ id: string; name: string; color: string; rule: { kind: string; value?: number } }[]>('/api/deal-smart-tags'), []);
  const [draft, setDraft] = useState({ name: '', kind: 'stale_days', value: '14', color: PALETTE[0] });
  const list = rules.data ?? [];
  const label = (k: string) => t(KIND_LABELS.find(([x]) => x === k)?.[1] ?? k);
  const add = async () => {
    const r = await act(() => api.post('/api/deal-smart-tags', { name: draft.name, color: draft.color, rule: { kind: draft.kind, value: NEEDS_VALUE.includes(draft.kind) ? Number(draft.value) : undefined } }));
    if (r) (setDraft({ ...draft, name: '' }), rules.reload());
  };
  return (
    <Modal title={t('Smart Tags auf Deal-Karten')} onClose={onClose}>
      <p className="muted small">{t('Regeln färben offene Deals mit einem Chip – z. B. „Verrottet“ ohne Aktivität seit 14 Tagen.')}</p>
      {list.map((r) => (
        <div key={r.id} className="tag-meta-row">
          <span className={`tag${r.color ? ' tc' : ''}`} style={chipStyle(r.color)}>
            {r.name}
          </span>
          <span className="tm-tools muted small">
            {label(r.rule.kind)}
            {r.rule.value !== undefined ? ` ${r.rule.value}` : ''}
            <ColorPick value={r.color} label={r.name} onChange={(color) => act(() => api.patch(`/api/deal-smart-tags/${r.id}`, { color })).then(rules.reload)} />
            <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: r.name })} onClick={() => confirmAsk(t('Smart Tag „{name}“ löschen?', { name: r.name })) && act(() => api.del(`/api/deal-smart-tags/${r.id}`)).then(rules.reload)}>
              ✕
            </button>
          </span>
        </div>
      ))}
      {!list.length && <p className="muted small">{t('Noch keine Smart Tags.')}</p>}
      <div className="tag-bulk-bar">
        <div style={{ width: 150 }}>
          <Input value={draft.name} onChange={(name) => setDraft({ ...draft, name })} placeholder={t('Name, z. B. Verrottet')} aria-label={t('Name des Smart Tags')} maxLength={40} />
        </div>
        <div style={{ width: 230 }}>
          <Select value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} aria={t('Regel')} options={KIND_LABELS.map(([k, l]) => [k, t(l)] as [string, string])} />
        </div>
        {NEEDS_VALUE.includes(draft.kind) && (
          <div style={{ width: 90 }}>
            <Input type="number" min={draft.kind === 'value_min' ? 0 : 1} value={draft.value} onChange={(value) => setDraft({ ...draft, value })} aria-label={draft.kind === 'value_min' ? t('Mindestwert') : t('Tage')} />
          </div>
        )}
        <ColorPick value={draft.color} label={t('Neuer Smart Tag')} onChange={(color) => setDraft({ ...draft, color })} />
        <button type="button" className="btn small" disabled={!draft.name.trim() || (NEEDS_VALUE.includes(draft.kind) && !draft.value)} onClick={add}>
          {t('Hinzufügen')}
        </button>
      </div>
    </Modal>
  );
}
