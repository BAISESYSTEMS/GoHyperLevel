/** RFC 4180-ish CSV parsing/writing (quotes, escaped quotes, newlines in quotes, ; or , delimiter). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/**
 * Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR at the start – e.g. a contact named
 * `=HYPERLINK(…)` from a public form) gets a leading apostrophe; plain numbers stay as they are.
 */
export function csvSafe(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(?:[.,]\d+)?$/.test(s) ? `'${s}` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = csvSafe(v);
          return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

/** Maps a CSV header to a contact field (accepts GHL export, German and English names). */
export function guessContactField(header: string): string | undefined {
  const h = header.toLowerCase().replace(/[\s_-]+/g, '');
  const map: Record<string, string> = {
    firstname: 'first_name', vorname: 'first_name',
    lastname: 'last_name', nachname: 'last_name', name: 'name', fullname: 'name', contactname: 'name',
    email: 'email', emailaddress: 'email', mail: 'email', 'e-mail': 'email',
    phone: 'phone', telefon: 'phone', phonenumber: 'phone', mobile: 'phone', handy: 'phone', mobil: 'phone',
    company: 'company', companyname: 'company', firma: 'company', businessname: 'company', unternehmen: 'company',
    address: 'address', address1: 'address', adresse: 'address', strasse: 'address', straße: 'address',
    city: 'city', stadt: 'city', ort: 'city',
    postalcode: 'postal_code', zip: 'postal_code', plz: 'postal_code', postleitzahl: 'postal_code',
    country: 'country', land: 'country',
    website: 'website', webseite: 'website',
    source: 'source', quelle: 'source',
    tags: 'tags',
    dateofbirth: 'date_of_birth', geburtstag: 'date_of_birth',
    // Export headers of other tools (Mailchimp, ActiveCampaign, Kit, Keap, Pipedrive, Kajabi, Teachable): see docs/umzug.md.
    emailadresse: 'email', email1: 'email', personemail: 'email', personname: 'name', personphone: 'phone', phone1: 'phone', mobilephone: 'phone', telefonnummer: 'phone',
    organization: 'company', organisation: 'company', organizationname: 'company', personorganization: 'company',
    streetaddress: 'address', streetaddress1: 'address', addressline1: 'address', postcode: 'postal_code', zipcode: 'postal_code',
    birthday: 'date_of_birth', birthdate: 'date_of_birth', geburtsdatum: 'date_of_birth',
    tag: 'tags', labels: 'tags', personlabel: 'tags',
  };
  return map[h];
}
