import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ICONS, Icon, type IconName } from '../icons';
import { useSession } from '../session';
import { Badge, CodeBox, Empty, Modal, PageHead, Spinner, Tabs, navigate, useLoad, useRoute } from '../ui';
import { SignupLink } from '../referrals';
import { SortableGrid } from '../sortable/Sortable';

/** Integrations catalogue: Agentur → Integrationen → Katalog and the sub-account's "Apps" page. */

type Status = 'ok' | 'partial' | 'missing' | 'info' | 'unavailable';
interface Item {
  key: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  scope: 'location' | 'agency' | 'both';
  setup?: { location?: string; agency?: string };
  credentials: string;
  guide?: string[];
  docs?: string;
  status: Status;
  detail: string;
}

const STATUS: Record<Status, [string, 'green' | 'yellow' | 'gray' | 'blue']> = {
  ok: ['Eingerichtet', 'green'],
  partial: ['Unvollständig', 'yellow'],
  missing: ['Nicht eingerichtet', 'gray'],
  info: ['Bereit', 'blue'],
  unavailable: ['Nicht verfügbar', 'gray'],
};

const iconOf = (name: string): IconName => (name in ICONS ? (name as IconName) : 'channels');

function Guide({ item, agency, onClose }: { item: Item; agency: boolean; onClose: () => void }) {
  const target = setupTarget(item, agency);
  const origin = location.origin;
  const isApi = ['zapier', 'make', 'n8n', 'rest_hooks', 'mcp', 'norman', 'inbound_webhooks'].includes(item.key);
  return (
    <Modal
      title={item.name}
      onClose={onClose}
      footer={
        target ? (
          <button className="btn" onClick={() => (onClose(), navigate(target))}>
            Zur Einrichtung
          </button>
        ) : undefined
      }
    >
      <p style={{ marginTop: 0 }}>{item.description}</p>
      <p>
        <Badge tone={STATUS[item.status][1]}>{STATUS[item.status][0]}</Badge> <span className="muted small">{item.detail}</span>
      </p>
      <h3 className="integ-h">Zugangsdaten</h3>
      <p className="muted">{item.credentials} <SignupLink id={item.key} /></p>
      {item.guide?.length ? (
        <>
          <h3 className="integ-h">So geht’s</h3>
          <ol className="integ-steps">
            {item.guide.map((g, i) => (
              <li key={i}>{g.replace(/<deine-domain>/g, location.host)}</li>
            ))}
          </ol>
        </>
      ) : null}
      {isApi && (
        <>
          <h3 className="integ-h">Adressen</h3>
          <div className="integ-codes">
            <CodeBox text={origin} />
            {item.key === 'mcp' || item.key === 'norman' ? <CodeBox text={`${origin}/mcp`} /> : <CodeBox text={`${origin}/api/openapi.json`} />}
          </div>
          <p className="small">
            <a href="/api/docs.html" target="_blank" rel="noopener">
              API-Referenz öffnen <Icon name="external" size={13} />
            </a>
          </p>
        </>
      )}
      {item.docs && (
        <p className="muted small">
          Ausführlich im Repo: <code>{item.docs}</code>
        </p>
      )}
    </Modal>
  );
}

function setupTarget(item: Item, agency: boolean): string | undefined {
  const t = agency ? (item.setup?.agency ?? item.setup?.location) : (item.setup?.location ?? item.setup?.agency);
  if (!t) return undefined;
  return t === 'agency/integrations' ? 'agency/integrations/setup' : t;
}

export function IntegrationsCatalog({ agency, after }: { agency: boolean; after?: (query: string) => ReactNode }) {
  const session = useSession();
  const data = useLoad(() => api.get<{ items: Item[]; categories: string[]; locations?: number }>(agency ? '/api/agency/integrations/catalog' : '/api/integrations/catalog'), [agency, session.locationId]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState<Item | null>(null);
  const items = data.data?.items ?? [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => (!cat || i.category === cat) && (!s || `${i.name} ${i.description} ${i.category} ${i.detail}`.toLowerCase().includes(s)));
  }, [items, q, cat]);
  if (data.error) return <Empty>{data.error}</Empty>;
  if (!data.data) return <Spinner />;
  const cats = data.data.categories.filter((c) => items.some((i) => i.category === c));
  const n = (s: Status) => items.filter((i) => i.status === s).length;
  const canSetup = (i: Item) => !!setupTarget(i, agency) && (agency || session.user.role === 'admin' || i.scope !== 'agency');
  return (
    <div className="integ">
      <div className="integ-summary" data-tour="integ-summary">
        <span>
          <b>{n('ok')}</b> eingerichtet
        </span>
        <span>
          <b>{n('partial')}</b> unvollständig
        </span>
        <span>
          <b>{n('missing')}</b> offen
        </span>
        <span>
          <b>{n('info')}</b> sofort nutzbar
        </span>
        {agency && <span className="muted">Status je Sub-Account zusammengefasst ({data.data.locations} {data.data.locations === 1 ? 'Sub-Account' : 'Sub-Accounts'})</span>}
      </div>
      <div className="integ-toolbar" data-tour="integ-toolbar">
        <input type="search" placeholder="Suchen: Stripe, WhatsApp, Zapier …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Integrationen durchsuchen" />
        <div className="chips">
          <button className={`chip${cat === '' ? ' on' : ''}`} onClick={() => setCat('')}>
            Alle
          </button>
          {cats.map((c) => (
            <button key={c} className={`chip${cat === c ? ' on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <SortableGrid id="integ-grid" className="integ-grid" data-tour="integ-grid">
          {shown.map((i) => (
            <div key={i.key} className={`card integ-card s-${i.status}`}>
              <div className="integ-head">
                <span className="integ-ico">
                  <Icon name={iconOf(i.icon)} size={18} />
                </span>
                <div className="integ-title">
                  <strong>{i.name}</strong>
                  <span className="integ-sub">
                    <span className="muted small">{i.category}</span>
                    <Badge tone={STATUS[i.status][1]}>{STATUS[i.status][0]}</Badge>
                  </span>
                </div>
              </div>
              <p className="integ-desc">{i.description}</p>
              <p className="integ-detail small">{i.detail}</p>
              <div className="integ-actions">
                {canSetup(i) && (
                  <button className="btn small" onClick={() => navigate(setupTarget(i, agency)!)}>
                    {i.status === 'ok' ? 'Verwalten' : 'Einrichten'}
                  </button>
                )}
                <button className="btn small secondary" onClick={() => setOpen(i)}>
                  {i.guide?.length ? 'Anleitung' : 'Details'}
                </button>
                <SignupLink id={i.key} />
              </div>
            </div>
          ))}
        </SortableGrid>
      ) : (
        <Empty>Keine Integration passt zur Suche.</Empty>
      )}
      {after?.(q)}
      {open && <Guide item={open} agency={agency} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Agentur → Integrationen: "Katalog" (default) and "Einrichtung" (the existing settings cards). */
export function AgencyIntegrationsHub({ children }: { children: ReactNode }) {
  const route = useRoute();
  const sub = route[2] === 'setup' ? 'setup' : 'catalog';
  return (
    <>
      <Tabs
        tabs={[
          ['catalog', 'Katalog'],
          ['setup', 'Einrichtung'],
        ]}
        value={sub}
        onChange={(v) => navigate(v === 'setup' ? 'agency/integrations/setup' : 'agency/integrations')}
      />
      {sub === 'catalog' ? <IntegrationsCatalog agency /> : children}
    </>
  );
}

/** Sub-account → Apps. */
export function AppsPage() {
  return (
    <>
      <PageHead title="Apps & Integrationen" sub="Was in diesem Sub-Account verbunden ist – und wie du Zapier, Make, n8n, Webhooks oder den HubSpot-Umzug einrichtest." />
      <IntegrationsCatalog agency={false} />
    </>
  );
}
