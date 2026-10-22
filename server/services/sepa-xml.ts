/**
 * ISO 20022 files for SEPA, written by hand (no dependency): credit transfers (pain.001.001.09 – and the older
 * pain.001.001.03 the affiliate payout export still writes) and direct debits (pain.008.001.08, the versions of the
 * DK "Anlage 3" since November 2023). Pure functions: amounts in cents in, control sums computed here, text reduced to
 * the SEPA character set. Shared by the SEPA module (docs/sepa.md) and the affiliate payouts (services/affiliates.ts).
 */

export const NS = {
  pain001_03: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03',
  pain001_09: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09',
  pain008_08: 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.08',
} as const;

export type SeqType = 'FRST' | 'RCUR' | 'OOFF' | 'FNAL';
export type Scheme = 'CORE' | 'B2B';

export const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const eur = (cents: number) => (Math.round(cents) / 100).toFixed(2);

/** SEPA allows a small Latin character set: umlauts spelled out, the rest replaced. */
export function sepaText(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9/?:().,'+ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Identifiers (MsgId, PmtInfId, EndToEndId, mandate reference): the SEPA set without spaces, no leading "/" and no "//".
 * Anything else becomes "-"; an empty result is NOTPROVIDED (what the rulebook wants for a missing EndToEndId).
 */
export function sepaId(s: unknown, max = 35): string {
  const t = sepaText(s, 200)
    .replace(/ /g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .slice(0, max);
  return t || 'NOTPROVIDED';
}

const stamp = (at?: Date) => (at ?? new Date()).toISOString().slice(0, 19);
const agent = (bic: string | undefined, tag: 'BIC' | 'BICFI') =>
  bic ? `<FinInstnId><${tag}>${xmlEsc(bic.replace(/\s+/g, '').toUpperCase())}</${tag}></FinInstnId>` : '<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>';
const iban = (v: string) => xmlEsc(String(v ?? '').replace(/\s+/g, '').toUpperCase());

export interface Account {
  name: string;
  iban: string;
  bic?: string;
  /** Structured address (pain.008 debtor, mandatory outside the EEA): written when town and country are known. */
  street?: string;
  postal_code?: string;
  city?: string;
  country?: string;
}

const address = (a: Account): string =>
  a.city && a.country
    ? `<PstlAdr>${a.street ? `<StrtNm>${xmlEsc(sepaText(a.street, 70))}</StrtNm>` : ''}${a.postal_code ? `<PstCd>${xmlEsc(sepaText(a.postal_code, 16))}</PstCd>` : ''}<TwnNm>${xmlEsc(sepaText(a.city, 35))}</TwnNm><Ctry>${xmlEsc(a.country.toUpperCase().slice(0, 2))}</Ctry></PstlAdr>`
    : '';

// --- credit transfer (pain.001) ------------------------------------------------------------------------------------------

export interface TransferLine {
  /** EndToEndId – travels to the payee's statement (e.g. the supplier's invoice number). */
  endToEndId: string;
  name: string;
  iban: string;
  bic?: string;
  amount_cents: number;
  remittance: string;
}

export interface TransferFile {
  /** '001.001.09' (default, current DK version) or '001.001.03' (legacy). */
  version?: '001.001.09' | '001.001.03';
  debtor: Account;
  msgId: string;
  /** YYYY-MM-DD */
  executionDate: string;
  lines: TransferLine[];
  batchBooking?: boolean;
  at?: Date;
}

/** One payment block from the sender's own account to every line (lines without an amount are skipped). */
export function creditTransferXml(o: TransferFile): string {
  const v09 = (o.version ?? '001.001.09') === '001.001.09';
  const tag = v09 ? 'BICFI' : 'BIC';
  const tx = o.lines.filter((l) => l.amount_cents > 0);
  const sum = eur(tx.reduce((n, l) => n + Math.round(l.amount_cents), 0));
  const name = sepaText(o.debtor.name, 70) || 'Auftraggeber';
  const msgId = sepaId(o.msgId);
  const date = v09 ? `<ReqdExctnDt><Dt>${xmlEsc(o.executionDate)}</Dt></ReqdExctnDt>` : `<ReqdExctnDt>${xmlEsc(o.executionDate)}</ReqdExctnDt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${v09 ? NS.pain001_09 : NS.pain001_03}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrCdtTrfInitn>
<GrpHdr><MsgId>${xmlEsc(msgId)}</MsgId><CreDtTm>${stamp(o.at)}</CreDtTm><NbOfTxs>${tx.length}</NbOfTxs><CtrlSum>${sum}</CtrlSum><InitgPty><Nm>${xmlEsc(name)}</Nm></InitgPty></GrpHdr>
<PmtInf><PmtInfId>${xmlEsc(msgId)}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>${o.batchBooking === false ? 'false' : 'true'}</BtchBookg><NbOfTxs>${tx.length}</NbOfTxs><CtrlSum>${sum}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>${date}
<Dbtr><Nm>${xmlEsc(name)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${iban(o.debtor.iban)}</IBAN></Id></DbtrAcct><DbtrAgt>${agent(o.debtor.bic, tag)}</DbtrAgt><ChrgBr>SLEV</ChrgBr>
${tx
  .map(
    (l) =>
      `<CdtTrfTxInf><PmtId><EndToEndId>${xmlEsc(sepaId(l.endToEndId))}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${eur(l.amount_cents)}</InstdAmt></Amt>${l.bic ? `<CdtrAgt>${agent(l.bic, tag)}</CdtrAgt>` : ''}<Cdtr><Nm>${xmlEsc(sepaText(l.name, 70) || 'Empfaenger')}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban(l.iban)}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>${xmlEsc(sepaText(l.remittance, 140))}</Ustrd></RmtInf></CdtTrfTxInf>`,
  )
  .join('\n')}
</PmtInf>
</CstmrCdtTrfInitn>
</Document>
`;
}

// --- direct debit (pain.008.001.08) -------------------------------------------------------------------------------------

export interface DebitTx {
  /** EndToEndId – the invoice number. */
  endToEndId: string;
  amount_cents: number;
  mandateId: string;
  /** YYYY-MM-DD the mandate was signed. */
  mandateDate: string;
  seq: SeqType;
  scheme: Scheme;
  /** YYYY-MM-DD (ReqdColltnDt). */
  collectionDate: string;
  debtor: Account;
  remittance: string;
}

export interface DebitGroup {
  key: string;
  seq: SeqType;
  scheme: Scheme;
  collectionDate: string;
  txs: DebitTx[];
  sum_cents: number;
}

const SEQ_ORDER: SeqType[] = ['FRST', 'RCUR', 'OOFF', 'FNAL'];

/** One payment block per scheme, sequence type and collection date (the bank books each block on its own). */
export function groupDebits(txs: DebitTx[]): DebitGroup[] {
  const map = new Map<string, DebitGroup>();
  for (const t of txs) {
    const key = `${t.scheme}|${t.seq}|${t.collectionDate}`;
    const g = map.get(key) ?? { key, seq: t.seq, scheme: t.scheme, collectionDate: t.collectionDate, txs: [], sum_cents: 0 };
    g.txs.push(t);
    g.sum_cents += Math.round(t.amount_cents);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.collectionDate.localeCompare(b.collectionDate) || a.scheme.localeCompare(b.scheme) || SEQ_ORDER.indexOf(a.seq) - SEQ_ORDER.indexOf(b.seq));
}

export interface DebitFile {
  creditor: Account & { creditorId: string };
  msgId: string;
  txs: DebitTx[];
  batchBooking?: boolean;
  at?: Date;
}

export function directDebitXml(o: DebitFile): { xml: string; groups: DebitGroup[]; total_cents: number; count: number } {
  const txs = o.txs.filter((t) => t.amount_cents > 0);
  const groups = groupDebits(txs);
  const total = groups.reduce((n, g) => n + g.sum_cents, 0);
  const name = sepaText(o.creditor.name, 70) || 'Glaeubiger';
  const msgId = sepaId(o.msgId, 30);
  const blocks = groups.map((g, i) => {
    const head = `<PmtInf><PmtInfId>${xmlEsc(sepaId(`${msgId}-${i + 1}`))}</PmtInfId><PmtMtd>DD</PmtMtd><BtchBookg>${o.batchBooking ? 'true' : 'false'}</BtchBookg><NbOfTxs>${g.txs.length}</NbOfTxs><CtrlSum>${eur(g.sum_cents)}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>${g.scheme}</Cd></LclInstrm><SeqTp>${g.seq}</SeqTp></PmtTpInf><ReqdColltnDt>${xmlEsc(g.collectionDate)}</ReqdColltnDt>
<Cdtr><Nm>${xmlEsc(name)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban(o.creditor.iban)}</IBAN></Id></CdtrAcct><CdtrAgt>${agent(o.creditor.bic, 'BICFI')}</CdtrAgt><ChrgBr>SLEV</ChrgBr>
<CdtrSchmeId><Id><PrvtId><Othr><Id>${xmlEsc(o.creditor.creditorId.replace(/\s+/g, '').toUpperCase())}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>`;
    const rows = g.txs.map(
      (t) =>
        `<DrctDbtTxInf><PmtId><EndToEndId>${xmlEsc(sepaId(t.endToEndId))}</EndToEndId></PmtId><InstdAmt Ccy="EUR">${eur(t.amount_cents)}</InstdAmt><DrctDbtTx><MndtRltdInf><MndtId>${xmlEsc(sepaId(t.mandateId))}</MndtId><DtOfSgntr>${xmlEsc(t.mandateDate)}</DtOfSgntr></MndtRltdInf></DrctDbtTx><DbtrAgt>${agent(t.debtor.bic, 'BICFI')}</DbtrAgt><Dbtr><Nm>${xmlEsc(sepaText(t.debtor.name, 70) || 'Zahler')}</Nm>${address(t.debtor)}</Dbtr><DbtrAcct><Id><IBAN>${iban(t.debtor.iban)}</IBAN></Id></DbtrAcct><RmtInf><Ustrd>${xmlEsc(sepaText(t.remittance, 140))}</Ustrd></RmtInf></DrctDbtTxInf>`,
    );
    return `${head}\n${rows.join('\n')}\n</PmtInf>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${NS.pain008_08}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrDrctDbtInitn>
<GrpHdr><MsgId>${xmlEsc(msgId)}</MsgId><CreDtTm>${stamp(o.at)}</CreDtTm><NbOfTxs>${txs.length}</NbOfTxs><CtrlSum>${eur(total)}</CtrlSum><InitgPty><Nm>${xmlEsc(name)}</Nm></InitgPty></GrpHdr>
${blocks.join('\n')}
</CstmrDrctDbtInitn>
</Document>
`;
  return { xml, groups, total_cents: total, count: txs.length };
}
