import { useState } from 'react';
import { api } from '../../api';
import { Badge, Copy, Empty, Modal, Spinner, act, useLoad } from '../../ui';
import './site.css';
import { useT } from '../../i18n';

export interface Issue {
  rule: string;
  level: 'error' | 'warning' | 'info';
  wcag: string;
  message: string;
  hint: string;
  excerpt?: string;
  block_id?: string;
  block_type?: string;
  count?: number;
  blocks?: string[];
}
interface Summary {
  errors: number;
  warnings: number;
  info: number;
  score: number;
}

const TONE = { error: 'red', warning: 'yellow', info: 'blue' } as const;
/** German labels (message ids of the sites catalog), shown through t(). */
const WORD = { error: 'Fehler', warning: 'Warnung', info: 'Hinweis' } as const;

export function ScoreBadge({ s }: { s: Summary }) {
  const t = useT('sites');
  return (
    <span className="a11y-score" title={t('Ein Punkt weniger je Hinweis – 100 heißt: Alles, was sich automatisch prüfen lässt, ist in Ordnung.')}>
      <b>{s.score}</b>/100 · {[t.plural(s.errors, { other: '{n} Fehler' }), t.plural(s.warnings, { other: '{n} Warnungen' }), t.plural(s.info, { other: '{n} Hinweise' })].join(' · ')}
    </span>
  );
}

/** Findings with what is wrong, the WCAG criterion and how to fix it. `onPick` jumps to the block (in the editor). */
export function IssueList({ issues, onPick }: { issues: Issue[]; onPick?: (blockId: string) => void }) {
  const t = useT('sites');
  if (!issues.length) return <p className="a11y-ok small">{t('Keine Auffälligkeiten.')}</p>;
  return (
    <ul className="a11y-list">
      {issues.map((i, k) => (
        <li key={k} className={`lv-${i.level}`}>
          <div className="a11y-head">
            <Badge tone={TONE[i.level]}>{t(WORD[i.level])}</Badge>
            <span className="a11y-msg">{i.message}</span>
            {i.count && i.count > 1 ? <span className="muted small">{i.count}×</span> : null}
            {/* i18n-ignore – criterion number */}
            <span className="muted small">{/^\d/.test(i.wcag) ? `WCAG ${i.wcag}` : i.wcag}</span>
          </div>
          <p className="small a11y-hint">{t('So behebst du es:')} {i.hint}</p>
          {i.excerpt && <code className="a11y-code">{i.excerpt}</code>}
          {onPick && (i.blocks?.[0] ?? i.block_id) && (
            <button className="btn small secondary" onClick={() => onPick((i.blocks?.[0] ?? i.block_id)!)}>
              {t('Zum Block springen')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Check of the draft in the editor. */
export function DraftCheck({ pageId, body, onPick }: { pageId: string; body: () => Record<string, any>; onPick(blockId: string): void }) {
  const t = useT('sites');
  const [res, setRes] = useState<{ summary: Summary; issues: Issue[] } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div data-tour="site-a11y">
      <button
        className="btn small secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await act(() => api.post(`/api/funnel-pages/${pageId}/a11y`, body()));
          setBusy(false);
          if (r) setRes(r);
        }}
      >
        {busy ? t('Prüfe …') : t('Barrierefreiheit prüfen')}
      </button>
      {res && (
        <div className="a11y-draft">
          <ScoreBadge s={res.summary} />
          <IssueList issues={res.issues} onPick={onPick} />
        </div>
      )}
    </div>
  );
}

/** The whole site: every page, the colour palette, the manual checks and the statement. */
export function A11yTab({ funnel, onOpenPage, onChanged }: { funnel: any; onOpenPage(pageId: string, blockId?: string): void; onChanged(): void }) {
  const t = useT('sites');
  const rep = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/a11y`), [funnel.id]);
  const [stmt, setStmt] = useState<any>(null);
  const r = rep.data;
  if (!r) return rep.error ? <Empty>{rep.error}</Empty> : <Spinner />;
  const draft = async (apply: boolean) => {
    const out = await act(() => api.post(`/api/funnels/${funnel.id}/a11y/statement`, { apply }), apply ? t('Seite „Barrierefreiheit“ angelegt') : undefined);
    if (!out) return;
    if (apply) {
      setStmt(null);
      rep.reload();
      onChanged();
    } else setStmt(out);
  };
  return (
    <div className="a11y" data-tour="site-a11y-tab">
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('Barrierefreiheit (BFSG)')}</h3>
          <span className="grow" />
          <button className="btn small secondary" onClick={rep.reload}>
            {t('Erneut prüfen')}
          </button>
        </div>
        <p className="muted small">
          {r.standard}. {t('Geprüft werden Alternativtexte, Kontraste, Überschriftenfolge, Formularbeschriftungen, Linktexte, Seitensprache und Sprungmarke. Automatische Tests finden etwa ein Drittel der möglichen Probleme – die Liste „Von Hand prüfen“ ergänzt sie.')}
        </p>
        <ScoreBadge s={r.summary} />
      </div>

      {r.site.issues.length > 0 && (
        <div className="card">
          <h3>{t('Ganze Website')}</h3>
          <IssueList issues={r.site.issues} />
        </div>
      )}
      {r.pages.map((p: any) => (
        <details key={p.id} className="card a11y-page" open={p.summary.errors > 0}>
          <summary>
            <b>{p.name}</b> <span className="muted small">/{p.slug}</span> <ScoreBadge s={p.summary} />
          </summary>
          <IssueList issues={p.issues} onPick={(blockId) => onOpenPage(p.id, blockId)} />
          <button className="btn small secondary" onClick={() => onOpenPage(p.id)}>
            {t('Seite bearbeiten')}
          </button>
        </details>
      ))}

      <details className="card">
        <summary>
          <b>{t('Von Hand prüfen')}</b>
        </summary>
        <ul className="a11y-manual">
          {r.manual.map((m: string, i: number) => (
            <li key={i}>
              <label className="check">
                <input type="checkbox" /> {m}
              </label>
            </li>
          ))}
        </ul>
      </details>

      <div className="card" data-tour="site-a11y-statement">
        <h3>{t('Erklärung zur Barrierefreiheit')}</h3>
        <p className="muted small">
          {t('Das BFSG gilt seit 28. Juni 2025 für Online-Handel, Buchungs- und Bezahlstrecken für Verbraucher und bestimmte Dienste. Kleinstunternehmen (unter 10 Beschäftigte und höchstens 2 Mio. € Umsatz) sind für Dienstleistungen ausgenommen. Das ist ein Entwurf aus deinen Firmendaten und den Prüfergebnissen – lass ihn bei Bedarf rechtlich prüfen.')}
        </p>
        <div className="row">
          <button className="btn" onClick={() => draft(false)}>
            {t('Entwurf ansehen')}
          </button>
          {r.statement.exists && (
            <a className="btn secondary" href={r.statement.url} target="_blank" rel="noreferrer">
              {t('Veröffentlichte Erklärung ↗')}
            </a>
          )}
        </div>
      </div>

      {stmt && (
        <Modal
          title={t('Erklärung zur Barrierefreiheit – Entwurf')}
          wide
          onClose={() => setStmt(null)}
          footer={
            <>
              <Copy text={stmt.markdown} label={t('Als Markdown kopieren')} />
              <button className="btn" onClick={() => draft(true)}>
                {r.statement.exists ? t('Veröffentlichte Seite ersetzen') : t('Als Seite „Barrierefreiheit“ anlegen')}
              </button>
            </>
          }
        >
          {stmt.missing?.length > 0 && (
            <p className="warn small">
              {t('Es fehlen noch Angaben:')} {stmt.missing.join(', ')}. {t('Trage sie unter „Einwilligung & Recht“ ein und erzeuge den Entwurf neu.')}
            </p>
          )}
          <p className="muted small">{stmt.notice}</p>
          <iframe className="a11y-doc" title={t('Vorschau der Erklärung')} sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:15px/1.5 system-ui,sans-serif;margin:16px;color:#111827}h1,h2{line-height:1.25}</style>${stmt.html}`} />
        </Modal>
      )}
    </div>
  );
}

