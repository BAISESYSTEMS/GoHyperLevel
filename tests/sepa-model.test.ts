import { describe, expect, it } from 'vitest';
import { allAt, at, parseXml, textAt } from '../server/services/xml-lite.js';
import {
  addTargetDays,
  cleanSettings,
  creditorIdCheck,
  earliestCollection,
  effectiveStatus,
  expiresOn,
  ibanInfo,
  isTargetDay,
  mandateText,
  maskIban,
  nextSeq,
  nextTargetDay,
  refCheck,
  statusAfter,
  textHash,
} from '../server/services/sepa-model.js';
import { NS, creditTransferXml, directDebitXml, groupDebits, sepaId, type DebitTx } from '../server/services/sepa-xml.js';

describe('SEPA checks', () => {
  it('validates creditor identifiers including the check digits', () => {
    expect(creditorIdCheck('DE98ZZZ09999999999')).toMatchObject({ valid: true, normalized: 'DE98ZZZ09999999999' });
    expect(creditorIdCheck(' de98 zzz0 9999 9999 99 ').valid).toBe(true);
    // the business code is not part of the check
    expect(creditorIdCheck('DE98ABC09999999999').valid).toBe(true);
    expect(creditorIdCheck('AT61ZZZ01234567890').valid).toBe(true);
    const wrong = creditorIdCheck('DE97ZZZ09999999999');
    expect(wrong.valid).toBe(false);
    expect(wrong.reason).toContain('erwartet 98');
    expect(creditorIdCheck('DE98ZZZ0999999999').reason).toContain('18 Stellen');
    expect(creditorIdCheck('US98ZZZ09999999999').valid).toBe(false);
    expect(creditorIdCheck('').valid).toBe(false);
  });

  it('checks IBANs with mod 97, SEPA countries and when a BIC is needed', () => {
    expect(ibanInfo('DE89 3704 0044 0532 0130 00')).toMatchObject({ ok: true, iban: 'DE89370400440532013000', country: 'DE', bicRequired: false });
    expect(ibanInfo('DE89370400440532013001').ok).toBe(false);
    expect(ibanInfo('CH9300762011623852957')).toMatchObject({ ok: true, bicRequired: true });
    expect(ibanInfo('GB29NWBK60161331926819')).toMatchObject({ ok: true, bicRequired: true });
    expect(ibanInfo('').reason).toBe('IBAN fehlt');
    expect(maskIban('DE89370400440532013000')).toBe('DE89 •••• 3000');
  });

  it('accepts only SEPA characters in mandate references', () => {
    expect(refCheck('M-2026-000001').valid).toBe(true);
    expect(refCheck("A+B?C/D:E(F).G,H'I").valid).toBe(true);
    expect(refCheck('M 1').valid).toBe(false);
    expect(refCheck('Müller-1').valid).toBe(false);
    expect(refCheck('/M1').valid).toBe(false);
    expect(refCheck('M//1').valid).toBe(false);
    expect(refCheck('x'.repeat(36)).valid).toBe(false);
  });

  it('turns text into SEPA identifiers', () => {
    expect(sepaId('RE 2026/0001')).toBe('RE-2026/0001');
    expect(sepaId('//Größe')).toBe('Groesse');
    expect(sepaId('')).toBe('NOTPROVIDED');
    expect(sepaId('x'.repeat(50))).toHaveLength(35);
  });
});

describe('sequence types and lifetime', () => {
  it('goes FRST → RCUR, one-off is OOFF, the marked last one is FNAL', () => {
    expect(nextSeq({ kind: 'RCUR' }, false)).toBe('FRST');
    expect(nextSeq({ kind: 'RCUR' }, true)).toBe('RCUR');
    expect(nextSeq({ kind: 'RCUR', final_next: 1 }, true)).toBe('FNAL');
    // a final flag before the first collection still needs a FRST
    expect(nextSeq({ kind: 'RCUR', final_next: 1 }, false)).toBe('FRST');
    expect(nextSeq({ kind: 'OOFF' }, false)).toBe('OOFF');
    expect(statusAfter('OOFF', 'active')).toBe('used');
    expect(statusAfter('FNAL', 'active')).toBe('final');
    expect(statusAfter('RCUR', 'active')).toBe('active');
  });

  it('expires a mandate after 36 months without a collection', () => {
    expect(expiresOn({ signed_at: '2023-10-05' })).toBe('2026-10-05');
    expect(expiresOn({ signed_at: '2020-01-01', last_used_at: '2024-02-29' })).toBe('2027-02-28');
    expect(effectiveStatus({ status: 'active', signed_at: '2023-10-05' }, '2026-10-04')).toBe('active');
    expect(effectiveStatus({ status: 'active', signed_at: '2023-10-05' }, '2026-10-05')).toBe('expired');
    expect(effectiveStatus({ status: 'revoked', signed_at: '2010-01-01' }, '2026-10-05')).toBe('revoked');
  });

  it('knows TARGET2 business days', () => {
    expect(isTargetDay('2026-10-05')).toBe(true); // Monday
    expect(isTargetDay('2026-10-10')).toBe(false); // Saturday
    expect(isTargetDay('2026-04-03')).toBe(false); // Good Friday
    expect(isTargetDay('2026-04-06')).toBe(false); // Easter Monday
    expect(isTargetDay('2026-05-01')).toBe(false);
    expect(isTargetDay('2026-12-25')).toBe(false);
    expect(isTargetDay('2026-12-24')).toBe(true);
    expect(nextTargetDay('2026-12-25')).toBe('2026-12-28');
    expect(addTargetDays('2026-10-09', 1)).toBe('2026-10-12');
    // 14 days of pre-notification from a Monday land on a Monday
    expect(earliestCollection('2026-10-05', 14)).toBe('2026-10-19');
    // one day (agreed in the mandate) is still at least the next business day
    expect(earliestCollection('2026-10-09', 1)).toBe('2026-10-12');
  });
});

describe('mandate text', () => {
  const base = { creditor_name: 'Muster GmbH', creditor_address: 'Musterstraße 1, 10115 Berlin', creditor_id: 'DE98ZZZ09999999999', reference: 'M-2026-000001', prenotify_days: 14 };
  it('has the legally required wording for CORE and B2B', () => {
    const core = mandateText({ ...base, scheme: 'CORE', kind: 'RCUR' });
    expect(core).toContain('SEPA-Lastschriftmandat');
    expect(core).toContain('Ich ermächtige Muster GmbH, Zahlungen von meinem Konto mittels Lastschrift einzuziehen');
    expect(core).toContain('innerhalb von acht Wochen');
    expect(core).toContain('Gläubiger-Identifikationsnummer: DE98ZZZ09999999999');
    expect(core).toContain('Mandatsreferenz: M-2026-000001');
    const b2b = mandateText({ ...base, scheme: 'B2B', kind: 'RCUR' });
    expect(b2b).toContain('SEPA-Firmenlastschrift-Mandat');
    expect(b2b).toContain('nicht berechtigt, nach der erfolgten Einlösung eine Erstattung');
    expect(mandateText({ ...base, scheme: 'CORE', kind: 'OOFF' })).toContain('eine Zahlung von meinem Konto');
  });

  it('states a shortened pre-notification period', () => {
    expect(mandateText({ ...base, scheme: 'CORE', kind: 'RCUR', prenotify_days: 5 })).toContain('auf 5 Tage verkürzt');
    expect(mandateText({ ...base, scheme: 'CORE', kind: 'RCUR', prenotify_days: 1 })).toContain('auf 1 Tag verkürzt');
    expect(mandateText({ ...base, scheme: 'CORE', kind: 'RCUR' })).not.toContain('verkürzt');
  });

  it('hashes the text whitespace-insensitively', () => {
    expect(textHash('a  b\n c')).toBe(textHash('a b c'));
    expect(textHash('a b c')).toMatch(/^[0-9a-f]{64}$/);
    expect(textHash('a b c')).not.toBe(textHash('a b d'));
  });

  it('cleans settings: creditor id with check digits, lead time 1–60 days', () => {
    expect(() => cleanSettings({ creditor_id: 'DE97ZZZ09999999999' })).toThrow(/Prüfziffern/);
    expect(cleanSettings({ creditor_id: 'de98zzz09999999999' }).creditor_id).toBe('DE98ZZZ09999999999');
    expect(() => cleanSettings({ prenotify_days: 0 })).toThrow(/zwischen 1 und 60/);
    expect(cleanSettings({ prenotify_days: 1 }).prenotify_days).toBe(1);
    expect(cleanSettings({}).prenotify_days).toBe(14);
    expect(() => cleanSettings({ iban: 'DE00' })).toThrow(/IBAN/);
  });
});

describe('pain.008.001.08', () => {
  const debtor = (name: string, bic = '') => ({ name, iban: 'DE89370400440532013000', bic });
  const tx = (over: Partial<DebitTx>): DebitTx => ({ endToEndId: 'RE-1', amount_cents: 1000, mandateId: 'M-1', mandateDate: '2026-01-15', seq: 'FRST', scheme: 'CORE', collectionDate: '2026-10-19', debtor: debtor('Max'), remittance: 'Rechnung RE-1', ...over });
  const file = directDebitXml({
    creditor: { name: 'Muster & Söhne GmbH', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', creditorId: 'DE98ZZZ09999999999' },
    msgId: 'GH20261005120000abcd',
    at: new Date('2026-10-05T12:00:00Z'),
    txs: [
      tx({ endToEndId: 'RE-2026-0001', amount_cents: 11900, mandateId: 'M-2026-000001' }),
      tx({ endToEndId: 'RE-2026-0002', amount_cents: 2550, mandateId: 'M-2026-000002', debtor: { ...debtor('Erika Müller', 'COBADEFFXXX'), street: 'Weg 1', postal_code: '10115', city: 'Berlin', country: 'DE' } }),
      tx({ endToEndId: 'RE-2026-0003', amount_cents: 4999, seq: 'RCUR', mandateId: 'M-2026-000003' }),
      tx({ endToEndId: 'RE-2026-0004', amount_cents: 100, seq: 'RCUR', scheme: 'B2B', mandateId: 'M-2026-000004' }),
    ],
  });
  const doc = parseXml(file.xml);
  const root = at(doc, 'CstmrDrctDbtInitn');

  it('has the namespace, the header and correct control sums', () => {
    expect(file.xml).toContain(`<Document xmlns="${NS.pain008_08}"`);
    expect(file.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(doc.name).toBe('Document');
    expect(textAt(root, 'GrpHdr/MsgId')).toBe('GH20261005120000abcd');
    expect(textAt(root, 'GrpHdr/CreDtTm')).toBe('2026-10-05T12:00:00');
    expect(textAt(root, 'GrpHdr/NbOfTxs')).toBe('4');
    expect(textAt(root, 'GrpHdr/CtrlSum')).toBe('195.49');
    expect(textAt(root, 'GrpHdr/InitgPty/Nm')).toBe('Muster Soehne GmbH');
    const blocks = allAt(root, 'PmtInf');
    const sum = blocks.reduce((n, b) => n + Math.round(Number(textAt(b, 'CtrlSum')) * 100), 0);
    expect(sum).toBe(19549);
    for (const b of blocks) {
      const txs = allAt(b, 'DrctDbtTxInf');
      expect(textAt(b, 'NbOfTxs')).toBe(String(txs.length));
      expect(Math.round(Number(textAt(b, 'CtrlSum')) * 100)).toBe(txs.reduce((n, t) => n + Math.round(Number(textAt(t, 'InstdAmt')) * 100), 0));
    }
  });

  it('groups by scheme, sequence type and date', () => {
    const blocks = allAt(root, 'PmtInf');
    expect(blocks.map((b) => `${textAt(b, 'PmtTpInf/LclInstrm/Cd')}/${textAt(b, 'PmtTpInf/SeqTp')}/${allAt(b, 'DrctDbtTxInf').length}`)).toEqual(['B2B/RCUR/1', 'CORE/FRST/2', 'CORE/RCUR/1']);
    expect(blocks.map((b) => textAt(b, 'PmtInfId'))).toEqual(['GH20261005120000abcd-1', 'GH20261005120000abcd-2', 'GH20261005120000abcd-3']);
    for (const b of blocks) {
      expect(textAt(b, 'PmtMtd')).toBe('DD');
      expect(textAt(b, 'ReqdColltnDt')).toBe('2026-10-19');
      expect(textAt(b, 'PmtTpInf/SvcLvl/Cd')).toBe('SEPA');
      expect(textAt(b, 'CdtrSchmeId/Id/PrvtId/Othr/Id')).toBe('DE98ZZZ09999999999');
      expect(textAt(b, 'CdtrSchmeId/Id/PrvtId/Othr/SchmeNm/Prtry')).toBe('SEPA');
      expect(textAt(b, 'CdtrAgt/FinInstnId/BICFI')).toBe('BYLADEM1001');
      expect(textAt(b, 'ChrgBr')).toBe('SLEV');
    }
    expect(groupDebits([tx({ collectionDate: '2026-11-02' }), tx({ collectionDate: '2026-10-20' })]).map((g) => g.collectionDate)).toEqual(['2026-10-20', '2026-11-02']);
  });

  it('writes mandate data, the invoice number as EndToEndId and the debtor', () => {
    const all = allAt(root, 'PmtInf').flatMap((b) => allAt(b, 'DrctDbtTxInf'));
    const one = all.find((t) => textAt(t, 'PmtId/EndToEndId') === 'RE-2026-0002')!;
    expect(textAt(one, 'InstdAmt')).toBe('25.50');
    expect(at(one, 'InstdAmt')!.attrs.Ccy).toBe('EUR');
    expect(textAt(one, 'DrctDbtTx/MndtRltdInf/MndtId')).toBe('M-2026-000002');
    expect(textAt(one, 'DrctDbtTx/MndtRltdInf/DtOfSgntr')).toBe('2026-01-15');
    expect(textAt(one, 'DbtrAgt/FinInstnId/BICFI')).toBe('COBADEFFXXX');
    expect(textAt(one, 'Dbtr/Nm')).toBe('Erika Mueller');
    expect(textAt(one, 'Dbtr/PstlAdr/TwnNm')).toBe('Berlin');
    expect(textAt(one, 'Dbtr/PstlAdr/Ctry')).toBe('DE');
    expect(textAt(one, 'DbtrAcct/Id/IBAN')).toBe('DE89370400440532013000');
    const noBic = all.find((t) => textAt(t, 'PmtId/EndToEndId') === 'RE-2026-0001')!;
    expect(textAt(noBic, 'DbtrAgt/FinInstnId/Othr/Id')).toBe('NOTPROVIDED');
    expect(at(noBic, 'Dbtr/PstlAdr')).toBeUndefined();
  });
});

describe('pain.001', () => {
  const lines = [
    { endToEndId: 'ER-77', name: 'Lieferant AG', iban: 'DE89370400440532013000', amount_cents: 12345, remittance: 'Rechnung ER-77' },
    { endToEndId: 'P-2', name: 'Zürich Partner', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A', amount_cents: 5, remittance: 'Provision' },
    { endToEndId: 'P-3', name: 'Null', iban: 'DE89370400440532013000', amount_cents: 0, remittance: 'leer' },
  ];
  it('writes pain.001.001.09 with BICFI and the date choice', () => {
    const xml = creditTransferXml({ debtor: { name: 'Muster GmbH', iban: 'DE02120300000000202051' }, msgId: 'T1', executionDate: '2026-10-06', lines, at: new Date('2026-10-05T08:00:00Z') });
    const doc = parseXml(xml);
    expect(doc.name).toBe('Document');
    const root = at(doc, 'CstmrCdtTrfInitn');
    expect(xml).toContain(`xmlns="${NS.pain001_09}"`);
    expect(textAt(root, 'GrpHdr/NbOfTxs')).toBe('2');
    expect(textAt(root, 'GrpHdr/CtrlSum')).toBe('123.50');
    expect(textAt(root, 'PmtInf/ReqdExctnDt/Dt')).toBe('2026-10-06');
    expect(textAt(root, 'PmtInf/DbtrAgt/FinInstnId/Othr/Id')).toBe('NOTPROVIDED');
    const txs = allAt(root, 'PmtInf/CdtTrfTxInf');
    expect(txs.map((t) => textAt(t, 'PmtId/EndToEndId'))).toEqual(['ER-77', 'P-2']);
    expect(textAt(txs[1], 'CdtrAgt/FinInstnId/BICFI')).toBe('UBSWCHZH80A');
    expect(textAt(txs[1], 'Cdtr/Nm')).toBe('Zuerich Partner');
  });

  it('still writes the legacy pain.001.001.03 the affiliate export uses', () => {
    const xml = creditTransferXml({ version: '001.001.03', debtor: { name: 'A', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' }, msgId: 'A1', executionDate: '2026-10-06', lines });
    expect(xml).toContain(`xmlns="${NS.pain001_03}"`);
    expect(xml).toContain('<ReqdExctnDt>2026-10-06</ReqdExctnDt>');
    expect(xml).toContain('<BIC>BYLADEM1001</BIC>');
    expect(xml).not.toContain('BICFI');
  });
});
