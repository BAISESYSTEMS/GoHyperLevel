import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Badge, Select, Spinner, act, useLoad } from '../ui';

/**
 * Einstellungen → KI-Anbieter → Denkstufe: how hard the models think. One default ("Denkstufe (Standard)",
 * built in: maximal / xhigh) and an optional level per capability; the Werkstatt and its reviews never go below
 * "hoch". A level a model cannot take is lowered to its highest one and says so in the build log.
 */

export function AiEffort({ agency = false }: { agency?: boolean }) {
  const session = useSession();
  const admin = session.user.role === 'admin';
  const [scope, setScope] = useState<'location' | 'agency'>(agency ? 'agency' : 'location');
  const data = useLoad(() => api.get('/api/ai-effort'), []);
  if (!data.data) return <Spinner />;
  const d = data.data;
  const own = scope === 'agency' ? d.agency : d.own;
  const save = async (body: Record<string, unknown>) => {
    if (await act(() => api.put('/api/ai-effort', { scope, ...body }), 'Gespeichert')) void data.reload();
  };
  const levels: [string, string][] = d.efforts.map((e: any) => [e.id, e.label]);
  const eff = (id: string) => levels.find(([k]) => k === id)?.[1] ?? id;
  return (
    <div className="card" data-tour="aic-effort">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Denkstufe</h2>
        {admin && !agency && (
          <div style={{ minWidth: 200 }}>
            <Select value={scope} onChange={(v) => setScope(v as any)} options={[['location', 'Dieser Sub-Account'], ['agency', 'Agentur-Standard']]} />
          </div>
        )}
      </div>
      <p className="muted small">Wie gründlich die Modelle nachdenken. {d.note} Kann ein Modell die Stufe nicht, nimmt es seine höchste unterstützte – das steht dann im Protokoll („xhigh → high, vom Modell nicht unterstützt“).</p>
      <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <label htmlFor="effort-default" style={{ minWidth: 190 }}>
          <strong>Denkstufe (Standard)</strong>
        </label>
        <span id="effort-default">
          <Select value={own.default ?? ''} onChange={(v) => void save({ default: v })} options={[['', `Vorgabe: ${eff(scope === 'location' && d.agency.default ? d.agency.default : d.builtin_default)}`], ...levels]} />
        </span>
      </div>
      <table className="aic-routing">
        <thead>
          <tr>
            <th>Bereich</th>
            <th>Denkstufe</th>
            <th>Aktuell</th>
          </tr>
        </thead>
        <tbody>
          {d.caps.map((c: any) => {
            const value = (scope === 'agency' ? c.agency : c.own) ?? '';
            return (
              <tr key={c.id}>
                <td>
                  {c.label} {c.strict && <Badge>mind. hoch</Badge>}
                </td>
                <td>
                  <Select value={value} onChange={(v) => void save({ caps: { [c.id]: v } })} options={[['', 'Wie Standard'], ...levels.filter(([k]) => !c.strict || k === 'high' || k === 'xhigh')]} />
                </td>
                <td className="small">
                  {eff(c.effective)} <span className="muted">· {c.source === 'location' ? 'Sub-Account' : c.source === 'agency' ? 'Agentur' : 'Vorgabe'}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
