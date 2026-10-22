import { useEffect, useState } from 'react';
import { api, d, dt, money } from '../api';
import { Icon } from '../icons';
import { act, Badge, Check, confirmAsk, Empty, Field, Input, Modal, navigate, PageHead, pressable, Select, Spinner, Stat, Tabs, toast, useLoad } from '../ui';
import { ContactPick, EuroInput, dlHref, euroText, germanDate, parseEuro, qty, ymdLocal } from './boCommon';
import { SortableGrid } from '../sortable/Sortable';

/** Lager & Einkauf: articles (variants, SKU, EAN), places, movements, minimum stock, stock-taking, purchase orders, valuation. */

const TABS: [string, string][] = [
  ['stock', 'Bestand'],
  ['movements', 'Bewegungen'],
  ['orders', 'Bestellungen'],
  ['counts', 'Inventur'],
  ['valuation', 'Bewertung'],
  ['places', 'Lagerorte'],
  ['settings', 'Einstellungen'],
];

export function Inventory({ tab }: { tab?: string }) {
  const t = TABS.some(([k]) => k === tab) ? tab! : 'stock';
  const status = useLoad(() => api.get('/api/inventory/status'), []);
  const places = useLoad(() => api.get('/api/inventory/places'), []);
  const articles = useLoad(() => api.get('/api/inventory/articles?all=1&limit=2000'), []);
  const st = status.data;
  const refresh = () => (void status.reload(), void articles.reload(), void places.reload());
  const label = (k: string, l: string) => (k === 'stock' && st?.low ? `${l} (${st.low} knapp)` : k === 'orders' && st?.open_orders ? `${l} (${st.open_orders})` : l);
  return (
    <>
      <PageHead title="Lager & Einkauf" sub="Artikel, Bestände, Bestellungen und Inventur – verknüpft mit Produkten und Rechnungen." />
      <SortableGrid id="inv-stats" className="stats" data-tour="inv-stats">
        <Stat label="Artikel" value={st?.articles ?? '–'} sub={`${st?.places ?? 0} Lagerorte`} />
        <Stat label="Unter Mindestbestand" value={<span className={st?.low ? 'bo-neg' : undefined}>{st?.low ?? '–'}</span>} sub="löst Benachrichtigung und Workflow aus" />
        <Stat label="Lagerwert" value={money(st?.value_cents ?? 0)} sub="gleitender Durchschnittspreis" />
        <Stat label="Offene Bestellungen" value={st?.open_orders ?? '–'} sub={st?.open_counts ? `${st.open_counts} Inventur läuft` : undefined} />
      </SortableGrid>
      <Tabs tabs={TABS.map(([k, l]) => [k, label(k, l)])} value={t} onChange={(v) => navigate(`inventory/${v}`)} />
      {t === 'stock' && <Stock articles={articles.data ?? []} places={places.data ?? []} loading={articles.loading && !articles.data} onChange={refresh} />}
      {t === 'movements' && <Movements articles={articles.data ?? []} places={places.data ?? []} onChange={refresh} />}
      {t === 'orders' && <Orders articles={articles.data ?? []} places={places.data ?? []} onChange={refresh} />}
      {t === 'counts' && <Counts places={places.data ?? []} onChange={refresh} />}
      {t === 'valuation' && <Valuation />}
      {t === 'places' && <Places places={places.data ?? []} onChange={refresh} />}
      {t === 'settings' && <InvSettings />}
    </>
  );
}

const artLabel = (a: any) => `${a.sku} – ${a.name}${a.variant ? ` (${a.variant})` : ''}`;

// --- stock ------------------------------------------------------------------------------------------------------------------

function Stock({ articles, places, loading, onChange }: { articles: any[]; places: any[]; loading: boolean; onChange: () => void }) {
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [inactive, setInactive] = useState(false);
  const [edit, setEdit] = useState<any>();
  const [move, setMove] = useState<any>();
  const rows = articles.filter((a) => (inactive || a.active) && (!low || a.low) && (!q || `${a.sku} ${a.name} ${a.ean} ${a.variant} ${a.supplier_name}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 240 }}>
          <Field label="Suche">
            <Input value={q} onChange={setQ} placeholder="Nummer, Name, EAN, Lieferant" />
          </Field>
        </div>
        <div style={{ marginBottom: 14 }}>
          <Check checked={low} onChange={setLow} label="Nur unter Mindestbestand" />
          <Check checked={inactive} onChange={setInactive} label="Inaktive zeigen" />
        </div>
        <div style={{ marginLeft: 'auto', marginBottom: 12, display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={() => setMove({})}>
            Bewegung buchen
          </button>
          <button className="btn" data-tour="inv-new-article" onClick={() => setEdit({})}>
            Artikel anlegen
          </button>
        </div>
      </div>
      {loading ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap" data-tour="inv-stock-list">
          <table className="t">
            <thead>
              <tr>
                <th>Artikel</th>
                <th className="num">Bestand</th>
                <th className="num">Minimum</th>
                <th>Lagerorte</th>
                <th className="num">Wert</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="click" style={a.active ? undefined : { opacity: 0.55 }} {...pressable(() => setEdit(a))}>
                  <td>
                    <strong>{a.name}</strong> {a.variant && <span className="muted">({a.variant})</span>}
                    <div className="muted small">
                      <span className="mono">{a.sku}</span>
                      {a.ean ? ` · EAN ${a.ean}` : ''}
                      {a.supplier_name ? ` · ${a.supplier_name}` : ''}
                    </div>
                  </td>
                  <td className="num">
                    {qty(a.qty)} {a.unit} {a.low && <Badge tone="red">knapp</Badge>}
                  </td>
                  <td className="num">{a.min_stock ? qty(a.min_stock) : '–'}</td>
                  <td className="small">
                    {(a.places ?? []).map((p: any) => (
                      <div key={p.place_id}>
                        {p.place}: {qty(p.qty)}
                      </div>
                    ))}
                  </td>
                  <td className="num">{money(a.value_cents)}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    <button className="btn small secondary" onClick={() => setMove({ article_id: a.id })}>
                      Buchen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty action={<button className="btn" onClick={() => setEdit({})}>Ersten Artikel anlegen</button>}>{articles.length ? 'Keine Artikel für diese Auswahl.' : 'Noch keine Artikel.'}</Empty>
      )}
      {edit && <ArticleModal article={edit.id ? edit : undefined} articles={articles} places={places} onClose={() => setEdit(undefined)} onDone={() => (setEdit(undefined), onChange())} />}
      {move && <MovementModal articles={articles} places={places} initial={move} onClose={() => setMove(undefined)} onDone={() => (setMove(undefined), onChange())} />}
    </>
  );
}

function ArticleModal({ article, articles, places, onClose, onDone }: { article?: any; articles: any[]; places: any[]; onClose: () => void; onDone: () => void }) {
  const full = useLoad(() => (article ? api.get(`/api/inventory/articles/${article.id}`) : Promise.resolve(undefined)), [article?.id]);
  const products = useLoad(() => api.get('/api/products'), []);
  const [f, setF] = useState<any>();
  useEffect(() => {
    if (f) return;
    const a = article ? full.data : {};
    if (!a) return;
    setF({
      sku: a.sku ?? '',
      name: a.name ?? '',
      variant: a.variant ?? '',
      parent_id: a.parent_id ?? '',
      unit: a.unit ?? 'Stk',
      ean: a.ean ?? '',
      min_stock: a.min_stock ? String(a.min_stock) : '',
      reorder_qty: a.reorder_qty ? String(a.reorder_qty) : '',
      supplier: a.supplier_contact_id ? { id: a.supplier_contact_id, name: a.supplier_name || 'Kontakt' } : null,
      supplier_name: a.supplier_name ?? '',
      supplier_sku: a.supplier_sku ?? '',
      product_id: a.product_id ?? '',
      track: a.track === undefined ? true : !!a.track,
      auto_issue: a.auto_issue === undefined ? true : !!a.auto_issue,
      active: a.active === undefined ? true : !!a.active,
      initial_qty: '',
      initial_cost: '',
    });
  }, [full.data]);
  const x = full.data;
  if (!f) return <Modal title={article ? 'Artikel' : 'Neuer Artikel'} onClose={onClose}><Spinner /></Modal>;
  const set = (k: string) => (v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const body = () => ({
    sku: f.sku,
    name: f.name,
    variant: f.variant,
    parent_id: f.parent_id || null,
    unit: f.unit,
    ean: f.ean,
    min_stock: f.min_stock === '' ? 0 : Number(String(f.min_stock).replace(',', '.')),
    reorder_qty: f.reorder_qty === '' ? 0 : Number(String(f.reorder_qty).replace(',', '.')),
    supplier_contact_id: f.supplier?.id ?? null,
    supplier_name: f.supplier ? f.supplier.name : f.supplier_name,
    supplier_sku: f.supplier_sku,
    product_id: f.product_id || null,
    track: f.track,
    auto_issue: f.auto_issue,
    active: f.active,
  });
  return (
    <Modal
      wide
      title={article ? artLabel(article) : 'Neuer Artikel'}
      onClose={onClose}
      footer={
        <>
          {article && !x?.movements?.length && (
            <button className="btn ghost danger-text" onClick={async () => confirmAsk('Artikel löschen?') && (await act(() => api.del(`/api/inventory/articles/${article.id}`), 'Gelöscht')) && onDone()}>
              Löschen
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button
            className="btn"
            onClick={async () => {
              const b: any = body();
              if (!article) Object.assign(b, { initial_qty: f.initial_qty ? Number(String(f.initial_qty).replace(',', '.')) : 0, initial_cost_cents: parseEuro(f.initial_cost) ?? undefined });
              if (await act(() => (article ? api.patch(`/api/inventory/articles/${article.id}`, b) : api.post('/api/inventory/articles', b)), 'Gespeichert')) onDone();
            }}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="grid3">
        <Field label="Artikelnummer (SKU)" hint={article ? undefined : 'Leer lassen für eine automatische Nummer'}>
          <Input value={f.sku} onChange={set('sku')} />
        </Field>
        <Field label="Bezeichnung">
          <Input value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Einheit">
          <Input value={f.unit} onChange={set('unit')} placeholder="Stk, kg, m …" />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Variante" hint="z. B. Größe L, rot">
          <Input value={f.variant} onChange={set('variant')} />
        </Field>
        <Field label="Gehört zu Hauptartikel">
          <Select value={f.parent_id} onChange={set('parent_id')} placeholder="– eigenständig –" options={articles.filter((a) => !a.parent_id && a.id !== article?.id).map((a) => [a.id, artLabel(a)] as [string, string])} />
        </Field>
        <Field label="EAN / GTIN" hint="Prüfziffer wird kontrolliert">
          <Input value={f.ean} onChange={set('ean')} inputMode="numeric" />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Mindestbestand" hint="Darunter: Benachrichtigung und Workflow „Mindestbestand unterschritten“">
          <Input value={f.min_stock} onChange={set('min_stock')} inputMode="decimal" />
        </Field>
        <Field label="Nachbestellmenge">
          <Input value={f.reorder_qty} onChange={set('reorder_qty')} inputMode="decimal" />
        </Field>
        <Field label="Produkt (für automatischen Warenausgang)">
          <Select value={f.product_id} onChange={set('product_id')} placeholder="– keins –" options={(products.data ?? []).map((p: any) => [p.id, p.name] as [string, string])} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Lieferant (Kontakt)">
          <ContactPick value={f.supplier} onChange={set('supplier')} placeholder="Kontakt suchen …" />
        </Field>
        <Field label="oder Lieferant (Name)">
          <Input value={f.supplier_name} onChange={set('supplier_name')} disabled={!!f.supplier} />
        </Field>
        <Field label="Artikelnummer beim Lieferanten">
          <Input value={f.supplier_sku} onChange={set('supplier_sku')} />
        </Field>
      </div>
      {!article && (
        <div className="grid2">
          <Field label="Anfangsbestand">
            <Input value={f.initial_qty} onChange={set('initial_qty')} inputMode="decimal" />
          </Field>
          <Field label="Einkaufspreis je Einheit (€)">
            <EuroInput value={f.initial_cost} onChange={set('initial_cost')} />
          </Field>
        </div>
      )}
      <div className="row">
        <Check checked={f.track} onChange={set('track')} label="Bestand führen und überwachen" />
        <Check checked={f.auto_issue} onChange={set('auto_issue')} label="Bei Rechnungen automatisch ausbuchen" />
        {article && <Check checked={f.active} onChange={set('active')} label="Aktiv" />}
      </div>
      {x && (
        <>
          <hr />
          <p>
            Bestand <strong>{qty(x.qty)} {x.unit}</strong> · Ø Einkaufspreis {money(x.avg_cost_cents)} · Wert {money(x.value_cents)}
            {x.variants?.length ? ` · Varianten: ${x.variants.map((v: any) => v.variant || v.sku).join(', ')}` : ''}
          </p>
          {!!x.movements?.length && (
            <table className="t">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Art</th>
                  <th className="num">Menge</th>
                  <th>Lagerort</th>
                  <th>Hinweis</th>
                </tr>
              </thead>
              <tbody>
                {x.movements.slice(0, 12).map((m: any) => (
                  <tr key={m.id}>
                    <td className="muted small">{dt(m.created_at)}</td>
                    <td>{MOVE_LABEL[m.type] ?? m.type}</td>
                    <td className="num">{m.qty > 0 ? '+' : ''}{qty(m.qty)}</td>
                    <td>{m.place}</td>
                    <td className="muted small">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}

// --- movements -----------------------------------------------------------------------------------------------------------------

const MOVE_LABEL: Record<string, string> = { receipt: 'Wareneingang', issue: 'Warenausgang', transfer_out: 'Umlagerung (ab)', transfer_in: 'Umlagerung (an)', correction: 'Korrektur', count: 'Inventur-Differenz' };

function Movements({ articles, places, onChange }: { articles: any[]; places: any[]; onChange: () => void }) {
  const [article, setArticle] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [modal, setModal] = useState(false);
  const qs = new URLSearchParams({ ...(article ? { article_id: article } : {}), ...(type ? { type } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const list = useLoad(() => api.get(`/api/inventory/movements?${qs}`), [qs]);
  const rows: any[] = list.data ?? [];
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 240 }}>
          <Field label="Artikel">
            <Select value={article} onChange={setArticle} placeholder="Alle" options={articles.map((a) => [a.id, artLabel(a)] as [string, string])} />
          </Field>
        </div>
        <div style={{ width: 170 }}>
          <Field label="Art">
            <Select value={type} onChange={setType} placeholder="Alle" options={Object.entries(MOVE_LABEL)} />
          </Field>
        </div>
        <div style={{ width: 140 }}>
          <Field label="Von">
            <Input type="date" value={from} onChange={setFrom} />
          </Field>
        </div>
        <div style={{ width: 140 }}>
          <Field label="Bis">
            <Input type="date" value={to} onChange={setTo} />
          </Field>
        </div>
        <div style={{ marginLeft: 'auto', marginBottom: 12 }}>
          <button className="btn" data-tour="inv-book" onClick={() => setModal(true)}>
            Bewegung buchen
          </button>
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap" data-tour="inv-movements">
          <table className="t">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Art</th>
                <th>Artikel</th>
                <th>Lagerort</th>
                <th className="num">Menge</th>
                <th className="num">Preis</th>
                <th className="num">Bestand danach</th>
                <th>Hinweis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{dt(m.created_at)}</td>
                  <td>{m.type_label}</td>
                  <td>
                    <span className="mono">{m.sku}</span> {m.name}
                  </td>
                  <td>{m.place}</td>
                  <td className="num">
                    <span className={m.qty < 0 ? 'bo-neg' : undefined}>{m.qty > 0 ? '+' : ''}{qty(m.qty)} {m.unit}</span>
                  </td>
                  <td className="num">{m.unit_cost_cents ? money(m.unit_cost_cents) : '–'}</td>
                  <td className="num">{qty(m.balance)}</td>
                  <td className="muted small">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Keine Bewegungen.</Empty>
      )}
      {modal && <MovementModal articles={articles} places={places} initial={{}} onClose={() => setModal(false)} onDone={() => (setModal(false), void list.reload(), onChange())} />}
    </>
  );
}

function MovementModal({ articles, places, initial, onClose, onDone }: { articles: any[]; places: any[]; initial: { article_id?: string }; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ article_id: initial.article_id ?? '', type: 'receipt', place_id: '', to_place_id: '', qty: '', cost: '', note: '' });
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const art = articles.find((a) => a.id === f.article_id);
  const active = places.filter((p) => p.active);
  return (
    <Modal
      title="Lagerbewegung buchen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button
            className="btn"
            onClick={async () => {
              const n = Number(f.qty.replace(',', '.'));
              const ok =
                f.type === 'transfer'
                  ? await act(() => api.post('/api/inventory/transfers', { article_id: f.article_id, from_place_id: f.place_id, to_place_id: f.to_place_id, qty: n, note: f.note }), 'Umgelagert')
                  : await act(() => api.post('/api/inventory/movements', { article_id: f.article_id, type: f.type, place_id: f.place_id || undefined, qty: f.type === 'issue' ? Math.abs(n) : n, unit_cost_cents: f.type === 'receipt' && f.cost ? parseEuro(f.cost) : undefined, note: f.note }), 'Gebucht');
              if (ok) onDone();
            }}
          >
            Buchen
          </button>
        </>
      }
    >
      <Field label="Artikel">
        <Select value={f.article_id} onChange={set('article_id')} placeholder="Artikel wählen" options={articles.filter((a) => a.active).map((a) => [a.id, `${artLabel(a)} · ${qty(a.qty)} ${a.unit}`] as [string, string])} />
      </Field>
      <div className="grid2">
        <Field label="Art">
          <Select value={f.type} onChange={set('type')} options={[['receipt', 'Wareneingang'], ['issue', 'Warenausgang'], ['correction', 'Korrektur (+/−)'], ['transfer', 'Umlagerung']]} />
        </Field>
        <Field label={`Menge${art ? ` (${art.unit})` : ''}`}>
          <Input value={f.qty} onChange={set('qty')} inputMode="decimal" />
        </Field>
      </div>
      <div className="grid2">
        <Field label={f.type === 'transfer' ? 'Von Lagerort' : 'Lagerort'}>
          <Select value={f.place_id} onChange={set('place_id')} placeholder={f.type === 'transfer' ? 'wählen' : 'Standard-Lagerort'} options={active.map((p) => [p.id, p.name] as [string, string])} />
        </Field>
        {f.type === 'transfer' ? (
          <Field label="Nach Lagerort">
            <Select value={f.to_place_id} onChange={set('to_place_id')} placeholder="wählen" options={active.filter((p) => p.id !== f.place_id).map((p) => [p.id, p.name] as [string, string])} />
          </Field>
        ) : f.type === 'receipt' ? (
          <Field label="Einkaufspreis je Einheit (€)" hint="Leer: letzter Preis. Der Durchschnittspreis wird neu berechnet.">
            <EuroInput value={f.cost} onChange={set('cost')} />
          </Field>
        ) : (
          <div />
        )}
      </div>
      <Field label="Hinweis">
        <Input value={f.note} onChange={set('note')} />
      </Field>
    </Modal>
  );
}

// --- purchase orders -----------------------------------------------------------------------------------------------------------

const O_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow']> = { draft: ['Entwurf', 'gray'], ordered: ['Bestellt', 'blue'], partial: ['Teilweise geliefert', 'yellow'], received: ['Geliefert', 'green'], cancelled: ['Storniert', 'red'] };

function Orders({ articles, places, onChange }: { articles: any[]; places: any[]; onChange: () => void }) {
  const [filter, setFilter] = useState('open');
  const [edit, setEdit] = useState<any>();
  const [view, setView] = useState<string>();
  const list = useLoad(() => api.get(`/api/inventory/orders?status=${filter === 'all' ? '' : filter}`), [filter]);
  const rows: any[] = list.data ?? [];
  const done = () => (setEdit(undefined), setView(undefined), void list.reload(), onChange());
  return (
    <>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="btn" data-tour="inv-new-order" onClick={() => setEdit({})}>
          Neue Bestellung
        </button>
        <div className="tabs" style={{ margin: 0, border: 0 }}>
          {[['open', 'Offen'], ['received', 'Geliefert'], ['cancelled', 'Storniert'], ['all', 'Alle']].map(([k, l]) => (
            <button key={k} className={k === filter ? 'on' : ''} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap" data-tour="inv-orders">
          <table className="t">
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Lieferant</th>
                <th>Status</th>
                <th className="num">Positionen</th>
                <th className="num">Summe</th>
                <th>Erwartet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="click" {...pressable(() => setView(o.id))}>
                  <td className="mono">{o.number}</td>
                  <td>{o.supplier_name || '–'}</td>
                  <td>
                    <Badge tone={O_STATUS[o.status]?.[1]}>{O_STATUS[o.status]?.[0] ?? o.status}</Badge>
                  </td>
                  <td className="num">{o.lines}</td>
                  <td className="num">{money(o.total_cents)}</td>
                  <td>{germanDate(o.expected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Keine Bestellungen.</Empty>
      )}
      {edit && <OrderEditor order={edit.id ? edit : undefined} articles={articles} onClose={() => setEdit(undefined)} onDone={done} />}
      {view && <OrderView id={view} places={places} onClose={() => setView(undefined)} onEdit={(o) => (setView(undefined), setEdit(o))} onDone={done} />}
    </>
  );
}

function OrderEditor({ order, articles, onClose, onDone }: { order?: any; articles: any[]; onClose: () => void; onDone: () => void }) {
  const low = useLoad(() => api.get('/api/inventory/low-stock'), []);
  const [f, setF] = useState({ supplier: order?.contact_id ? { id: order.contact_id, name: order.contact_name || order.supplier_name } : null, supplier_name: order?.supplier_name ?? '', expected_at: order?.expected_at ?? '', notes: order?.notes ?? '' });
  const [lines, setLines] = useState<{ article_id: string; qty: string; cost: string }[]>(order ? order.lines.map((l: any) => ({ article_id: l.article_id, qty: String(l.qty), cost: euroText(l.unit_cost_cents) })) : [{ article_id: '', qty: '', cost: '' }]);
  const upd = (i: number, k: string, v: string) => setLines((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const suggest = () => {
    const items = (low.data ?? []).map((a: any) => ({ article_id: a.id, qty: String(a.reorder_qty || a.missing || 1), cost: euroText(articles.find((x) => x.id === a.id)?.last_cost_cents || articles.find((x) => x.id === a.id)?.avg_cost_cents || 0) }));
    if (items.length) setLines(items);
    else toast('Nichts unter Mindestbestand');
  };
  return (
    <Modal
      wide
      title={order ? `Bestellung ${order.number}` : 'Neue Bestellung'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button
            className="btn"
            onClick={async () => {
              const body = { contact_id: f.supplier?.id ?? null, supplier_name: f.supplier ? f.supplier.name : f.supplier_name, expected_at: f.expected_at || null, notes: f.notes, lines: lines.filter((l) => l.article_id).map((l) => ({ article_id: l.article_id, qty: Number(l.qty.replace(',', '.')), unit_cost_cents: l.cost ? parseEuro(l.cost) : undefined })) };
              if (await act(() => (order ? api.patch(`/api/inventory/orders/${order.id}`, body) : api.post('/api/inventory/orders', body)), 'Gespeichert')) onDone();
            }}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Lieferant (Kontakt)" hint="Mit E-Mail-Adresse kann die Bestellung direkt gesendet werden">
          <ContactPick value={f.supplier} onChange={(v) => setF({ ...f, supplier: v })} />
        </Field>
        <Field label="oder Lieferant (Name)">
          <Input value={f.supplier_name} onChange={(v) => setF({ ...f, supplier_name: v })} disabled={!!f.supplier} />
        </Field>
        <Field label="Gewünschter Liefertermin">
          <Input type="date" value={f.expected_at} onChange={(v) => setF({ ...f, expected_at: v })} />
        </Field>
        <Field label="Hinweise für den Lieferanten">
          <Input value={f.notes} onChange={(v) => setF({ ...f, notes: v })} />
        </Field>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Artikel</th>
              <th style={{ width: 110 }}>Menge</th>
              <th style={{ width: 130 }}>Preis je Einheit (€)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Select value={l.article_id} onChange={(v) => upd(i, 'article_id', v)} placeholder="Artikel wählen" options={articles.filter((a) => a.active).map((a) => [a.id, artLabel(a)] as [string, string])} />
                </td>
                <td>
                  <Input value={l.qty} onChange={(v) => upd(i, 'qty', v)} inputMode="decimal" />
                </td>
                <td>
                  <EuroInput value={l.cost} onChange={(v) => upd(i, 'cost', v)} />
                </td>
                <td>
                  {lines.length > 1 && (
                    <button className="icon-btn" aria-label="Zeile entfernen" onClick={() => setLines((r) => r.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn small secondary" onClick={() => setLines((r) => [...r, { article_id: '', qty: '', cost: '' }])}>+ Position</button>
        <button className="btn small secondary" onClick={suggest} title="Alle Artikel unter Mindestbestand mit ihrer Nachbestellmenge">
          Vorschlag aus Mindestbestand
        </button>
      </div>
    </Modal>
  );
}

function OrderView({ id, places, onClose, onEdit, onDone }: { id: string; places: any[]; onClose: () => void; onEdit: (o: any) => void; onDone: () => void }) {
  const r = useLoad(() => api.get(`/api/inventory/orders/${id}`), [id]);
  const o = r.data;
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [place, setPlace] = useState('');
  if (!o) return <Modal title="Bestellung" onClose={onClose}><Spinner /></Modal>;
  const can = ['draft', 'ordered', 'partial'].includes(o.status);
  const act2 = async (fn: () => Promise<unknown>, ok: string) => (await act(fn, ok)) && (void r.reload(), onDone());
  return (
    <Modal
      wide
      title={`Bestellung ${o.number}`}
      onClose={onClose}
      footer={
        <>
          {o.status === 'draft' && <button className="btn secondary" onClick={() => onEdit(o)}>Bearbeiten</button>}
          {['draft', 'ordered'].includes(o.status) && !o.lines.some((l: any) => l.received > 0) && (
            <button className="btn ghost danger-text" onClick={async () => confirmAsk('Bestellung stornieren?') && (await act2(() => api.post(`/api/inventory/orders/${id}/cancel`, {}), 'Storniert'))}>
              Stornieren
            </button>
          )}
          <span style={{ flex: 1 }} />
          {o.status === 'draft' && (
            <>
              <button className="btn secondary" onClick={() => act2(() => api.post(`/api/inventory/orders/${id}/place`, {}), 'Als bestellt markiert')}>
                Als bestellt markieren
              </button>
              <button className="btn" disabled={!o.contact_email} title={o.contact_email ? undefined : 'Der Lieferant braucht einen Kontakt mit E-Mail-Adresse'} onClick={() => act2(() => api.post(`/api/inventory/orders/${id}/send`, {}), 'Gesendet')}>
                <Icon name="send" /> Per E-Mail senden
              </button>
            </>
          )}
          {['ordered', 'partial'].includes(o.status) && (
            <button
              className="btn"
              data-tour="inv-receive"
              onClick={() =>
                act2(
                  () =>
                    api.post(`/api/inventory/orders/${id}/receive`, {
                      lines: o.lines.map((l: any) => ({ line_id: l.id, qty: Number((recv[l.id] ?? String(Math.max(0, l.qty - l.received))).replace(',', '.')), place_id: place || undefined })).filter((l: any) => l.qty > 0),
                    }),
                  'Wareneingang gebucht',
                )
              }
            >
              Wareneingang buchen
            </button>
          )}
        </>
      }
    >
      <p>
        <Badge tone={O_STATUS[o.status]?.[1]}>{O_STATUS[o.status]?.[0]}</Badge> {o.contact_name || o.supplier_name} {o.contact_email && <span className="muted">· {o.contact_email}</span>}
        {o.expected_at && <span className="muted"> · erwartet {germanDate(o.expected_at)}</span>}
      </p>
      {o.notes && <p className="muted">{o.notes}</p>}
      <table className="t">
        <thead>
          <tr>
            <th>Artikel</th>
            <th className="num">Bestellt</th>
            <th className="num">Geliefert</th>
            <th className="num">Preis</th>
            {['ordered', 'partial'].includes(o.status) && <th style={{ width: 120 }}>Jetzt geliefert</th>}
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l: any) => (
            <tr key={l.id}>
              <td>
                <span className="mono">{l.sku}</span> {l.name}
              </td>
              <td className="num">{qty(l.qty)} {l.unit}</td>
              <td className="num">{qty(l.received)}</td>
              <td className="num">{money(l.unit_cost_cents)}</td>
              {['ordered', 'partial'].includes(o.status) && (
                <td>
                  <Input value={recv[l.id] ?? String(Math.max(0, l.qty - l.received)).replace('.', ',')} onChange={(v) => setRecv((s) => ({ ...s, [l.id]: v }))} inputMode="decimal" />
                </td>
              )}
            </tr>
          ))}
          <tr className="total">
            <td colSpan={3}>
              <strong>Summe</strong>
            </td>
            <td className="num">
              <strong>{money(o.total_cents)}</strong>
            </td>
            {['ordered', 'partial'].includes(o.status) && <td />}
          </tr>
        </tbody>
      </table>
      {['ordered', 'partial'].includes(o.status) && (
        <Field label="Einlagern in">
          <Select value={place} onChange={setPlace} placeholder="Standard-Lagerort" options={places.filter((p) => p.active).map((p) => [p.id, p.name] as [string, string])} />
        </Field>
      )}
      {can && o.status !== 'draft' && <p className="muted small">Der Wareneingang bucht die Menge ins Lager und aktualisiert den Durchschnittspreis.</p>}
    </Modal>
  );
}

// --- stock-taking --------------------------------------------------------------------------------------------------------------

function Counts({ places, onChange }: { places: any[]; onChange: () => void }) {
  const [open, setOpen] = useState<string>();
  const [create, setCreate] = useState(false);
  const list = useLoad(() => api.get('/api/inventory/counts'), []);
  const rows: any[] = list.data ?? [];
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" data-tour="inv-new-count" onClick={() => setCreate(true)}>
          Neue Inventur
        </button>
      </div>
      <p className="muted small">Beim Start wird der Soll-Bestand eingefroren. Du trägst die gezählten Mengen ein; beim Abschließen werden nur die Differenzen als Korrekturbuchungen verbucht.</p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Inventur</th>
                <th>Lagerort</th>
                <th>Status</th>
                <th className="num">Gezählt</th>
                <th>Gestartet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="click" {...pressable(() => setOpen(c.id))}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td>{c.place || 'alle'}</td>
                  <td>
                    <Badge tone={c.status === 'open' ? 'blue' : c.status === 'closed' ? 'green' : 'gray'}>{{ open: 'läuft', closed: 'abgeschlossen', cancelled: 'verworfen' }[c.status as string] ?? c.status}</Badge>
                  </td>
                  <td className="num">
                    {c.counted} / {c.lines}
                  </td>
                  <td>{d(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Noch keine Inventur.</Empty>
      )}
      {create && <CountCreate places={places} onClose={() => setCreate(false)} onDone={(id) => (setCreate(false), void list.reload(), setOpen(id))} />}
      {open && <CountView id={open} onClose={() => (setOpen(undefined), void list.reload(), onChange())} />}
    </>
  );
}

function CountCreate({ places, onClose, onDone }: { places: any[]; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(`Inventur ${ymdLocal()}`);
  const [place, setPlace] = useState('');
  return (
    <Modal
      title="Neue Inventur"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button className="btn" onClick={async () => { const c = await act(() => api.post('/api/inventory/counts', { name, place_id: place || undefined })); if (c) onDone(c.id); }}>
            Starten
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={setName} />
      </Field>
      <Field label="Lagerort" hint="Leer = alle Lagerorte">
        <Select value={place} onChange={setPlace} placeholder="Alle" options={places.filter((p) => p.active).map((p) => [p.id, p.name] as [string, string])} />
      </Field>
    </Modal>
  );
}

function CountView({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useLoad(() => api.get(`/api/inventory/counts/${id}`), [id]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const c = r.data;
  if (!c) return <Modal title="Inventur" onClose={onClose}><Spinner /></Modal>;
  const isOpen = c.status === 'open';
  const payload = () => c.lines.filter((l: any) => vals[l.id] !== undefined).map((l: any) => ({ id: l.id, counted: vals[l.id] === '' ? null : Number(vals[l.id].replace(',', '.')) }));
  const save = async () => {
    const lines = payload();
    if (!lines.length) return true;
    const res = await act(() => api.put(`/api/inventory/counts/${id}/lines`, { lines }));
    if (res) (setVals({}), r.setData(res));
    return !!res;
  };
  return (
    <Modal
      wide
      title={c.name}
      onClose={onClose}
      footer={
        isOpen ? (
          <>
            <button className="btn ghost danger-text" onClick={async () => confirmAsk('Inventur verwerfen?') && (await act(() => api.post(`/api/inventory/counts/${id}/cancel`, {}), 'Verworfen')) && onClose()}>
              Verwerfen
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn secondary" onClick={async () => (await save()) && toast('Gespeichert')}>Zählstand speichern</button>
            <button
              className="btn"
              onClick={async () => {
                if (!(await save())) return;
                if (!confirmAsk('Inventur abschließen? Die Differenzen werden als Korrekturbuchungen verbucht.')) return;
                const res = await act(() => api.post(`/api/inventory/counts/${id}/close`, {}));
                if (res) (toast(`${res.booked} Differenzen gebucht`), onClose());
              }}
            >
              Abschließen und Differenzen buchen
            </button>
          </>
        ) : (
          <button className="btn secondary" onClick={onClose}>Schließen</button>
        )
      }
    >
      <p className="muted">
        {c.place_id ? 'Ein Lagerort' : 'Alle Lagerorte'} · {c.summary.counted} von {c.summary.lines} gezählt · {c.summary.differences} Differenzen
        {c.summary.differences ? ` (Überschuss ${money(c.summary.surplus_value_cents)}, Fehlbestand ${money(c.summary.shortage_value_cents)})` : ''}
      </p>
      <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="t">
          <thead>
            <tr>
              <th>Artikel</th>
              <th>Lagerort</th>
              <th className="num">Soll</th>
              <th style={{ width: 120 }}>Gezählt</th>
              <th className="num">Differenz</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l: any) => {
              const shown = vals[l.id] ?? (l.counted === null ? '' : String(l.counted).replace('.', ','));
              const diff = shown === '' ? null : Math.round((Number(shown.replace(',', '.')) - l.expected) * 1000) / 1000;
              return (
                <tr key={l.id}>
                  <td>
                    <span className="mono">{l.sku}</span> {l.name}
                  </td>
                  <td>{l.place}</td>
                  <td className="num">{qty(l.expected)} {l.unit}</td>
                  <td>{isOpen ? <Input value={shown} onChange={(v) => setVals((s) => ({ ...s, [l.id]: v }))} inputMode="decimal" /> : shown || '–'}</td>
                  <td className="num">{diff === null ? '' : <span className={diff < 0 ? 'bo-neg' : diff > 0 ? 'bo-ok' : undefined}>{diff > 0 ? '+' : ''}{qty(diff)}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// --- valuation, places, settings -------------------------------------------------------------------------------------------

function Valuation() {
  const [asof, setAsof] = useState('');
  const r = useLoad(() => api.get(`/api/inventory/valuation${asof ? `?asof=${asof}` : ''}`), [asof]);
  const v = r.data;
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 170 }}>
          <Field label="Stichtag" hint="Leer = heute">
            <Input type="date" value={asof} onChange={setAsof} />
          </Field>
        </div>
        <div style={{ marginBottom: 14 }}>
          <a className="btn secondary" data-tour="inv-valuation-csv" href={dlHref('/api/inventory/valuation', { asof, format: 'csv' })}>
            <Icon name="download" /> CSV
          </a>
        </div>
      </div>
      {!v ? (
        <Spinner />
      ) : v.rows.length ? (
        <div className="table-wrap" data-tour="inv-valuation">
          <table className="t">
            <thead>
              <tr>
                <th>Artikel</th>
                <th className="num">Bestand</th>
                <th className="num">Ø Einkaufspreis</th>
                <th className="num">Wert</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map((x: any) => (
                <tr key={x.article_id}>
                  <td>
                    <span className="mono">{x.sku}</span> {x.name}
                  </td>
                  <td className="num">{qty(x.qty)} {x.unit}</td>
                  <td className="num">{money(x.avg_cost_cents)}</td>
                  <td className="num">{money(x.value_cents)}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={3}>
                  <strong>Lagerwert gesamt</strong>
                </td>
                <td className="num">
                  <strong>{money(v.total_cents)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Kein Bestand zum Stichtag.</Empty>
      )}
      <p className="muted small">Bewertung: {v?.method ?? 'gleitender Durchschnittspreis'}. Zum Stichtag wird aus dem Bewegungsprotokoll zurückgerechnet. Das ist eine Hilfe für die Inventur – die Bilanzbewertung legt dein Steuerberater fest.</p>
    </>
  );
}

function Places({ places, onChange }: { places: any[]; onChange: () => void }) {
  const [edit, setEdit] = useState<any>();
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setEdit({})}>
          Lagerort anlegen
        </button>
      </div>
      <div className="table-wrap" data-tour="inv-places">
        <table className="t">
          <thead>
            <tr>
              <th>Lagerort</th>
              <th>Kürzel</th>
              <th className="num">Artikel</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {places.map((p) => (
              <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                <td>
                  <strong>{p.name}</strong> {p.is_default ? <Badge tone="blue">Standard</Badge> : null}
                </td>
                <td className="mono">{p.code}</td>
                <td className="num">{p.articles}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn small secondary" onClick={() => setEdit(p)}>Umbenennen</button>{' '}
                  {!p.is_default && (
                    <button className="btn small secondary" onClick={async () => (await act(() => api.patch(`/api/inventory/places/${p.id}`, { is_default: true }))) && onChange()}>
                      Als Standard
                    </button>
                  )}{' '}
                  {!p.is_default && (
                    <button className="btn small ghost" onClick={async () => (await act(() => api.patch(`/api/inventory/places/${p.id}`, { active: !p.active }))) && onChange()}>
                      {p.active ? 'Deaktivieren' : 'Aktivieren'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <PlaceModal place={edit.id ? edit : undefined} onClose={() => setEdit(undefined)} onDone={() => (setEdit(undefined), onChange())} />}
    </>
  );
}

function PlaceModal({ place, onClose, onDone }: { place?: any; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(place?.name ?? '');
  const [code, setCode] = useState(place?.code ?? '');
  return (
    <Modal
      title={place ? 'Lagerort umbenennen' : 'Lagerort anlegen'}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Abbrechen</button>
          <button className="btn" onClick={async () => (await act(() => (place ? api.patch(`/api/inventory/places/${place.id}`, { name, code }) : api.post('/api/inventory/places', { name, code })), 'Gespeichert')) && onDone()}>
            Speichern
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Name">
          <Input value={name} onChange={setName} placeholder="z. B. Regal A, Transporter" />
        </Field>
        <Field label="Kürzel">
          <Input value={code} onChange={setCode} />
        </Field>
      </div>
    </Modal>
  );
}

function InvSettings() {
  const s = useLoad(() => api.get('/api/inventory/settings'), []);
  const [f, setF] = useState<any>();
  useEffect(() => {
    if (s.data && !f) setF(s.data);
  }, [s.data]);
  if (!f) return <Spinner />;
  return (
    <div className="card" style={{ maxWidth: 680 }} data-tour="inv-settings">
      <h2>Automatischer Warenausgang</h2>
      <p className="muted small">
        Wenn eine Rechnung bezahlt (oder versendet) wird, bucht HyperLevel die Positionen aus dem Lager aus. Eine Position wird einem Artikel zugeordnet über die Artikelnummer im Text (z. B. „[KAFFEE-500]“), das verknüpfte Produkt oder den Artikelnamen. Bei Zweifeln wird nichts geraten – die Position bleibt unberührt. Jede Rechnung wird nur einmal ausgebucht.
      </p>
      <Field label="Ausbuchen, wenn die Rechnung …">
        <Select value={f.auto_issue_on} onChange={(v) => setF({ ...f, auto_issue_on: v })} options={[['paid', 'bezahlt ist'], ['sent', 'versendet wird'], ['off', 'nie (nur von Hand)']]} />
      </Field>
      <Check checked={f.allow_negative} onChange={(v) => setF({ ...f, allow_negative: v })} label="Negativen Bestand erlauben (sonst wird ein zu großer Warenausgang abgelehnt)" />
      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => (await act(() => api.put('/api/inventory/settings', f), 'Gespeichert')) && void s.reload()}>
          Speichern
        </button>
      </div>
    </div>
  );
}
