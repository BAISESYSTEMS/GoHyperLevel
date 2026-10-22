import { useState } from 'react';
import { ago, api, d } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, Select, Spinner, TagInput, Textarea, act, confirmAsk, useLoad } from '../ui';
import { ImagePicker, MarkdownEditor } from './ContentKit';
import { useCourses } from './Courses';
import { CopyField, NumberField, Sec, StatusBadge, Sub, euro, fromLocalInput, run } from './CommunityParts';

/**
 * Community → Beitritt: the public page (/c/<adresse>), tiers (free, monthly/yearly, lifetime, trial), questions, approval, requests,
 * memberships, invite links and discount codes. Server side: modules/community-pages.ts.
 */

const BILL: Record<string, string> = { free: 'kostenlos', month: 'monatlich', year: 'jährlich', once: 'einmalig' };
const ACCESS: Record<string, string> = { all: 'alle im Mitgliederbereich', courses: 'Teilnehmer bestimmter Kurse', tags: 'Kontakte mit bestimmten Tags', join: 'Beitritt über die Community-Seite' };

export function JoinTab({ group, onChange }: { group: any; onChange: () => void }) {
  const j = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/join`), [group.id]);
  const [sub, setSub] = useState('page');
  if (j.error) return <Empty>{j.error}</Empty>;
  if (!j.data) return <Spinner />;
  const data = j.data;
  const pending = (data.counts.pending ?? 0) + (data.counts.awaiting_payment ?? 0);
  const reload = () => {
    void j.reload();
    onChange();
  };
  return (
    <div className="cma" data-tour="community-join">
      {data.access_mode !== 'join' && (
        <div className="cma-note" role="note">
          <strong>Aktuell kommen Mitglieder so herein: {ACCESS[data.access_mode] ?? data.access_mode}.</strong> Die Beitritts-Seite, Stufen, Zahlung und Freigabe wirken erst, wenn du den Zugang auf „Beitritt über die Community-Seite“ stellst. Alle, die jetzt schon drin sind, bleiben als kostenlose Mitglieder.
          <div className="cma-actions">
            <button
              className="btn"
              onClick={async () => {
                if (!(await confirmAsk('Zugang auf „Beitritt über die Community-Seite“ umstellen? Wer schon in der Gruppe ist, bleibt als kostenloses Mitglied drin.'))) return;
                await run(() => api.put(`/api/community/groups/${group.id}/join/page`, { enabled: data.page?.enabled ?? false, set_access_join: true }), 'Zugang umgestellt', reload);
              }}
            >
              Jetzt umstellen
            </button>
          </div>
        </div>
      )}
      <Sub
        value={sub}
        onChange={setSub}
        tabs={[
          ['page', 'Öffentliche Seite'],
          ['tiers', `Stufen (${data.tiers.length})`],
          ['requests', `Anfragen${pending ? ` (${pending})` : ''}`],
          ['members', 'Mitgliedschaften'],
          ['invites', 'Einladungs-Links'],
          ['coupons', 'Rabattcodes'],
        ]}
      />
      {sub === 'page' && <PageForm group={group} data={data} onSaved={reload} />}
      {sub === 'tiers' && <Tiers group={group} data={data} onSaved={reload} />}
      {sub === 'requests' && <Requests group={group} onDone={reload} />}
      {sub === 'members' && <Memberships group={group} data={data} onDone={reload} />}
      {sub === 'invites' && <Invites group={group} data={data} />}
      {sub === 'coupons' && <Coupons group={group} data={data} />}
    </div>
  );
}

// --- page ---------------------------------------------------------------------------------------------------------------------
function PageForm({ group, data, onSaved }: { group: any; data: any; onSaved: () => void }) {
  const p = data.page;
  const [f, setF] = useState<any>(() => ({
    enabled: !!p?.enabled,
    slug: p?.slug ?? group.slug ?? '',
    tagline: p?.tagline ?? '',
    about: p?.about ?? '',
    video_url: p?.video_url ?? '',
    cover_image: p?.cover_image ?? '',
    approval: !!p?.approval,
    show_member_count: p ? !!p.show_member_count : true,
    show_admins: p ? !!p.show_admins : true,
    discoverable: !!p?.discoverable,
    indexable: p ? !!p.indexable : true,
    category: p?.category ?? '',
    seo_title: p?.seo_title ?? '',
    seo_description: p?.seo_description ?? '',
    terms_url: p?.terms_url ?? '',
    privacy_url: p?.privacy_url ?? '',
    consent_text: p?.consent_text ?? '',
    success_text: p?.success_text ?? '',
    stripe_promo: !!p?.stripe_promo,
    questions: p?.questions ?? [],
  }));
  const set = (patch: any) => setF((x: any) => ({ ...x, ...patch }));
  const q = (i: number, patch: any) => set({ questions: f.questions.map((x: any, n: number) => (n === i ? { ...x, ...patch } : x)) });
  const save = () => run(() => api.put(`/api/community/groups/${group.id}/join/page`, f), 'Gespeichert', onSaved);
  const url = data.url ?? `${location.origin}/c/${f.slug || '…'}`;
  return (
    <div className="cma-grid">
      <Sec title="Seite" lead="So sieht die Seite aus, die Interessenten sehen – ohne Anmeldung, mit Titelbild oder Video, Beschreibung, Preisen und Beitritts-Formular.">
        <Check checked={f.enabled} onChange={(v) => set({ enabled: v })} label="Die öffentliche Seite ist erreichbar" />
        <Field label="Adresse" hint="Nur Kleinbuchstaben, Ziffern und Bindestriche.">
          <Input value={f.slug} onChange={(v) => set({ slug: v })} placeholder="mein-club" />
        </Field>
        {p && f.enabled && <CopyField value={url} label="Link zur Seite" />}
        <Field label="Kurzbeschreibung (eine Zeile)">
          <Input value={f.tagline} maxLength={140} onChange={(v) => set({ tagline: v })} placeholder="z. B. Gemeinsam schneller wachsen" />
        </Field>
        <Field label="Titelbild">
          <ImagePicker value={f.cover_image} onChange={(v) => set({ cover_image: v })} />
        </Field>
        <Field label="Video (YouTube, Vimeo, Loom oder MP4-Link)">
          <Input value={f.video_url} onChange={(v) => set({ video_url: v })} placeholder="https://www.youtube.com/watch?v=…" />
        </Field>
        <Field label="Über uns (Markdown)">
          <MarkdownEditor value={f.about} onChange={(v) => set({ about: v })} rows={10} label="Über uns (Markdown)" />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
          {p && f.enabled && (
            <a className="btn secondary" href={url} target="_blank" rel="noreferrer">
              Seite ansehen ↗
            </a>
          )}
        </div>
      </Sec>
      <Sec title="Beitritt" lead="Wer darf rein, was fragst du ab, und wie sicherst du dich ab?">
        <Check checked={f.approval} onChange={(v) => set({ approval: v })} label="Anfragen erst freigeben (Warteschlange unter „Anfragen“)" />
        <Check checked={f.show_member_count} onChange={(v) => set({ show_member_count: v })} label="Mitgliederzahl zeigen" />
        <Check checked={f.show_admins} onChange={(v) => set({ show_admins: v })} label="Admins und Moderatoren zeigen" />
        <Check checked={f.stripe_promo} onChange={(v) => set({ stripe_promo: v })} label="Rabattcodes auch direkt im Stripe-Checkout erlauben" />
        <h4 style={{ margin: '14px 0 4px' }}>Fragen beim Beitritt (höchstens 3)</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Die Antworten stehen am Kontakt (als eigenes Feld) und in der Anfrage.
        </p>
        {f.questions.map((x: any, i: number) => (
          <div key={x.id ?? i} className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Input value={x.label} maxLength={150} onChange={(v) => q(i, { label: v })} placeholder="z. B. Was ist dein Ziel?" aria-label={`Frage ${i + 1}`} />
            </div>
            <Check checked={!!x.required} onChange={(v) => q(i, { required: v })} label="Pflicht" />
            <button className="btn secondary small" onClick={() => set({ questions: f.questions.filter((_: any, n: number) => n !== i) })} aria-label={`Frage ${i + 1} entfernen`}>
              ✕
            </button>
          </div>
        ))}
        {f.questions.length < 3 && (
          <button className="btn secondary" onClick={() => set({ questions: [...f.questions, { id: '', label: '', required: false, field_key: '' }] })}>
            + Frage hinzufügen
          </button>
        )}
        <Field label="Einwilligungstext (Häkchen beim Beitritt)">
          <Input value={f.consent_text} onChange={(v) => set({ consent_text: v })} placeholder="z. B. Ich möchte Neuigkeiten per E-Mail erhalten." />
        </Field>
        <div className="cma-two">
          <Field label="Link zu den AGB">
            <Input value={f.terms_url} onChange={(v) => set({ terms_url: v })} placeholder="https://…" />
          </Field>
          <Field label="Link zur Datenschutzerklärung">
            <Input value={f.privacy_url} onChange={(v) => set({ privacy_url: v })} placeholder="https://…" />
          </Field>
        </div>
        <Field label="Text nach dem Beitritt">
          <Input value={f.success_text} onChange={(v) => set({ success_text: v })} placeholder="z. B. Willkommen! Schau in dein Postfach." />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
      <Sec title="Suchmaschinen und Verzeichnis" lead="Die Seite hat Titel, Beschreibung, Vorschaubild und strukturierte Daten für Google und soziale Netzwerke.">
        <Check checked={f.indexable} onChange={(v) => set({ indexable: v })} label="Suchmaschinen dürfen die Seite aufnehmen" />
        <Field label="Titel in Suchergebnissen" hint={`${f.seo_title.length}/70`}>
          <Input value={f.seo_title} maxLength={70} onChange={(v) => set({ seo_title: v })} placeholder={`${group.name} – Community`} />
        </Field>
        <Field label="Beschreibung in Suchergebnissen" hint={`${f.seo_description.length}/160`}>
          <Textarea rows={3} value={f.seo_description} onChange={(v) => set({ seo_description: v.slice(0, 160) })} />
        </Field>
        <Check checked={f.discoverable} onChange={(v) => set({ discoverable: v })} label={<>Im öffentlichen Verzeichnis zeigen (<a href={data.discovery_url} target="_blank" rel="noreferrer">/communities</a>)</>} />
        {f.discoverable && (
          <Field label="Kategorie im Verzeichnis">
            <Input value={f.category} maxLength={40} onChange={(v) => set({ category: v })} placeholder="z. B. Business, Fitness, Kunst" />
          </Field>
        )}
        <div className="cma-actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </div>
      </Sec>
    </div>
  );
}

// --- tiers --------------------------------------------------------------------------------------------------------------------
function Tiers({ group, data, onSaved }: { group: any; data: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      {!data.stripe.connected && data.tiers.some((t: any) => !t.prices.free) && (
        <div className="cma-note">
          Stripe ist noch nicht verbunden – bezahlte Stufen können erst gekauft werden, wenn du unter Einstellungen → Zahlung deinen Stripe-Schlüssel hinterlegst.
        </div>
      )}
      <div className="cma-grid">
        {data.tiers.map((t: any) => (
          <Sec
            key={t.id}
            title={t.name}
            right={
              <>
                {t.highlight ? <Badge tone="purple">Empfohlen</Badge> : null} {!t.active && <Badge>Aus</Badge>}
              </>
            }
            lead={t.description || undefined}
          >
            <div className="cma-chips" style={{ marginBottom: 8 }}>
              {t.billings.map((b: string) => (
                <Badge key={b} tone="blue">
                  {b === 'free' ? 'Kostenlos' : `${BILL[b]}: ${t.prices[b]?.text ?? ''}`}
                </Badge>
              ))}
              {t.trial_days > 0 && <Badge tone="green">{t.trial_days} Tage testen</Badge>}
            </div>
            <div className="muted small">
              {t.members} Mitglieder{t.course_ids.length ? ` · ${t.course_ids.length} Kurs(e)` : ''}
              {t.grace_days ? ` · ${t.grace_days} Tage Kulanz bei Zahlungsproblemen` : ''}
            </div>
            <div className="cma-actions">
              <button className="btn secondary" onClick={() => setEdit(t)}>
                Bearbeiten
              </button>
            </div>
          </Sec>
        ))}
        <Sec title="Neue Stufe" lead="Eine Stufe ist ein Zugang mit eigenem Preis: kostenlos, monatlich oder jährlich (mit Testphase) oder einmalig (lebenslang). Preise kommen aus deinen Produkten.">
          <button className="btn" onClick={() => setEdit({ name: '', description: '', features: [], course_ids: [], tags: [], active: 1, highlight: 0, grace_days: 0, trial_days: 0, product_id: '', annual_product_id: '' })}>
            + Stufe anlegen
          </button>
        </Sec>
      </div>
      {edit && <TierEditor group={group} data={data} tier={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), onSaved())} />}
    </>
  );
}

function TierEditor({ group, data, tier, onClose, onDone }: { group: any; data: any; tier: any; onClose: () => void; onDone: () => void }) {
  const courses = useCourses();
  const [f, setF] = useState<any>({ ...tier, product_id: tier.product_id ?? '', annual_product_id: tier.annual_product_id ?? '', features: tier.features ?? [], course_ids: tier.course_ids ?? [], tags: tier.tags ?? [] });
  const set = (patch: any) => setF((x: any) => ({ ...x, ...patch }));
  const rec = (kind: string) => data.products.filter((p: any) => p.price_cents > 0 && (kind === 'one' ? !p.recurring : p.recurring === kind));
  const save = async () => {
    const body = { name: f.name, description: f.description, features: f.features, course_ids: f.course_ids, tags: f.tags, active: f.active ? 1 : 0, highlight: f.highlight ? 1 : 0, grace_days: f.grace_days || 0, trial_days: f.trial_days || 0, product_id: f.product_id || null, annual_product_id: f.annual_product_id || null };
    if (await act(() => (tier.id ? api.patch(`/api/community/tiers/${tier.id}`, body) : api.post(`/api/community/groups/${group.id}/tiers`, body)), 'Gespeichert')) onDone();
  };
  const del = async () => {
    if (await confirmAsk(`Stufe „${tier.name}“ löschen?`)) if (await act(() => api.del(`/api/community/tiers/${tier.id}`), 'Gelöscht')) onDone();
  };
  const productLine = (p: any) => `${p.name} – ${euro(p.price_cents, p.currency)}${p.recurring === 'month' ? ' / Monat' : p.recurring === 'year' ? ' / Jahr' : ''}`;
  return (
    <Modal
      title={tier.id ? `Stufe „${tier.name}“` : 'Neue Stufe'}
      onClose={onClose}
      wide
      footer={
        <>
          {tier.id && (
            <button className="btn danger" onClick={del}>
              Löschen
            </button>
          )}
          <button className="btn" onClick={save} disabled={!f.name.trim()}>
            Speichern
          </button>
        </>
      }
    >
      <div className="cma">
        <Field label="Name">
          <Input value={f.name} onChange={(v) => set({ name: v })} placeholder="z. B. Pro" autoFocus />
        </Field>
        <Field label="Beschreibung (eine Zeile)">
          <Input value={f.description} onChange={(v) => set({ description: v })} />
        </Field>
        <Field label="Vorteile (eine pro Zeile, höchstens 8)">
          <Textarea rows={4} value={(f.features as string[]).join('\n')} onChange={(v) => set({ features: v.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8) })} />
        </Field>
        <h4 style={{ margin: '6px 0 0' }}>Preis</h4>
        <p className="muted small" style={{ margin: 0 }}>
          Ohne Produkt ist die Stufe kostenlos. Das Produkt legst du unter Verkaufen → Produkte an (Zahlungsweise monatlich, jährlich oder einmalig).
        </p>
        <div className="cma-two">
          <Field label="Produkt (monatlich oder einmalig)">
            <Select value={f.product_id} onChange={(v) => set({ product_id: v })} placeholder="Kostenlos" options={[...rec('month'), ...rec('one')].map((p: any) => [p.id, productLine(p)])} />
          </Field>
          <Field label="Jahres-Alternative (optional)">
            <Select value={f.annual_product_id} onChange={(v) => set({ annual_product_id: v })} placeholder="keine" options={rec('year').map((p: any) => [p.id, productLine(p)])} />
          </Field>
        </div>
        <div className="cma-two">
          <NumberField label="Kostenlose Testphase (Tage)" min={0} max={90} value={f.trial_days} onChange={(v) => set({ trial_days: v ?? 0 })} hint="Nur bei monatlicher oder jährlicher Zahlung." />
          <NumberField label="Kulanz bei Zahlungsproblemen (Tage)" min={0} max={30} value={f.grace_days} onChange={(v) => set({ grace_days: v ?? 0 })} hint="So lange bleibt der Zugang nach einer fehlgeschlagenen Zahlung offen." />
        </div>
        <Field label="Gibt Zugang zu diesen Kursen">
          <div className="cma-chips">
            {(courses.data ?? []).map((c: any) => (
              <label key={c.id} className={`cma-chip${f.course_ids.includes(c.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={f.course_ids.includes(c.id)} onChange={(e) => set({ course_ids: e.target.checked ? [...f.course_ids, c.id] : f.course_ids.filter((x: string) => x !== c.id) })} /> {c.title}
              </label>
            ))}
            {!courses.data?.length && <span className="muted small">Noch keine Kurse.</span>}
          </div>
        </Field>
        <Field label="Tags für Mitglieder dieser Stufe">
          <TagInput value={f.tags} onChange={(v) => set({ tags: v })} />
        </Field>
        <Check checked={!!f.highlight} onChange={(v) => set({ highlight: v ? 1 : 0 })} label="Als „Empfohlen“ hervorheben" />
        <Check checked={!!f.active} onChange={(v) => set({ active: v ? 1 : 0 })} label="Auf der Seite anbieten" />
      </div>
    </Modal>
  );
}

// --- requests & memberships ---------------------------------------------------------------------------------------------------------
function Requests({ group, onDone }: { group: any; onDone: () => void }) {
  const list = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/memberships?status=pending,awaiting_payment&limit=200`), [group.id]);
  const [reject, setReject] = useState<any>(null);
  const [note, setNote] = useState('');
  const act1 = async (m: any, body: any, ok: string) => (await run(() => api.patch(`/api/community/memberships/${m.id}`, body), ok, () => (void list.reload(), onDone())));
  if (!list.data) return <Spinner />;
  return (
    <>
      {list.data.length ? (
        <div className="cma-sec">
          <ul className="cma-list">
            {list.data.map((m) => (
              <li key={m.id}>
                <div className="grow">
                  <div>
                    <strong>{m.name || m.email}</strong> <span className="muted small">{m.email}</span> <StatusBadge status={m.status} />
                  </div>
                  <div className="muted small">
                    Stufe {m.tier_name || '–'} · angefragt {ago(m.requested_at)}
                    {m.coupon_code ? ` · Code ${m.coupon_code}` : ''}
                    {m.invite ? ` · Einladung „${m.invite}“` : ''}
                  </div>
                  {m.answers?.map((a: any) => (
                    <div key={a.question} className="small">
                      <span className="muted">{a.question}</span> → {a.answer}
                    </div>
                  ))}
                </div>
                {m.status === 'pending' ? (
                  <>
                    <button className="btn" onClick={() => act1(m, { action: 'approve' }, 'Freigegeben')}>
                      Freigeben
                    </button>
                    <button className="btn secondary" onClick={() => (setNote(''), setReject(m))}>
                      Ablehnen
                    </button>
                  </>
                ) : (
                  <span className="muted small">wartet auf Zahlung</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>Keine offenen Anfragen. Neue Anfragen erscheinen hier, sobald jemand die Beitritts-Seite ausfüllt (und du „Anfragen erst freigeben“ aktiviert hast).</Empty>
      )}
      {reject && (
        <Modal
          title={`Anfrage von ${reject.name || reject.email} ablehnen`}
          onClose={() => setReject(null)}
          footer={
            <button
              className="btn danger"
              onClick={async () => {
                if (await act1(reject, { action: 'reject', note }, 'Abgelehnt')) setReject(null);
              }}
            >
              Ablehnen
            </button>
          }
        >
          <Field label="Hinweis an die Person (wird mitgeschickt, freiwillig)">
            <Textarea rows={3} value={note} onChange={setNote} autoFocus />
          </Field>
        </Modal>
      )}
    </>
  );
}

function Memberships({ group, data, onDone }: { group: any; data: any; onDone: () => void }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/memberships?limit=300${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [group.id, status, q]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', tier_id: '' });
  const patch = (m: any, body: any, ok: string) => run(() => api.patch(`/api/community/memberships/${m.id}`, body), ok, () => (void list.reload(), onDone()));
  return (
    <>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div style={{ width: 240 }}>
          <Input value={q} onChange={setQ} placeholder="Name oder E-Mail …" />
        </div>
        <div style={{ width: 220 }}>
          <Select value={status} onChange={setStatus} placeholder="Alle Status" options={Object.entries(data.counts).map(([k, n]) => [k, `${k === 'active' ? 'Aktiv' : k === 'trialing' ? 'Testphase' : k === 'past_due' ? 'Zahlung offen' : k === 'canceled' ? 'Beendet' : k === 'rejected' ? 'Abgelehnt' : k === 'pending' ? 'Wartet auf Freigabe' : 'Wartet auf Zahlung'} (${n})`])} />
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          + Person hinzufügen
        </button>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length ? (
        <div className="table-wrap">
          <table className="t cma-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Stufe</th>
                <th>Status</th>
                <th>Seit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`contacts/${m.contact_id}`}>{m.name || m.email}</Link>
                    <div className="muted small">{m.email}</div>
                  </td>
                  <td>
                    <Select value={m.tier_id ?? ''} onChange={(v) => v && patch(m, { action: 'tier', tier_id: v }, 'Stufe geändert')} options={data.tiers.map((t: any) => [t.id, t.name])} placeholder="–" />
                  </td>
                  <td>
                    <StatusBadge status={m.status} />
                    {m.trial_ends_at && m.status === 'trialing' && <div className="muted small">bis {d(m.trial_ends_at)}</div>}
                    {m.left_reason && m.status === 'canceled' && <div className="muted small">{m.left_reason}</div>}
                  </td>
                  <td className="muted">{d(m.joined_at ?? m.requested_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {['active', 'trialing', 'past_due'].includes(m.status) ? (
                      <button className="btn small ghost" onClick={async () => (await confirmAsk(`${m.name || m.email} aus der Community nehmen?`)) && patch(m, { action: 'end' }, 'Zugang beendet')}>
                        Beenden
                      </button>
                    ) : m.status === 'canceled' ? (
                      <button className="btn small secondary" onClick={() => patch(m, { action: 'reactivate' }, 'Wieder aktiv')}>
                        Wieder freischalten
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Keine Mitgliedschaften.</Empty>
      )}
      {adding && (
        <Modal
          title="Person hinzufügen"
          onClose={() => setAdding(false)}
          footer={
            <button
              className="btn"
              disabled={!form.email.includes('@')}
              onClick={async () => {
                if (await act(() => api.post(`/api/community/groups/${group.id}/memberships`, { email: form.email, name: form.name, tier_id: form.tier_id || undefined }), 'Hinzugefügt')) {
                  setAdding(false);
                  void list.reload();
                  onDone();
                }
              }}
            >
              Hinzufügen
            </button>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Die Person wird sofort Mitglied (kostenlos, ohne Freigabe) und bekommt eine Mail mit dem Link zur Community.
          </p>
          <Field label="E-Mail-Adresse">
            <Input type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} autoFocus />
          </Field>
          <Field label="Name (freiwillig)">
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          </Field>
          <Field label="Stufe">
            <Select value={form.tier_id} onChange={(v) => setForm({ ...form, tier_id: v })} placeholder="Erste aktive Stufe" options={data.tiers.map((t: any) => [t.id, t.name])} />
          </Field>
        </Modal>
      )}
    </>
  );
}

// --- invites ------------------------------------------------------------------------------------------------------------------------
function Invites({ group, data }: { group: any; data: any }) {
  const list = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/invites`), [group.id]);
  const [f, setF] = useState<any>({ label: '', tier_id: '', skip_approval: false, trial_days: '', max_uses: '', expires_at: '' });
  const create = () =>
    run(
      () => api.post(`/api/community/groups/${group.id}/invites`, { label: f.label, tier_id: f.tier_id || null, skip_approval: f.skip_approval, trial_days: f.trial_days === '' ? null : Number(f.trial_days), max_uses: f.max_uses === '' ? null : Number(f.max_uses), expires_at: f.expires_at ? fromLocalInput(f.expires_at) : null }),
      'Link erstellt',
      () => (setF({ label: '', tier_id: '', skip_approval: false, trial_days: '', max_uses: '', expires_at: '' }), void list.reload()),
    );
  return (
    <div className="cma-grid">
      <Sec title="Neuer Einladungs-Link" lead="Jeder Link zeigt dir, wer darüber kam und ob die Person bezahlt hat – ideal für Partner, Newsletter oder Social-Media-Beiträge.">
        <Field label="Bezeichnung (nur für dich)">
          <Input value={f.label} onChange={(v) => setF({ ...f, label: v })} placeholder="z. B. Instagram-Bio" />
        </Field>
        <Field label="Stufe">
          <Select value={f.tier_id} onChange={(v) => setF({ ...f, tier_id: v })} placeholder="Wie auf der Seite gewählt" options={data.tiers.map((t: any) => [t.id, t.name])} />
        </Field>
        <div className="cma-two">
          <NumberField label="Eigene Testphase (Tage)" min={0} max={365} value={f.trial_days === '' ? null : Number(f.trial_days)} onChange={(v) => setF({ ...f, trial_days: v ?? '' })} />
          <NumberField label="Höchstens so oft nutzbar" min={1} value={f.max_uses === '' ? null : Number(f.max_uses)} onChange={(v) => setF({ ...f, max_uses: v ?? '' })} />
        </div>
        <Field label="Läuft ab (freiwillig)">
          <Input type="datetime-local" value={f.expires_at} onChange={(v) => setF({ ...f, expires_at: v })} />
        </Field>
        <Check checked={f.skip_approval} onChange={(v) => setF({ ...f, skip_approval: v })} label="Ohne Freigabe aufnehmen" />
        <div className="cma-actions">
          <button className="btn" onClick={create}>
            Link erstellen
          </button>
        </div>
      </Sec>
      <Sec title="Deine Links">
        {!list.data ? (
          <Spinner />
        ) : list.data.length ? (
          <ul className="cma-list">
            {list.data.map((i) => (
              <li key={i.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="row" style={{ alignItems: 'center' }}>
                  <div className="grow">
                    <strong>{i.label || i.code}</strong> {!i.active && <Badge>Aus</Badge>}
                    <div className="muted small">
                      {i.members} Mitglieder{i.pending ? ` · ${i.pending} offen` : ''}
                      {i.max_uses ? ` · ${i.uses}/${i.max_uses} genutzt` : ''}
                      {i.expires_at ? ` · bis ${d(i.expires_at)}` : ''}
                    </div>
                  </div>
                  <button className="btn small secondary" onClick={() => run(() => api.patch(`/api/community/invites/${i.id}`, { active: !i.active }), i.active ? 'Ausgeschaltet' : 'Eingeschaltet', () => void list.reload())}>
                    {i.active ? 'Ausschalten' : 'Einschalten'}
                  </button>
                  <button className="btn small ghost" aria-label="Link löschen" onClick={async () => (await confirmAsk('Link löschen?')) && run(() => api.del(`/api/community/invites/${i.id}`), 'Gelöscht', () => void list.reload())}>
                    ✕
                  </button>
                </div>
                {i.url && <CopyField value={i.url} label="Link" />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Noch keine Links.</p>
        )}
      </Sec>
    </div>
  );
}

// --- discount codes --------------------------------------------------------------------------------------------------------------------
function Coupons({ group, data }: { group: any; data: any }) {
  const list = useLoad(() => api.get<any[]>(`/api/community/groups/${group.id}/coupons`), [group.id]);
  const blank = { code: '', label: '', kind: 'percent', value: '20', duration: 'once', months: '3', max_uses: '', expires_at: '', tier_id: '' };
  const [f, setF] = useState<any>(blank);
  const create = () =>
    run(
      () =>
        api.post(`/api/community/groups/${group.id}/coupons`, {
          code: f.code,
          label: f.label,
          kind: f.kind,
          ...(f.kind === 'percent' ? { percent_off: Number(f.value) } : { amount_off_cents: Math.round(Number(String(f.value).replace(',', '.')) * 100) }),
          duration: f.duration,
          months: Number(f.months),
          max_uses: f.max_uses === '' ? null : Number(f.max_uses),
          expires_at: f.expires_at ? fromLocalInput(f.expires_at) : null,
          tier_id: f.tier_id || null,
        }),
      'Code erstellt',
      () => (setF(blank), void list.reload()),
    );
  return (
    <div className="cma-grid">
      <Sec title="Neuer Rabattcode" lead="Gilt für bezahlte Stufen mit monatlicher oder jährlicher Zahlung. Der Rabatt wird im Stripe-Checkout abgezogen.">
        {!data.stripe.connected && <div className="cma-note">Stripe ist noch nicht verbunden – Rabattcodes wirken erst mit Stripe.</div>}
        <div className="cma-two">
          <Field label="Code">
            <Input value={f.code} onChange={(v) => setF({ ...f, code: v.toUpperCase() })} placeholder="WILLKOMMEN20" />
          </Field>
          <Field label="Bezeichnung (freiwillig)">
            <Input value={f.label} onChange={(v) => setF({ ...f, label: v })} />
          </Field>
        </div>
        <div className="cma-two">
          <Field label="Rabatt">
            <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[['percent', 'Prozent'], ['amount', 'Betrag in Euro']]} />
          </Field>
          <Field label={f.kind === 'percent' ? 'Prozent' : 'Euro'}>
            <Input value={f.value} onChange={(v) => setF({ ...f, value: v })} inputMode="decimal" />
          </Field>
        </div>
        <div className="cma-two">
          <Field label="Wie lange">
            <Select value={f.duration} onChange={(v) => setF({ ...f, duration: v })} options={[['once', 'Nur die erste Zahlung'], ['repeating', 'Mehrere Monate'], ['forever', 'Für immer']]} />
          </Field>
          {f.duration === 'repeating' && <NumberField label="Monate" min={1} max={36} value={Number(f.months)} onChange={(v) => setF({ ...f, months: String(v ?? 3) })} />}
        </div>
        <div className="cma-two">
          <NumberField label="Höchstens so oft nutzbar" min={1} value={f.max_uses === '' ? null : Number(f.max_uses)} onChange={(v) => setF({ ...f, max_uses: v ?? '' })} />
          <Field label="Läuft ab (freiwillig)">
            <Input type="datetime-local" value={f.expires_at} onChange={(v) => setF({ ...f, expires_at: v })} />
          </Field>
        </div>
        <Field label="Nur für diese Stufe">
          <Select value={f.tier_id} onChange={(v) => setF({ ...f, tier_id: v })} placeholder="Alle bezahlten Stufen" options={data.tiers.filter((t: any) => !t.prices.free).map((t: any) => [t.id, t.name])} />
        </Field>
        <div className="cma-actions">
          <button className="btn" onClick={create} disabled={!f.code.trim()}>
            Code erstellen
          </button>
        </div>
      </Sec>
      <Sec title="Deine Codes">
        {!list.data ? (
          <Spinner />
        ) : list.data.length ? (
          <ul className="cma-list">
            {list.data.map((c) => (
              <li key={c.id}>
                <div className="grow">
                  <div>
                    <strong className="cma-mono">{c.code}</strong> {!c.active && <Badge>Aus</Badge>}
                  </div>
                  <div className="muted small">
                    {c.text} · {c.uses}
                    {c.max_uses ? `/${c.max_uses}` : ''} genutzt{c.expires_at ? ` · bis ${d(c.expires_at)}` : ''}
                  </div>
                </div>
                <button className="btn small secondary" onClick={() => run(() => api.patch(`/api/community/coupons/${c.id}`, { active: !c.active }), c.active ? 'Ausgeschaltet' : 'Eingeschaltet', () => void list.reload())}>
                  {c.active ? 'Ausschalten' : 'Einschalten'}
                </button>
                <button className="btn small ghost" aria-label="Code löschen" onClick={async () => (await confirmAsk(`Code ${c.code} löschen?`)) && run(() => api.del(`/api/community/coupons/${c.id}`), 'Gelöscht', () => void list.reload())}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Noch keine Codes.</p>
        )}
      </Sec>
    </div>
  );
}

