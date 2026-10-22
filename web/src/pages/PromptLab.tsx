import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, useLoad } from '../ui';

/**
 * KI-Agenten → Prompt-Tests (modules/prompt-lab.ts, docs/ai-assistant.md#prompt-optimizer; slot "agents.tests"): test cases for
 * an agent's instructions, a run with strict grading, an improvement proposal and applying it after review.
 */

type Case = { input: string; expect: string };

export function PromptLabPanel() {
  const t = useT('gaps');
  const data = useLoad(() => api.get<any>('/api/prompt-lab'), []);
  const [form, setForm] = useState<null | { kind: string; target_id: string; name: string; prompt: string; cases: Case[] }>(null);
  const [openId, setOpenId] = useState('');
  if (!data.data) return <Spinner />;
  const { suites, agents } = data.data;
  const kindLabel: Record<string, string> = { agent: t('KI-Agent'), voice: t('KI-Telefonagent'), custom: t('Eigener Prompt') };
  const create = async () => {
    if (!form) return;
    const r = await act(() => api.post('/api/prompt-lab', { ...form, cases: form.cases.filter((c) => c.input.trim() && c.expect.trim()) }));
    if (r) {
      setForm(null);
      data.reload();
      setOpenId(r.id);
    }
  };
  const open = suites.find((s: any) => s.id === openId);
  return (
    <div className="card" data-tour="prompt-lab">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Prompt-Tests')}</h2>
        <button className="btn small" onClick={() => setForm({ kind: agents.length ? 'agent' : 'voice', target_id: agents[0]?.id ?? '', name: '', prompt: '', cases: [{ input: '', expect: '' }] })}>
          {t('+ Test')}
        </button>
      </div>
      <p className="muted small">{t('Typische Kundenfragen mit der erwarteten Antwort: die KI beantwortet sie mit den Anweisungen deines Agenten, prüft streng und schlägt bessere Anweisungen vor.')}</p>
      {suites.length === 0 ? (
        <p className="muted small">{t('Noch keine Tests.')}</p>
      ) : (
        <table className="t">
          <tbody>
            {suites.map((s: any) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong> <span className="muted small">{kindLabel[s.kind]}{s.kind === 'agent' ? `: ${agents.find((a: any) => a.id === s.target_id)?.name ?? '?'}` : ''}</span>
                  <div className="muted small">{t.plural(s.cases.length, { one: '{n} Testfall', other: '{n} Testfälle' })}</div>
                </td>
                <td>{s.last_run ? <Badge tone={s.last_run.passed === s.last_run.total ? 'green' : s.last_run.passed ? 'yellow' : 'red'}>{t('{p} von {n} bestanden', { p: s.last_run.passed, n: s.last_run.total })}</Badge> : <span className="muted small">{t('noch nicht getestet')}</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn small secondary" onClick={() => setOpenId(s.id)}>
                    {t('Öffnen')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && (
        <Modal
          title={t('Neuer Prompt-Test')}
          onClose={() => setForm(null)}
          wide
          footer={
            <button className="btn" disabled={!form.name.trim() || !form.cases.some((c) => c.input.trim() && c.expect.trim()) || (form.kind === 'agent' && !form.target_id)} onClick={create}>
              {t('Anlegen')}
            </button>
          }
        >
          <div className="grid2">
            <Field label={t('Name')}>
              <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder={t('z. B. Preisfragen')} />
            </Field>
            <Field label={t('Was wird getestet?')}>
              <Select value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={Object.entries(kindLabel)} />
            </Field>
          </div>
          {form.kind === 'agent' && (
            <Field label={t('KI-Agent')}>
              <Select value={form.target_id} onChange={(v) => setForm({ ...form, target_id: v })} options={agents.map((a: any) => [a.id, `${a.emoji ?? ''} ${a.name}`.trim()] as [string, string])} />
            </Field>
          )}
          {form.kind === 'custom' && (
            <Field label={t('Anweisungen')}>
              <Textarea rows={4} value={form.prompt} onChange={(v) => setForm({ ...form, prompt: v })} />
            </Field>
          )}
          <CasesEditor cases={form.cases} onChange={(cases) => setForm({ ...form, cases })} />
        </Modal>
      )}
      {open && <SuiteModal suite={open} onClose={() => setOpenId('')} onChanged={data.reload} />}
    </div>
  );
}

function CasesEditor({ cases, onChange }: { cases: Case[]; onChange: (c: Case[]) => void }) {
  const t = useT('gaps');
  return (
    <>
      {cases.map((c, i) => (
        <div key={i} className="grid2">
          <Field label={t('Kundennachricht {n}', { n: i + 1 })}>
            <Textarea rows={2} value={c.input} onChange={(v) => onChange(cases.map((x, j) => (j === i ? { ...x, input: v } : x)))} placeholder={t('z. B. Was kostet ein Erstgespräch?')} />
          </Field>
          <Field label={t('Gute Antwort muss …')}>
            <Textarea rows={2} value={c.expect} onChange={(v) => onChange(cases.map((x, j) => (j === i ? { ...x, expect: v } : x)))} placeholder={t('z. B. sagen, dass es kostenlos ist')} />
          </Field>
        </div>
      ))}
      <button className="btn small secondary" disabled={cases.length >= 10} onClick={() => onChange([...cases, { input: '', expect: '' }])}>
        {t('+ Testfall')}
      </button>
    </>
  );
}

function SuiteModal({ suite, onClose, onChanged }: { suite: any; onClose: () => void; onChanged: () => void }) {
  const t = useT('gaps');
  const [busy, setBusy] = useState('');
  const [cases, setCases] = useState<Case[]>(suite.cases);
  const [proposal, setProposal] = useState<{ instructions: string; changes: string[]; unchanged?: boolean } | null>(null);
  const run = async () => {
    setBusy('run');
    await act(() => api.post(`/api/prompt-lab/${suite.id}/run`));
    setBusy('');
    onChanged();
  };
  const improve = async () => {
    setBusy('improve');
    const r = await act(() => api.post(`/api/prompt-lab/${suite.id}/improve`));
    setBusy('');
    if (r) setProposal(r);
  };
  const apply = async () => {
    if (!proposal) return;
    if ((await act(() => api.post(`/api/prompt-lab/${suite.id}/apply`, { instructions: proposal.instructions }), t('Anweisungen übernommen'))) !== undefined) {
      setProposal(null);
      onChanged();
    }
  };
  const last = suite.last_run;
  return (
    <Modal title={suite.name} onClose={onClose} wide>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn small" disabled={!!busy} onClick={run}>
          {busy === 'run' ? t('Teste …') : t('Jetzt testen')}
        </button>
        <button className="btn small secondary" disabled={!!busy || !last} onClick={improve}>
          {busy === 'improve' ? t('Denke nach …') : t('Verbesserung vorschlagen')}
        </button>
        {last && (
          <span className="small muted">
            {t('{p} von {n} bestanden', { p: last.passed, n: last.total })} · {t('Punkte {s}', { s: last.score })} · {dt(last.at)}
          </span>
        )}
      </div>
      <p className="muted small">{t('Jeder Testfall kostet zwei KI-Aufrufe.')}</p>
      {last?.results?.map((r: any, i: number) => (
        <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
          <Badge tone={r.pass ? 'green' : 'red'}>{r.pass ? t('bestanden') : t('nicht bestanden')}</Badge> <strong>{r.input}</strong> <span className="muted small">({r.score}/10)</span>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.answer}</div>
          <div className="small muted">{r.reason}</div>
        </div>
      ))}
      {proposal && (
        <div className="card" style={{ marginTop: 12 }}>
          {proposal.unchanged ? (
            <p className="small">{t('Alle Tests bestehen – nichts zu verbessern.')}</p>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>{t('Vorschlag')}</h3>
              <ul className="small">
                {proposal.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <Textarea rows={8} value={proposal.instructions} onChange={(v) => setProposal({ ...proposal, instructions: v })} aria-label={t('Neue Anweisungen')} />
              <button className="btn small" style={{ marginTop: 8 }} onClick={apply}>
                {t('Übernehmen')}
              </button>
            </>
          )}
        </div>
      )}
      <MoreFields id="prompt-lab-cases" label={t('Testfälle bearbeiten')}>
        <CasesEditor cases={cases} onChange={setCases} />
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn small" onClick={async () => (await act(() => api.patch(`/api/prompt-lab/${suite.id}`, { cases }), t('Gespeichert'))) && onChanged()}>
            {t('Testfälle speichern')}
          </button>
          <button className="btn small secondary" onClick={async () => confirmAsk(t('Test „{n}“ löschen?', { n: suite.name })) && (await act(() => api.del(`/api/prompt-lab/${suite.id}`))) && (onClose(), onChanged())}>
            {t('Test löschen')}
          </button>
        </div>
      </MoreFields>
    </Modal>
  );
}
