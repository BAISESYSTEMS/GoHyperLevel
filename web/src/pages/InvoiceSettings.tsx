import { useEffect, useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { MoreFields, SimpleOnly } from '../areas/fields';

/**
 * Settings → Rechnungen: who sends the invoice (the mandatory seller data), bank, tax defaults, the checks before finalising,
 * the e-invoice and the number ranges (gap-free, per document type).
 */

const RANGE_ORDER = ['invoice', 'credit', 'storno', 'estimate'] as const;

type Range = { label: string; prefix: string; with_year: boolean; year_reset: boolean; digits: number; start: number; last: number | null; next: number; example: string };

const exampleOf = (r: { prefix: string; with_year: boolean; digits: number }, n: number) => `${r.prefix}${r.with_year ? `${new Date().getFullYear()}-` : ''}${r.digits > 0 ? String(n).padStart(r.digits, '0') : n}`;

export function InvoiceSettings() {
  const cfg = useLoad(() => api.get<any>('/api/invoice-settings'), []);
  const [s, setS] = useState<any>();
  const [ranges, setRanges] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!cfg.data) return;
    setS(cfg.data.settings ?? {});
    setRanges(Object.fromEntries(RANGE_ORDER.map((k) => [k, { ...cfg.data.ranges[k], next: String(cfg.data.ranges[k].next) }])));
  }, [cfg.data]);
  if (!s || !cfg.data) return <Spinner />;
  const set = (p: any) => setS({ ...s, ...p });
  const setRange = (k: string, p: any) => setRanges({ ...ranges, [k]: { ...ranges[k], ...p } });
  const modes: any[] = cfg.data.tax_modes;

  const save = async () => {
    const body = {
      ...s,
      ranges: Object.fromEntries(
        RANGE_ORDER.map((k) => {
          const r = ranges[k] as Range & { next: string };
          const was = cfg.data.ranges[k];
          // the next number is only sent when it was changed (it can only move forward)
          return [k, { prefix: r.prefix, with_year: r.with_year, year_reset: r.year_reset, digits: Number(r.digits), start: Number(r.start), ...(String(r.next) !== String(was.next) ? { next: Number(r.next) } : {}) }];
        }),
      ),
    };
    const r = await act(() => api.put<any>('/api/invoice-settings', body), 'Gespeichert');
    if (r) cfg.setData(r);
  };

  return (
    <div style={{ maxWidth: 760 }} data-tour="settings-billing">
      <div className="card">
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Absender auf Rechnungen</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Das sind Pflichtangaben nach § 14 UStG – und für die XRechnung. Firmenname, E-Mail und Telefon kommen aus „Firma“.
        </p>
        <Field label="Straße und Hausnummer">
          <Input value={s.street} onChange={(v) => set({ street: v })} />
        </Field>
        <div className="grid3">
          <Field label="PLZ">
            <Input value={s.postal_code} onChange={(v) => set({ postal_code: v })} />
          </Field>
          <Field label="Ort">
            <Input value={s.city} onChange={(v) => set({ city: v })} />
          </Field>
          <Field label="Land" hint="Name oder Kürzel, z. B. DE">
            <Input value={s.country} onChange={(v) => set({ country: v })} placeholder="DE" />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Steuernummer" hint="vom Finanzamt, z. B. 12/345/67890">
            <Input value={s.tax_number} onChange={(v) => set({ tax_number: v })} />
          </Field>
          <Field label="USt-IdNr." hint="nötig bei Reverse Charge und innergemeinschaftlichen Lieferungen">
            <Input value={s.vat_id} onChange={(v) => set({ vat_id: v })} placeholder="DE123456789" />
          </Field>
        </div>
        <MoreFields id="invoice-sender" values={[s.contact_name, s.contact_email, s.contact_phone, s.footer]}>
        <div className="grid2">
          <Field label="Ansprechpartner (für die XRechnung)">
            <Input value={s.contact_name} onChange={(v) => set({ contact_name: v })} />
          </Field>
          <Field label="E-Mail des Ansprechpartners">
            <Input value={s.contact_email} onChange={(v) => set({ contact_email: v })} />
          </Field>
          <Field label="Telefon des Ansprechpartners">
            <Input value={s.contact_phone} onChange={(v) => set({ contact_phone: v })} />
          </Field>
        </div>
        <Field label="Fußzeile">
          <Input value={s.footer} onChange={(v) => set({ footer: v })} placeholder="Geschäftsführer, Registergericht, Handelsregisternummer …" />
        </Field>
        </MoreFields>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Bank</h3>
        <div className="grid2">
          <Field label="Bank">
            <Input value={s.bank} onChange={(v) => set({ bank: v })} />
          </Field>
          <Field label="IBAN" tour="settings-iban" hint="steht auf der Rechnung und im GiroCode (QR zum Überweisen)">
            <Input value={s.iban} onChange={(v) => set({ iban: v })} />
          </Field>
          <Field label="BIC">
            <Input value={s.bic} onChange={(v) => set({ bic: v })} />
          </Field>
        </div>
        <MoreFields id="invoice-bank" values={[s.paypal]}>
          <Field label="PayPal.me-Name (optional)">
            <Input value={s.paypal} onChange={(v) => set({ paypal: v })} />
          </Field>
        </MoreFields>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Steuer und Zahlung</h3>
        <div className="grid2">
          <Field label="Standard-USt %">
            <Input type="number" value={s.tax_rate ?? 19} onChange={(v) => set({ tax_rate: Number(v) })} />
          </Field>
          <Field label="Zahlungsziel (Tage)">
            <Input type="number" value={s.payment_terms_days ?? 14} onChange={(v) => set({ payment_terms_days: Number(v) })} />
          </Field>
        </div>
        <Check checked={!!s.small_business} onChange={(v) => set({ small_business: v, ...(v ? { default_tax_mode: 'small_business' } : s.default_tax_mode === 'small_business' ? { default_tax_mode: 'standard' } : {}) })} label="Kleinunternehmer (§ 19 UStG) – ohne Umsatzsteuer, mit Pflichthinweis" />
        <MoreFields id="invoice-taxmode" values={[(s.default_tax_mode ?? 'standard') !== 'standard' && s.default_tax_mode !== 'small_business']}>
          <div style={{ maxWidth: 360 }}>
            <Field label="Steuerbehandlung neuer Rechnungen" hint="Jede Rechnung lässt sich einzeln umstellen; der Pflichttext kommt automatisch.">
              <Select value={s.default_tax_mode ?? 'standard'} onChange={(v) => set({ default_tax_mode: v })} options={modes.map((m) => [m.key, m.label] as [string, string])} />
            </Field>
          </div>
        </MoreFields>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Beim Festschreiben und Senden</h3>
        <Check checked={s.attach_pdf !== false} onChange={(v) => set({ attach_pdf: v })} label="Rechnungs-PDF an die E-Mail anhängen" />
        <MoreFields id="invoice-einvoice" label="E-Rechnung und Prüfungen" values={[s.finalise_strict, s.vies_check, s.attach_zugferd, s.attach_xrechnung, (s.einvoice_syntax ?? 'cii') !== 'cii']}>
        <Check checked={!!s.finalise_strict} onChange={(v) => set({ finalise_strict: v })} label="Streng prüfen: ohne vollständige Absenderdaten (Anschrift, Steuernummer oder USt-IdNr.) nicht festschreiben" />
        <Check checked={!!s.vies_check} onChange={(v) => set({ vies_check: v })} label="USt-IdNr. des Kunden beim EU-Dienst VIES prüfen (Reverse Charge, innergemeinschaftliche Lieferung)" />
        <Check checked={!!s.attach_zugferd} onChange={(v) => set({ attach_zugferd: v })} label="ZUGFeRD-PDF statt einfachem PDF anhängen (E-Rechnung im PDF, EN 16931)" />
        <Check checked={!!s.attach_xrechnung} onChange={(v) => set({ attach_xrechnung: v })} label="XRechnung (XML) zusätzlich anhängen" />
        <div style={{ maxWidth: 320, marginTop: 8 }}>
          <Field label="Format der XRechnung">
            <Select value={s.einvoice_syntax ?? 'cii'} onChange={(v) => set({ einvoice_syntax: v })} options={[['cii', 'CII (wie ZUGFeRD / Factur-X)'], ['ubl', 'UBL 2.1 (Peppol)']]} />
          </Field>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Festgeschriebene Rechnungen und ihre XRechnung bzw. ihr ZUGFeRD-PDF werden unveränderlich archiviert (SHA-256), Aufbewahrung 8 Jahre.
        </p>
        </MoreFields>
      </div>

      <div className="card" style={{ marginTop: 12 }} data-tour="settings-ranges">
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Nummernkreise</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Eine Nummer wird erst beim Festschreiben vergeben – fortlaufend, ohne Lücken. Die nächste Nummer lässt sich nur erhöhen.
        </p>
        <SimpleOnly>
          <ul className="muted small" style={{ margin: '0 0 4px', paddingLeft: 18 }}>
            {RANGE_ORDER.map((k) => ranges[k] && <li key={k}>{ranges[k].label}: {exampleOf(ranges[k], Number(ranges[k].next) || 0)}</li>)}
          </ul>
        </SimpleOnly>
        <MoreFields id="invoice-ranges" label="Nummernkreise anpassen">
        {RANGE_ORDER.map((k) => {
          const r = ranges[k];
          if (!r) return null;
          return (
            <div key={k} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
              <strong>{r.label}</strong> <span className="muted small">· nächste Nummer: {exampleOf(r, Number(r.next) || 0)}</span>
              <div className="grid3" style={{ marginTop: 6 }}>
                <Field label="Präfix">
                  <Input value={r.prefix} onChange={(v) => setRange(k, { prefix: v })} />
                </Field>
                <Field label="Stellen (0 = keine Füllnullen)">
                  <Input type="number" value={r.digits} onChange={(v) => setRange(k, { digits: v })} />
                </Field>
                <Field label="Nächste Nummer" hint={r.last ? `zuletzt vergeben: ${r.last}` : 'noch keine vergeben'}>
                  <Input type="number" value={r.next} onChange={(v) => setRange(k, { next: v })} />
                </Field>
              </div>
              <Check checked={!!r.with_year} onChange={(v) => setRange(k, { with_year: v, ...(v ? {} : { year_reset: false }) })} label="Jahreszahl in der Nummer (RE-2026-1001)" />
              <Check checked={!!r.year_reset} onChange={(v) => setRange(k, { year_reset: v, ...(v ? { with_year: true } : {}) })} label="Jedes Jahr neu bei der Startnummer beginnen" />
              {r.year_reset && (
                <Field label="Startnummer (jedes Jahr)">
                  <Input type="number" value={r.start} onChange={(v) => setRange(k, { start: v })} />
                </Field>
              )}
            </div>
          );
        })}
        </MoreFields>
      </div>

      <div className="actions" style={{ marginTop: 12 }}>
        <button
          className="btn"
          onClick={() => {
            const moved = RANGE_ORDER.some((k) => String(ranges[k]?.next) !== String(cfg.data.ranges[k].next));
            if (moved && !confirmAsk('Du hast eine „nächste Nummer“ geändert. Übersprungene Nummern bleiben unbenutzt – das lässt sich nicht zurückdrehen. Speichern?')) return;
            void save();
          }}
        >
          Speichern
        </button>
      </div>
    </div>
  );
}
